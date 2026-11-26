import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPii,
  redact,
  assertRedacted,
  PiiLeakError,
  pseudonymize,
  type PiiClass,
} from './privacy';

function classesOf(text: string): PiiClass[] {
  return redact(text).classes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct identifiers
// ─────────────────────────────────────────────────────────────────────────────

test('detects and redacts an email address', () => {
  const r = redact('Email the report to jane.doe@example.com every Friday');
  assert.ok(r.classes.includes('email'));
  assert.ok(!r.redacted.includes('jane.doe@example.com'));
  assert.match(r.redacted, /\[\[EMAIL_1\]\]/);
});

test('detects a phone number but not a time or a percentage threshold', () => {
  assert.ok(classesOf('Call me on +1 415 555 0132').includes('phone'));
  // 9:30 and 20% are 3- and 2-digit runs — below the 7-digit floor.
  assert.ok(!classesOf('At 9:30 remind me if battery is below 20%').includes('phone'));
});

test('applies Luhn so only real card numbers are classed as payment cards', () => {
  // 4111 1111 1111 1111 is the canonical Luhn-valid test number.
  assert.ok(classesOf('Pay with 4111 1111 1111 1111').includes('payment-card'));
  // One digit changed — fails Luhn, must not be reported as a card.
  assert.ok(!classesOf('Order number 4111 1111 1111 1112').includes('payment-card'));
});

test('detects coordinates and IPv4 addresses', () => {
  assert.ok(classesOf('Go to 37.774929, -122.419416').includes('coordinates'));
  assert.ok(classesOf('Ping 192.168.1.44 when I get home').includes('ip-address'));
  // 999 is not a valid octet.
  assert.ok(!classesOf('version 999.1.1.1').includes('ip-address'));
});

test('detects a street address', () => {
  assert.ok(classesOf('Navigate to 221 Baker Street').includes('street-address'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Secrets — must poison the record, not merely be masked
// ─────────────────────────────────────────────────────────────────────────────

test('flags containsSecret for API keys, tokens, and credentialed URLs', () => {
  const cases = [
    'use sk-abcdefghijklmnopqrstuvwxyz123456',
    'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    'aws key AKIAIOSFODNN7EXAMPLE',
    'auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
    'password: hunter2seventy',
    'call https://api.example.com/v1?api_key=abcd1234efgh5678',
    'fetch https://user:s3cretpw@internal.example.com/data',
  ];
  for (const c of cases) {
    assert.equal(redact(c).containsSecret, true, `should flag secret in: ${c.slice(0, 30)}`);
  }
});

test('a JWT is one finding, not three hex fragments', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
  const findings = detectPii(`token ${jwt}`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.class, 'secret');
});

test('ordinary descriptions are not flagged as containing secrets', () => {
  const r = redact('When I get home turn on the living room lights and set them warm');
  assert.equal(r.containsSecret, false);
  assert.equal(r.clean, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Person names — precision matters in both directions
// ─────────────────────────────────────────────────────────────────────────────

test('redacts a full name', () => {
  const r = redact('Send a message to Jane Doe saying I am late');
  assert.ok(r.classes.includes('person-name'));
  assert.ok(!r.redacted.includes('Jane'));
  assert.ok(!r.redacted.includes('Doe'));
});

test('does not treat app names or capitalised domain nouns as people', () => {
  for (const text of [
    'Open Spotify and play my workout playlist',
    'Turn on WiFi and Bluetooth',
    'Get Current Weather for my location',
    'Open App Store',
    'Set Focus mode to Do Not Disturb',
  ]) {
    assert.ok(
      !classesOf(text).includes('person-name'),
      `false positive person-name in: ${text}`,
    );
  }
});

test('the same name maps to the same placeholder within one text', () => {
  const r = redact('Message Ann and then tell Ann I am on my way');
  const matches = r.redacted.match(/\[\[PERSON_1\]\]/g) ?? [];
  assert.equal(matches.length, 2, `expected two PERSON_1 tokens, got: ${r.redacted}`);
  assert.ok(!r.redacted.includes('PERSON_2'));
});

test('detects relationship references as personal context', () => {
  const r = redact('Send a message to my wife when I leave work');
  assert.ok(r.classes.includes('personal-relation'));
  assert.ok(!r.redacted.includes('my wife'));
});

test('handles non-ASCII names without truncating them', () => {
  const r = redact('Send a message to José saying hello');
  assert.ok(r.classes.includes('person-name'));
  // The bug this guards: an ASCII-only class kept "Jos" and redacted only "é",
  // leaving a recognisable fragment behind.
  assert.ok(!r.redacted.includes('Jos'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Structural guarantees
// ─────────────────────────────────────────────────────────────────────────────

test('findings never carry the matched value', () => {
  const findings = detectPii('mail bob@example.com and call +1 415 555 0132');
  assert.ok(findings.length > 0);
  for (const f of findings) {
    assert.deepEqual(
      Object.keys(f).sort(),
      ['class', 'confidence', 'end', 'length', 'start'],
      'a finding gained a field — verify it cannot carry raw text',
    );
  }
  // Belt and braces: the serialised findings must not contain the source text.
  const serialised = JSON.stringify(findings);
  assert.ok(!serialised.includes('bob@example.com'));
});

test('findings never overlap and are position-ordered', () => {
  const findings = detectPii(
    'Email jane.doe@example.com, call +1 415 555 0132, card 4111 1111 1111 1111',
  );
  for (let i = 1; i < findings.length; i++) {
    assert.ok(
      findings[i]!.start >= findings[i - 1]!.end,
      'findings must be non-overlapping and sorted',
    );
  }
});

test('assertRedacted throws on raw PII and passes on redacted output', () => {
  assert.throws(() => assertRedacted('write to jane.doe@example.com'), PiiLeakError);
  const r = redact('write to jane.doe@example.com');
  assert.doesNotThrow(() => assertRedacted(r.redacted));
});

test('redaction is idempotent — running it twice changes nothing', () => {
  const once = redact('Send a message to Jane Doe at jane@example.com').redacted;
  const twice = redact(once).redacted;
  assert.equal(once, twice);
});

test('pseudonyms are stable within a process and differ per subject', () => {
  assert.equal(pseudonymize('user-1'), pseudonymize('user-1'));
  assert.notEqual(pseudonymize('user-1'), pseudonymize('user-2'));
  assert.ok(!pseudonymize('user-1').includes('user-1'));
});

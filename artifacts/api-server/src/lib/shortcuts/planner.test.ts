import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlan,
  detectIntents,
  buildClarificationRequest,
  extractRecipient,
} from './planner';

// ─────────────────────────────────────────────────────────────────────────────
// Intent detection — no phantom intents from substring matches
//
// The regexes used to match without word boundaries, so "if" inside
// "notification" / "wifi" / "verify" / "Spotify" fabricated a conditional
// intent, "app" inside "happen" fabricated an app launch, and "call" inside
// "recall" / "locally" fabricated a phone call. Each tripwire word below
// contains a stem as a substring but must NOT trigger that intent.
// ─────────────────────────────────────────────────────────────────────────────

const tripwires: Array<{ description: string; forbidden: string }> = [
  { description: 'Send a notification saying hello', forbidden: 'conditional' },
  { description: 'Turn on wifi', forbidden: 'conditional' },
  { description: 'Verify my identity', forbidden: 'conditional' },
  { description: 'Open Spotify', forbidden: 'conditional' },
  { description: 'Text my wife that I am on my way', forbidden: 'conditional' },
  { description: 'Tell me what will happen tomorrow', forbidden: 'open-app' },
  { description: 'Apply the filter', forbidden: 'open-app' },
  { description: 'Recall the last thing I copied', forbidden: 'call' },
  { description: 'Save it locally', forbidden: 'call' },
];

for (const { description, forbidden } of tripwires) {
  test(`detectIntents does not infer "${forbidden}" from "${description}"`, () => {
    const intents = detectIntents(description);
    assert.equal(
      intents.includes(forbidden),
      false,
      `"${description}" must not produce a ${forbidden} intent (got: ${intents.join(', ') || 'none'})`,
    );
  });
}

test('detectIntents still finds conditionals that were genuinely described', () => {
  assert.ok(detectIntents('if my battery is low, turn on low power mode').includes('conditional'));
  assert.ok(detectIntents('when I get home, turn on the lights').includes('conditional'));
  assert.ok(detectIntents('unless it is raining, remind me to walk').includes('conditional'));
  assert.ok(detectIntents('only run this if headphones are connected').includes('conditional'));
});

test('detectIntents still finds the intents it is supposed to find', () => {
  assert.ok(detectIntents('Send a notification saying hello').includes('notification'));
  assert.ok(detectIntents('text my wife').includes('message'));
  assert.ok(detectIntents('email my boss').includes('email'));
  assert.ok(detectIntents('call my mom').includes('call'));
  assert.ok(detectIntents('make a phone call to the office').includes('call'));
  assert.ok(detectIntents('open Spotify').includes('open-app'));
  assert.ok(detectIntents('take a photo').includes('photo'));
  assert.ok(detectIntents("show today's weather").includes('weather'));
  assert.ok(detectIntents('show my reminders').includes('calendar'));
  assert.ok(detectIntents('get my location').includes('location'));
});

test('detectIntents treats a schedule as a trigger, not a loop', () => {
  // "Every morning at 7 am ..." is the app's own example description. It used to
  // produce a repeat intent, and then a loop with an invented count of 3.
  const intents = detectIntents(
    'Every morning at 7 am, show my first calendar event and the weather',
  );
  assert.equal(intents.includes('repeat'), false);
  assert.ok(intents.includes('calendar'));
  assert.ok(intents.includes('weather'));
});

test('detectIntents still finds loops over collections', () => {
  assert.ok(detectIntents('repeat this 5 times').includes('repeat'));
  assert.ok(detectIntents('for each photo, add a filter').includes('repeat'));
  assert.ok(detectIntents('loop through my contacts').includes('repeat'));
});

test('detectIntents does not treat a phone as a call request', () => {
  // "if phone battery is below 20%" must not append a Call action.
  assert.equal(detectIntents('if my phone battery is below 20%').includes('call'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// buildPlan — supplied values are used, missing values are never invented
// ─────────────────────────────────────────────────────────────────────────────

test('buildPlan uses provided slots to bind message parameters', () => {
  const plan = buildPlan(
    'send a message to my wife',
    { recipient: 'Jane Doe', messageBody: 'Running late' },
  );

  const messageStep = plan.steps.find(
    (s) => s.actionIdentifier === 'is.workflow.actions.sendmessage',
  );
  assert.ok(messageStep, 'Expected a Send Message step');

  const recipientBinding = messageStep.parameterBindings.find(
    (b) => b.key === 'WFSendMessageActionRecipients',
  );
  const bodyBinding = messageStep.parameterBindings.find(
    (b) => b.key === 'WFSendMessageActionBody',
  );

  assert.deepEqual(recipientBinding?.value, ['Jane Doe']);
  assert.equal(recipientBinding?.source, 'slot');
  assert.equal(recipientBinding?.sourceKey, 'recipient');
  assert.equal(bodyBinding?.value, 'Running late');
  assert.equal(bodyBinding?.source, 'slot');
  assert.equal(bodyBinding?.sourceKey, 'messageBody');

  // No required slots should remain when they are filled.
  assert.equal(plan.requiredSlots.some((s) => s.key === 'recipient'), false);
  assert.equal(plan.requiredSlots.some((s) => s.key === 'messageBody'), false);
});

test('buildPlan leaves unsupplied message details unset instead of inventing them', () => {
  const plan = buildPlan('send a message');

  const messageStep = plan.steps.find(
    (s) => s.actionIdentifier === 'is.workflow.actions.sendmessage',
  );
  assert.ok(messageStep, 'Expected a Send Message step');

  const recipientBinding = messageStep.parameterBindings.find(
    (b) => b.key === 'WFSendMessageActionRecipients',
  );
  const bodyBinding = messageStep.parameterBindings.find(
    (b) => b.key === 'WFSendMessageActionBody',
  );

  // These used to be the literals ['Contact'] and 'Message' — a shortcut that
  // messages someone actually named "Contact" is not what the user described.
  assert.equal(recipientBinding?.value, null);
  assert.equal(recipientBinding?.source, 'unset');
  assert.equal(bodyBinding?.value, null);
  assert.equal(bodyBinding?.source, 'unset');

  assert.ok(plan.requiredSlots.some((s) => s.key === 'recipient'));
  assert.ok(plan.requiredSlots.some((s) => s.key === 'messageBody'));
});

test('buildPlan uses target app slot for Open App action', () => {
  const plan = buildPlan('open Spotify', { targetApp: 'com.spotify.client' });

  const openAppStep = plan.steps.find(
    (s) => s.actionIdentifier === 'is.workflow.actions.openapp',
  );
  assert.ok(openAppStep, 'Expected an Open App step');

  const appBinding = openAppStep.parameterBindings.find((b) => b.key === 'WFAppIdentifier');
  assert.equal(appBinding?.value, 'com.spotify.client');
  assert.equal(appBinding?.source, 'slot');
  assert.equal(appBinding?.sourceKey, 'targetApp');
});

test('buildPlan uses condition slot for conditional block', () => {
  const plan = buildPlan('only run if WiFi is connected', {
    condition: 'WiFi connected',
  });

  const ifStep = plan.steps.find(
    (s) => s.actionIdentifier === 'is.workflow.actions.conditional',
  );
  assert.ok(ifStep, 'Expected an If step');

  const conditionBinding = ifStep.parameterBindings.find((b) => b.key === 'WFCondition');
  assert.equal(conditionBinding?.value, 'WiFi connected');
  assert.equal(conditionBinding?.source, 'slot');
  assert.equal(conditionBinding?.sourceKey, 'condition');
});

test('buildPlan never invents a battery condition', () => {
  // The regression this task exists for: an unanswered condition used to be
  // filled with the literal "battery below 20%".
  const plan = buildPlan('only run this if the right thing is true');

  const ifStep = plan.steps.find(
    (s) => s.actionIdentifier === 'is.workflow.actions.conditional',
  );
  assert.ok(ifStep, 'Expected an If step');

  const conditionBinding = ifStep.parameterBindings.find((b) => b.key === 'WFCondition');
  assert.equal(conditionBinding?.value, null);
  assert.equal(conditionBinding?.source, 'unset');

  assert.equal(
    JSON.stringify(plan).toLowerCase().includes('battery'),
    false,
    'No part of the plan may mention battery unless the user did',
  );

  assert.ok(plan.requiredSlots.some((s) => s.key === 'condition'));
  assert.ok(
    plan.uncertainty.some((u) => u.toLowerCase().includes('condition')),
    'The unresolved condition must be reported in uncertainty',
  );
});

test('buildPlan never invents a repeat count', () => {
  const plan = buildPlan('repeat this');

  const repeatStep = plan.steps.find(
    (s) => s.actionIdentifier === 'is.workflow.actions.repeat.count',
  );
  assert.ok(repeatStep, 'Expected a Repeat step');

  const countBinding = repeatStep.parameterBindings.find((b) => b.key === 'WFRepeatCount');
  assert.equal(countBinding?.value, null, 'Repeat count used to default to 3');
  assert.equal(countBinding?.source, 'unset');
  assert.ok(plan.requiredSlots.some((s) => s.key === 'repeatCount'));
});

test('buildPlan uses the notification text the user described', () => {
  const plan = buildPlan('Send a notification saying hello');

  const notifyStep = plan.steps.find(
    (s) => s.actionIdentifier === 'is.workflow.actions.notification',
  );
  assert.ok(notifyStep, 'Expected a Show Notification step');

  const titleBinding = notifyStep.parameterBindings.find(
    (b) => b.key === 'WFNotificationActionTitle',
  );
  assert.equal(titleBinding?.value, 'hello');

  // And the whole point of the task: no If block anywhere.
  assert.equal(
    plan.steps.some((s) => s.actionIdentifier === 'is.workflow.actions.conditional'),
    false,
    'A plain notification must not contain a conditional',
  );
  assert.equal(plan.requiredSlots.length, 0, 'Nothing should be left unresolved');
});

// ─────────────────────────────────────────────────────────────────────────────
// Recipient resolution — clarify and the plan must agree
//
// buildClarificationRequest used to exempt "my wife" and any "to <word>" from
// the recipient question, while buildPlan could not resolve those into a contact
// and still listed recipient as required. The user was therefore never asked for
// a recipient the plan needed, and the generated shortcut addressed a contact
// literally named "wife".
// ─────────────────────────────────────────────────────────────────────────────

test('extractRecipient refuses relationship references that are not contacts', () => {
  assert.equal(extractRecipient('Send a message to my wife'), undefined);
  assert.equal(extractRecipient('text my husband'), undefined);
  assert.equal(extractRecipient('message my boss when I arrive'), undefined);
  assert.equal(extractRecipient('email my team'), undefined);
  assert.equal(extractRecipient('send a message'), undefined);
});

test('extractRecipient picks up an actual name or address', () => {
  assert.equal(extractRecipient('Send a message to Jane'), 'Jane');
  assert.equal(extractRecipient('Send a message to Jane Doe'), 'Jane Doe');
  assert.equal(extractRecipient('Text Bob that I am late'), 'Bob');
  assert.equal(extractRecipient('email jane@example.com the report'), 'jane@example.com');
  assert.equal(extractRecipient('message "Jane Doe" about dinner'), 'Jane Doe');
});

test('extractRecipient keeps non-ASCII names whole', () => {
  // An ASCII-only character class truncated these, which would address a
  // contact who does not exist rather than asking.
  assert.equal(extractRecipient('Text José that I am late'), 'José');
  assert.equal(extractRecipient('message Zoë about dinner'), 'Zoë');
  assert.equal(extractRecipient('Send a message to Łukasz'), 'Łukasz');
  assert.equal(extractRecipient('text Ana María saying hello'), 'Ana María');
});

test('clarify asks for a recipient exactly when the plan cannot resolve one', () => {
  const descriptions = [
    'Send a message to my wife',
    'Send a message to Jane',
    'text my husband that I am late',
    'send a message',
    'Text Bob saying hello',
  ];

  for (const description of descriptions) {
    const plan = buildPlan(description);
    const request = buildClarificationRequest(description);

    const planNeedsRecipient = plan.requiredSlots.some((s) => s.key === 'recipient');
    const clarifyAsksRecipient = request.questions.some((q) => q.slotKey === 'recipient');

    assert.equal(
      clarifyAsksRecipient,
      planNeedsRecipient,
      `"${description}": clarify asks=${clarifyAsksRecipient} but plan needs=${planNeedsRecipient}`,
    );
  }
});

test('a named recipient in the description is used without asking', () => {
  const plan = buildPlan('Send a message to Jane Doe saying I am late');
  const step = plan.steps.find((s) => s.actionIdentifier === 'is.workflow.actions.sendmessage');
  const recipient = step?.parameterBindings.find(
    (b) => b.key === 'WFSendMessageActionRecipients',
  );
  assert.deepEqual(recipient?.value, ['Jane Doe']);
  assert.equal(plan.requiredSlots.length, 0);
});

test('a relationship reference never becomes the contact name', () => {
  const plan = buildPlan('Send a message to my wife');
  const step = plan.steps.find((s) => s.actionIdentifier === 'is.workflow.actions.sendmessage');
  const recipient = step?.parameterBindings.find(
    (b) => b.key === 'WFSendMessageActionRecipients',
  );
  // Must not be ['wife'] — that addresses a contact named "wife".
  assert.equal(recipient?.value, null);
  assert.equal(recipient?.source, 'unset');
  assert.ok(plan.requiredSlots.some((s) => s.key === 'recipient'));
  assert.ok(buildClarificationRequest('Send a message to my wife').questions.some(
    (q) => q.slotKey === 'recipient',
  ));
});

test('every action identifier the planner hardcodes exists in the catalog', () => {
  // Three identifiers were wrong (getcurrentlocation, getclipboard,
  // shownotification). addStep silently skipped them, so describing a
  // notification, a location lookup, or a clipboard read produced a plan with
  // no step for it at all — the request vanished without any error.
  const descriptions = [
    "show today's weather",
    'get my location',
    'take a photo',
    'show my calendar events',
    'read my clipboard',
    'show my device details',
    'text my wife',
    'email my boss',
    'send a notification saying hello',
    'open Spotify',
    'only run if headphones are connected',
    'repeat this 3 times',
  ];

  for (const description of descriptions) {
    const plan = buildPlan(description);
    const missing = plan.uncertainty.filter((u) => u.includes('No catalog action is available'));
    assert.deepEqual(
      missing,
      [],
      `"${description}" references an action identifier that is not in the catalog: ${missing.join('; ')}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Clarification questions
// ─────────────────────────────────────────────────────────────────────────────

test('buildClarificationRequest does not ask about conditions that were never described', () => {
  const request = buildClarificationRequest('Send a notification saying hello');
  assert.equal(
    request.questions.some((q) => q.slotKey === 'condition'),
    false,
    'A plain notification must not trigger a condition question',
  );
});

test('buildClarificationRequest asks about a genuinely vague condition', () => {
  const request = buildClarificationRequest('do the thing only if it makes sense');
  const condition = request.questions.find((q) => q.slotKey === 'condition');
  assert.ok(condition, 'Expected a condition question');
  assert.notEqual(
    condition.enumeration?.[0],
    'battery below 20%',
    'battery must not lead the suggestion list',
  );
});

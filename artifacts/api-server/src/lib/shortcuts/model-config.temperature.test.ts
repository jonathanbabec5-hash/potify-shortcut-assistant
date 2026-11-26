/**
 * Unit tests for temperature support detection (no network calls).
 *
 * The gpt-5 / o-series reasoning models reject any explicit `temperature` and
 * return `400 unsupported_value`. The pipeline sends a temperature on every
 * stage, so a single unsupported model turned every generate request into a 500
 * before the first stage could run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL_CONFIG, supportsTemperature, temperatureParams } from "./model-config";

test("supportsTemperature rejects models that only accept their default", () => {
  assert.equal(supportsTemperature("gpt-5.6-terra"), false);
  assert.equal(supportsTemperature("gpt-5"), false);
  assert.equal(supportsTemperature("openai/gpt-5-mini"), false);
  assert.equal(supportsTemperature("o1-preview"), false);
  assert.equal(supportsTemperature("o3-mini"), false);
});

test("supportsTemperature allows models that accept one", () => {
  assert.equal(supportsTemperature("deepseek/deepseek-chat"), true);
  assert.equal(supportsTemperature("gpt-4o"), true);
  assert.equal(supportsTemperature("meta-llama/llama-3.3-70b-instruct"), true);
});

test("temperatureParams omits temperature entirely for unsupported models", () => {
  assert.deepEqual(temperatureParams("gpt-5.6-terra"), {});
  assert.deepEqual(temperatureParams("gpt-5.6-terra", 0), {});
  // The key must be absent, not undefined — the SDK serialises an explicit
  // undefined into the request body on some versions.
  assert.equal("temperature" in temperatureParams("gpt-5.6-terra", 0), false);
});

test("temperatureParams passes the requested temperature through when supported", () => {
  assert.deepEqual(temperatureParams("deepseek/deepseek-chat", 0), { temperature: 0 });
  assert.deepEqual(temperatureParams("deepseek/deepseek-chat"), {
    temperature: MODEL_CONFIG.temperature,
  });
});

test("the currently configured model is consistent with what we send it", () => {
  // Guards against configuring a model whose temperature support contradicts the
  // value the pipeline would send.
  const params = temperatureParams(MODEL_CONFIG.model, 0);
  if (supportsTemperature(MODEL_CONFIG.model)) {
    assert.deepEqual(params, { temperature: 0 });
  } else {
    assert.deepEqual(params, {});
  }
});

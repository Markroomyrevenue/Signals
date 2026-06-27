import assert from "node:assert/strict";
import test from "node:test";

import { maskSecret, redactSecrets, safeErrorMessage } from "./secrets";

const FAKE_KEY = "pl_live_8f3a2b91c7d64e05a1f2"; // not a real key

test("maskSecret never reveals any character of the secret", () => {
  const masked = maskSecret(FAKE_KEY);
  assert.equal(masked, `(set: ${FAKE_KEY.length} chars)`);
  // No 4+ char run of the key survives in the masked output.
  for (let i = 0; i + 4 <= FAKE_KEY.length; i += 1) {
    assert.ok(!masked.includes(FAKE_KEY.slice(i, i + 4)), "masked output leaked a key substring");
  }
});

test("maskSecret reports unset/empty as (unset)", () => {
  assert.equal(maskSecret(undefined), "(unset)");
  assert.equal(maskSecret(null), "(unset)");
  assert.equal(maskSecret(""), "(unset)");
  assert.equal(maskSecret("   "), "(unset)");
});

test("redactSecrets scrubs every occurrence of a key from text", () => {
  const text = `GET https://api.pricelabs.co/v1/listings failed (key ${FAKE_KEY}) and ${FAKE_KEY} again`;
  const out = redactSecrets(text, [FAKE_KEY]);
  assert.ok(!out.includes(FAKE_KEY));
  assert.equal(out.match(/\*\*\*REDACTED\*\*\*/g)?.length, 2);
});

test("redactSecrets ignores empty/short secrets so ordinary text is untouched", () => {
  const text = "nothing secret here";
  assert.equal(redactSecrets(text, [null, undefined, "abc"]), text);
});

test("safeErrorMessage redacts the key from a thrown error", () => {
  const err = new Error(`401 Unauthorized for header X-API-Key: ${FAKE_KEY}`);
  const out = safeErrorMessage(err, [FAKE_KEY]);
  assert.ok(!out.includes(FAKE_KEY));
  assert.ok(out.includes("***REDACTED***"));
});

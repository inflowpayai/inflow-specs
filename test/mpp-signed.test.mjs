import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mppCases, mppCasesWithSellerChallenges } from "../fixtures/mpp.mjs";
import { validate } from "../runner/validation.mjs";

const expiry = "2099-01-01T00:00:00Z";
const sign = (challenge) => ({ id: `signed-${challenge.id}`, expires: expiry });
const decode = (value) => JSON.parse(Buffer.from(value, "base64url").toString());

test("the original corpus is unchanged and signed setup only changes Seller acceptance cases", () => {
  const original = structuredClone(mppCases);
  assert.equal(
    createHash("sha256").update(JSON.stringify(original)).digest("hex"),
    "70ed1e5b4482e6bcbe4cd92d5622f23f3b36f9b2771983f81dd6053267aea747",
  );
  const calls = [];
  const index = mppCasesWithSellerChallenges((challenge) => {
    calls.push(structuredClone(challenge));
    const result = sign(challenge);
    challenge.request = "caller mutation";
    return result;
  });
  assert.deepEqual(
    calls.map((item) => item.id),
    ["test-balance", "test-instrument", "test-tempo"],
  );
  validate("case-index", index);
  assert.deepEqual(mppCases, original);
  let changed = 0;
  for (const [position, item] of index.cases.entries()) {
    const before = original.cases[position];
    if (item.suite !== "mpp-seller" || !item.input.credential || item.feature) {
      assert.deepEqual(item, before);
      continue;
    }
    changed++;
    const expected = {
      ...before.input.credential.challenge,
      ...sign(before.input.credential.challenge),
    };
    assert.deepEqual(item.input.credential.challenge, expected);
    assert.deepEqual(item.input.credential.payload, before.input.credential.payload);
    assert.equal(item.input.credential.source, before.input.credential.source);
    assert.equal(item.platform.exchanges.length, before.platform.exchanges.length);
    for (const [offset, exchange] of item.platform.exchanges.entries()) {
      const old = before.platform.exchanges[offset];
      assert.equal(exchange.request.method, old.request.method);
      assert.equal(exchange.request.path, old.request.path);
      assert.deepEqual(exchange.request.headers, old.request.headers);
      if (exchange.request.json?.credential)
        assert.deepEqual(exchange.request.json.credential, item.input.credential);
      const response = exchange.response.json;
      if (response?.receiptHeader)
        assert.deepEqual(decode(response.receiptHeader), response.receipt);
      if (response?.receipt) {
        assert.equal(response.receipt.challengeId, expected.id);
        assert.deepEqual(response.receipt.settlement, old.response.json.receipt.settlement);
      }
    }
    if (item.expect.result?.credential) {
      assert.deepEqual(item.expect.result.challenge, expected);
      assert.deepEqual(item.expect.result.credential, item.input.credential);
    } else if (item.expect.result) {
      assert.equal(item.expect.result.challengeId, expected.id);
      assert.deepEqual(item.expect.result.settlement, before.expect.result.settlement);
    } else assert.deepEqual(item.expect, before.expect);
  }
  assert.equal(changed, 19);
  index.cases[0].input.value.amount = "caller mutation";
  assert.deepEqual(mppCases, original);
  assert.deepEqual(mppCasesWithSellerChallenges(sign), mppCasesWithSellerChallenges(sign));
});

test("signed setup preserves deliberately malformed responses and failure outcomes", () => {
  const index = mppCasesWithSellerChallenges(sign);
  for (const name of ["challenge", "credential", "source", "method", "intent"]) {
    const item = index.cases.find((item) => item.id === `mpp.seller.inconsistent-${name}`);
    const response = item.platform.exchanges[1].response.json;
    const value = {
      challenge: response.challenge.id,
      credential: response.credential.payload.transactionId,
      source: response.source,
      method: response.method,
      intent: response.intent,
    }[name];
    assert.equal(value, name === "source" ? "did:inflow:wrong" : "wrong");
    assert.deepEqual(item.expect, {
      error: { code: "payment-failed", message: "Payment failed." },
    });
  }
  const failed = index.cases.find((item) => item.id === "mpp.seller.receipt-unsuccessful");
  assert.equal(failed.platform.exchanges[2].response.json.receipt.status, "failed");
});

test("signing errors fail generation instead of generating unsigned passing cases", () => {
  for (const value of [
    undefined,
    {},
    { id: 1, expires: expiry },
    { id: " ", expires: expiry },
    { id: "signed" },
    { id: "signed", expires: 1 },
    { id: "signed", expires: "not a date" },
    { id: "signed", expires: "2000-01-01T00:00:00Z" },
  ])
    assert.throws(() => mppCasesWithSellerChallenges(() => value), /fixture signing/);
  const failure = new Error("signing failed");
  assert.throws(
    () =>
      mppCasesWithSellerChallenges(() => {
        throw failure;
      }),
    (error) => error === failure,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { caseList, checkResult } from "../interop/x402.mjs";
import { languages } from "../interop/matrix.mjs";

const id = "22222222-2222-4222-8222-222222222222";
const network = "eip155:8453";
const sample = { buyer: "node", seller: "go", variant: "exact", scenario: "ready" };
const events = [
  "POST /v1/transactions/x402",
  `GET /v1/transactions/${id}/x402`,
  "POST /v1/x402/verify",
  "POST /handler",
  "POST /v1/x402/settle",
];
const result = {
  status: 200,
  body: '{"paidResource":true}',
  cache: "private, no-store",
  receipt: { success: true, transaction: id, network },
};

test("x402 matrix covers every pair, three schemes and instrument recovery", () => {
  const cases = caseList();
  assert.equal(cases.length, 272);
  assert.equal(new Set(cases.map((c) => JSON.stringify(c))).size, 272);
  for (const buyer of languages)
    for (const seller of languages)
      for (const variant of ["balance", "exact"])
        assert.deepEqual(
          cases
            .filter((c) => c.buyer === buyer && c.seller === seller && c.variant === variant)
            .map((c) => c.scenario),
          ["ready", "pending", "invalid", "settlement-failed", "handler-failed"],
        );
});

test("instrument recovery is included for every Buyer and Seller pair", () => {
  for (const buyer of languages)
    for (const seller of languages) {
      assert.deepEqual(
        caseList()
          .filter((c) => c.buyer === buyer && c.seller === seller && c.variant === "instrument")
          .map((c) => c.scenario),
        [
          "ready",
          "pending",
          "invalid",
          "settlement-failed",
          "handler-failed",
          "authenticate",
          "uncertain",
        ],
      );
    }
});

test("successful x402 observations require complete lifecycle, receipt and private caching", () => {
  checkResult(sample, result, events, network);
  for (const changed of [
    { ...result, status: 402 },
    { ...result, body: "{}" },
    { ...result, receipt: null },
    { ...result, receipt: { ...result.receipt, transaction: "wrong" } },
    { ...result, receipt: { ...result.receipt, success: false } },
    { ...result, receipt: { ...result.receipt, network: "wrong" } },
    { ...result, cache: "public" },
  ])
    assert.throws(() => checkResult(sample, changed, events, network));
  for (let index = 0; index < events.length; index++) {
    assert.throws(() =>
      checkResult(
        sample,
        result,
        events.filter((_, i) => i !== index),
        network,
      ),
    );
    assert.throws(() => checkResult(sample, result, [...events, events[index]], network));
  }
  for (const changed of [
    [events[0], events[1], events[3], events[2], events[4]],
    [events[0], events[1], events[2], events[4], events[3]],
  ])
    assert.throws(() => checkResult(sample, result, changed, network));
});

test("pending x402 approval polls twice without creating a second payment", () => {
  const request = { ...sample, scenario: "pending" };
  const pending = [events[0], events[1], ...events.slice(1)];
  checkResult(request, result, pending, network);
  assert.throws(() => checkResult(request, result, events, network));
  assert.throws(() => checkResult(request, result, [...pending, events[0]], network));
});

test("verification and settlement failures cannot expose paid content or success receipts", () => {
  for (const scenario of ["invalid", "settlement-failed"]) {
    const request = { ...sample, scenario };
    const actualEvents = scenario === "invalid" ? events.slice(0, 3) : events;
    const rejected = { status: 402, body: "{}", receipt: null };
    checkResult(request, rejected, actualEvents, network);
    assert.throws(() =>
      checkResult(request, { ...rejected, body: result.body }, actualEvents, network),
    );
    assert.throws(() =>
      checkResult(request, { ...rejected, receipt: result.receipt }, actualEvents, network),
    );
    assert.throws(() =>
      checkResult(request, rejected, [...actualEvents, "POST /handler"], network),
    );
  }
});

test("handler failure is returned without settlement", () => {
  const request = { ...sample, scenario: "handler-failed" };
  const failed = { status: 500, body: result.body, receipt: null };
  checkResult(request, failed, events.slice(0, 4), network);
  assert.throws(() => checkResult(request, failed, events, network));
  assert.throws(() =>
    checkResult(request, { ...failed, receipt: result.receipt }, events.slice(0, 4), network),
  );
});

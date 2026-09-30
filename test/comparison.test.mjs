import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesRequest, matchesOutcome } from "../runner/comparison.mjs";
import { startPlatform } from "../runner/platform.mjs";
import { run } from "../runner/run.mjs";
import { fileURLToPath } from "node:url";

test("the real HTTP platform applies only the x402 request rule", async () => {
  const platform = await startPlatform({
    exchanges: [
      {
        request: { method: "POST", path: "/v1/transactions/x402", json: { accept: { extra: {} } } },
        response: { status: 204 },
      },
    ],
  });
  try {
    const response = await fetch(platform.baseUrl + "/v1/transactions/x402", {
      method: "POST",
      body: JSON.stringify({ accept: {} }),
    });
    assert.equal(response.status, 204);
    await platform.waitComplete(1000);
  } finally {
    await platform.close();
  }
});

test("the runner applies the outcome rule to process observations", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const report = await run({
    index: {
      cases: [
        {
          id: "serialization.settlement",
          suite: "tooling",
          operation: "x402.seller.settle",
          input: { value: { success: false, network: "" } },
          expect: { result: { success: false } },
        },
      ],
    },
    capabilities: { suites: ["tooling"], supported_features: [], unsupported_features: [] },
    implementation: {
      name: "runner test, not SDK conformance",
      runtime: process.version,
      packages: { fixture: "test" },
      dependencies: {},
    },
    command: [process.execPath, fileURLToPath(new URL("fixture-adapter.mjs", import.meta.url))],
    contractRoot: root,
    sdkRoot: root,
  });
  assert.equal(report.completed, true);
  assert.equal(report.passed, true);
});

test("only empty accept.extra on x402 creation is equivalent to omission", () => {
  const supplied = { accept: { amount: "100", extra: {} }, remotePaymentId: "payment" };
  const omitted = { accept: { amount: "100" }, remotePaymentId: "payment" };
  const before = structuredClone(supplied);
  assert.equal(matchesRequest("POST", "/v1/transactions/x402", supplied, omitted), true);
  assert.equal(matchesRequest("POST", "/v1/transactions/x402", omitted, supplied), true);
  assert.deepEqual(supplied, before);
  for (const value of [null, [], "", false, 0, { assetName: "USDC" }]) {
    assert.equal(
      matchesRequest(
        "POST",
        "/v1/transactions/x402",
        { ...supplied, accept: { amount: "100", extra: value } },
        omitted,
      ),
      false,
    );
  }
  for (const [method, path] of [
    ["GET", "/v1/transactions/x402"],
    ["POST", "/v1/x402/settle"],
    ["POST", "/v1/transactions/x402?query=1"],
  ]) {
    assert.equal(matchesRequest(method, path, supplied, omitted), false);
  }
  assert.equal(
    matchesRequest(
      "POST",
      "/v1/transactions/x402",
      { ...omitted, remotePaymentId: "different" },
      supplied,
    ),
    false,
  );
  assert.equal(matchesRequest("POST", "/v1/transactions/x402", null, {}), false);
});

test("decoded buyer requirements allow empty extra but signed bytes stay exact", () => {
  const supplied = {
    result: { encodedPayload: "signed-bytes", paymentPayload: { accepted: { extra: {} } } },
  };
  const omitted = { result: { encodedPayload: "signed-bytes", paymentPayload: { accepted: {} } } };
  const before = structuredClone(supplied);
  for (const op of ["x402.buyer.sign", "x402.buyer.concurrent-await"]) {
    assert.equal(matchesOutcome(op, supplied, omitted), true);
    assert.equal(matchesOutcome(op, omitted, supplied), true);
    assert.equal(
      matchesOutcome(op, { result: { ...omitted.result, encodedPayload: "other" } }, supplied),
      false,
    );
    assert.equal(
      matchesOutcome(
        op,
        {
          result: {
            ...omitted.result,
            paymentPayload: { accepted: { extra: { assetName: "USDC" } } },
          },
        },
        supplied,
      ),
      false,
    );
  }
  assert.equal(matchesOutcome("x402.seller.verify", supplied, omitted), false);
  assert.equal(
    matchesOutcome("x402.buyer.sign", { error: { code: "x" } }, { error: { code: "y" } }),
    false,
  );
  assert.deepEqual(supplied, before);
});

test("only an unsuccessful settlement permits empty network and omission", () => {
  const omitted = { result: { success: false, transaction: "", errorReason: "settlement_failed" } };
  const empty = { result: { ...omitted.result, network: "" } };
  const before = structuredClone(empty);
  assert.equal(matchesOutcome("x402.seller.settle", omitted, empty), true);
  assert.equal(matchesOutcome("x402.seller.settle", empty, omitted), true);
  for (const network of [null, "inflow:1", 0, false]) {
    assert.equal(
      matchesOutcome("x402.seller.settle", { result: { ...omitted.result, network } }, omitted),
      false,
    );
  }
  for (const success of [true, undefined, null]) {
    assert.equal(
      matchesOutcome(
        "x402.seller.settle",
        { result: { success, network: "" } },
        { result: { success } },
      ),
      false,
    );
  }
  assert.equal(matchesOutcome("x402.seller.verify", omitted, empty), false);
  assert.equal(
    matchesOutcome(
      "x402.seller.settle",
      { result: { ...empty.result, errorReason: "different" } },
      omitted,
    ),
    false,
  );
  assert.equal(
    matchesOutcome(
      "x402.seller.settle",
      { result: { ...empty.result, transaction: "different" } },
      omitted,
    ),
    false,
  );
  assert.deepEqual(empty, before);
});

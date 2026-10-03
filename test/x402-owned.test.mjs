import assert from "node:assert/strict";
import { test } from "node:test";
import { x402Cases, x402CasesForOwnedPayments } from "../fixtures/x402.mjs";
import { selectCases } from "../runner/validation.mjs";

const capabilities = {
  suites: ["x402-core", "x402-buyer", "x402-seller"],
  supported_features: [],
  unsupported_features: [
    { id: "x402-shared-payment-wait", reason: "Waiting consumes the payment handle." },
  ],
};

test("owned payments preserve every case except failed-wait cleanup and shared-wait declaration", () => {
  const original = structuredClone(x402Cases);
  const owned = x402CasesForOwnedPayments();
  const changed = [];
  assert.equal(owned.cases.length, original.cases.length);
  for (const [position, item] of owned.cases.entries()) {
    const baseline = original.cases[position];
    if (item.id === "x402.buyer.concurrent-await") {
      assert.equal(item.feature, "x402-shared-payment-wait");
      delete item.feature;
    } else if (item.platform?.exchanges.length !== baseline.platform?.exchanges.length) {
      changed.push(item.id);
      assert.equal(item.platform.exchanges.length, baseline.platform.exchanges.length + 1);
      const cleanup = item.platform.exchanges.pop();
      const creation = baseline.platform.exchanges.find(
        ({ request }) => request.path === "/v1/transactions/x402",
      );
      assert.deepEqual(cleanup, {
        request: {
          method: "POST",
          path: `/v1/approvals/${creation.response.json.approvalId}/cancel`,
          headers: creation.request.headers,
        },
        response: { status: 204 },
      });
    }
    assert.deepEqual(item, baseline);
  }
  assert.deepEqual(changed, [
    "x402.buyer.failure-declined",
    "x402.buyer.failure-expired",
    "x402.buyer.failure-general_error",
    "x402.buyer.failure-insufficient_funds",
    "x402.buyer.permanent-poll-401",
    "x402.buyer.permanent-poll-403",
    "x402.buyer.permanent-poll-404",
    "x402.buyer.timeout-during-poll",
    "x402.buyer.timeout",
  ]);
  assert.deepEqual(x402Cases, original);
  assert.deepEqual(x402CasesForOwnedPayments(), x402CasesForOwnedPayments());
});

test("owned profile requires an explicit shared-wait declaration and keeps other cases mandatory", () => {
  const index = x402CasesForOwnedPayments();
  const selected = selectCases(index, capabilities);
  assert.deepEqual(
    selected.filter(({ omission }) => omission !== null).map(({ item }) => item.id),
    ["x402.buyer.concurrent-await"],
  );
  assert.throws(
    () => selectCases(index, { ...capabilities, unsupported_features: [] }),
    /Undeclared feature/,
  );
  assert.ok(
    selectCases(index, {
      ...capabilities,
      supported_features: ["x402-shared-payment-wait"],
      unsupported_features: [],
    }).every(({ omission }) => omission === null),
  );
});

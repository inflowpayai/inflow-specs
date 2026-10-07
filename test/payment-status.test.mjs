import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { paymentStatusCases } from "../fixtures/payment-status.mjs";
import { selectCases, validate } from "../runner/validation.mjs";
import { startPlatform } from "../runner/platform.mjs";

test("Payment status cases are deterministic mandatory Buyer operations", () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../fixtures/payment-status.mjs", import.meta.url))],
    { encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(output), paymentStatusCases);
  const selected = selectCases(paymentStatusCases, {
    suites: ["mpp-buyer", "x402-buyer"],
    supported_features: [],
    unsupported_features: [],
  });
  assert.equal(selected.length, 30);
  assert.ok(selected.every(({ omission }) => omission === null));
  for (const item of paymentStatusCases.cases) {
    validate("adapter-response", {
      adapter_version: "1",
      sequence: 1,
      case_id: item.id,
      ...item.expect,
    });
    assert.ok(item.platform.exchanges.every(({ request }) => request.method === "GET"));
    assert.ok(item.platform.exchanges.every(({ request }) => !Object.hasOwn(request, "json")));
    const reads = item.platform.exchanges.filter(
      ({ request }) => !request.path.endsWith("x402-supported"),
    );
    assert.equal(reads.length, item.input.retries ? 2 : (item.input.reads ?? 1));
    assert.ok(
      reads.every(
        ({ request }) =>
          request.path === `/v1/transactions/${encodeURIComponent(item.input.transaction_id)}`,
      ),
    );
    if (item.expect.result) {
      const successes = reads.filter(({ response }) => response.status === 200);
      assert.deepEqual(
        successes.map(({ response }) => response.json),
        item.expect.result,
      );
    }
  }
});

test("Payment status schemas reject mixed credentials and wrong operations", () => {
  for (const suite of ["mpp-buyer", "x402-buyer"]) {
    const original = paymentStatusCases.cases.find((item) => item.suite === suite);
    for (const mutate of [
      (item) => {
        delete item.platform;
      },
      (item) => {
        delete item.input.api_key;
      },
      (item) => {
        item.input.access_token = "test-only-token";
      },
      (item) => {
        item.input.reads = 0;
      },
      (item) => {
        item.input.retries = -1;
      },
      (item) => {
        item.input.transaction_id = "";
      },
      (item) => {
        item.operation =
          suite === "mpp-buyer" ? "x402.buyer.payment-status" : "mpp.buyer.payment-status";
      },
      (item) => {
        item.expect.result = [{ transactionId: "id" }];
      },
    ]) {
      const changed = structuredClone(original);
      mutate(changed);
      assert.throws(
        () =>
          selectCases(
            { cases: [changed] },
            { suites: [suite], supported_features: [], unsupported_features: [] },
          ),
        /Invalid/,
      );
    }
  }
});

for (const item of paymentStatusCases.cases) {
  test(`Payment status mock exchanges, not SDK conformance: ${item.id}`, async () => {
    const platform = await startPlatform(item.platform);
    try {
      for (const { request, response } of item.platform.exchanges) {
        const actual = await fetch(platform.baseUrl + request.path, {
          headers: request.headers,
          redirect: "manual",
        });
        assert.equal(actual.status, response.status);
        assert.deepEqual(await actual.json(), response.json);
        for (const [key, value] of Object.entries(response.headers ?? {}))
          assert.equal(actual.headers.get(key), value);
      }
      await platform.waitComplete(1000);
    } finally {
      await platform.close();
    }
  });
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { x402Cases, x402FailureMessages } from "../fixtures/x402.mjs";
import { selectCases, validate } from "../runner/validation.mjs";
import { startPlatform } from "../runner/platform.mjs";

test("x402 corpus exports deterministic schema-checked operations", () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../fixtures/x402.mjs", import.meta.url))],
    { encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(output), x402Cases);
  const selected = selectCases(x402Cases, {
    suites: ["x402-core", "x402-buyer", "x402-seller"],
    supported_features: [],
    unsupported_features: [],
  });
  assert.equal(selected.length, x402Cases.cases.length);
  assert.ok(selected.every(({ omission }) => omission === null));
  for (const item of x402Cases.cases) {
    validate("adapter-response", {
      adapter_version: "1",
      sequence: 1,
      case_id: item.id,
      ...item.expect,
    });
    if (item.expect.error)
      assert.equal(item.expect.error.message, x402FailureMessages[item.expect.error.code]);
  }
});

test("x402 schemas reject contradictory suite, operation and input combinations", () => {
  const original = x402Cases.cases.find((item) => item.id === "x402.buyer.ready-balance");
  for (const mutate of [
    (item) => {
      delete item.platform;
    },
    (item) => {
      item.suite = "x402-seller";
    },
    (item) => {
      item.operation = "x402.buyer.missing";
    },
    (item) => {
      item.input.base_url = "https://api.inflowpay.ai";
    },
    (item) => {
      delete item.input.context;
    },
    (item) => {
      item.input.timeout_ms = -1;
    },
    (item) => {
      item.expect.result = "not a payment";
    },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.throws(
      () =>
        selectCases(
          { cases: [changed] },
          { suites: [changed.suite], supported_features: [], unsupported_features: [] },
        ),
      /Invalid/,
    );
  }
});

test("x402 signing values remain consistent across creation, polling and returned payload", () => {
  for (const item of x402Cases.cases.filter((value) => value.suite === "x402-buyer")) {
    for (const { request, response } of item.platform.exchanges) {
      if (request.path === "/v1/transactions/x402") {
        assert.deepEqual(request.json.accept, item.input.requirement);
        assert.equal(request.json.remotePaymentId, item.input.payment_id);
        assert.deepEqual(request.json.resource, item.input.context.resource);
      }
      if (response.json?.encodedPayload) {
        const decoded = JSON.parse(
          Buffer.from(response.json.encodedPayload, "base64").toString("utf8"),
        );
        assert.deepEqual(decoded, response.json.paymentPayload);
        assert.deepEqual(decoded.accepted, item.input.requirement);
        assert.deepEqual(item.expect.result.paymentPayload, decoded);
      }
    }
  }
});

test("x402 settlement retries keep complete payment requests identical", () => {
  const allowance = x402Cases.cases.find((item) => item.id === "x402.seller.verify-allowance");
  assert.equal(allowance.input.payment_requirements.extra.assetTransferMethod, "permit2");
  assert.equal(
    allowance.input.payment_payload.payload.permit2Authorization.permitted.amount,
    allowance.input.payment_requirements.amount,
  );
  for (const item of x402Cases.cases.filter((value) =>
    value.id.startsWith("x402.seller.settle-pending-"),
  )) {
    const first = item.platform.exchanges[0].request;
    for (const { request } of item.platform.exchanges) assert.deepEqual(request, first);
    assert.equal(
      first.json.paymentPayload.extensions["payment-identifier"].info.id,
      item.input.payment_payload.extensions["payment-identifier"].info.id,
    );
  }
  const rejected = x402Cases.cases.find(
    (item) => item.id === "x402.seller.rejected-verification-no-settlement",
  );
  assert.deepEqual(
    rejected.platform.exchanges.map(({ request }) => request.path),
    ["/v1/x402/verify"],
  );
});

for (const item of x402Cases.cases.filter((value) => value.platform)) {
  test(`x402 mock reference exchange, not SDK conformance: ${item.id}`, async () => {
    const platform = await startPlatform(item.platform);
    try {
      for (const { request, response } of item.platform.exchanges) {
        const received = await fetch(platform.baseUrl + request.path, {
          method: request.method,
          headers: request.headers,
          ...(Object.hasOwn(request, "json") ? { body: JSON.stringify(request.json) } : {}),
        });
        assert.equal(received.status, response.status);
        if (Object.hasOwn(response, "json")) assert.deepEqual(await received.json(), response.json);
        else assert.equal(await received.text(), "");
        for (const [name, value] of Object.entries(response.headers ?? {}))
          assert.equal(received.headers.get(name), value);
      }
      await platform.waitComplete(1000);
    } finally {
      await platform.close();
    }
  });
}

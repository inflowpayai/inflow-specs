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

test("Instrument fixtures preserve exact cent boundaries and the independent wire scale", () => {
  const find = (suffix) => {
    const item = x402Cases.cases.find((entry) => entry.id === `x402.seller.instrument-${suffix}`);
    assert.ok(item);
    return item;
  };
  for (const [name, cents] of [
    ["minimum", 50n],
    ["maximum", (1n << 63n) - 1n],
  ]) {
    const item = find(name);
    const offer = item.expect.result[0];
    assert.equal(offer.price.asset, "USD");
    assert.equal(BigInt(offer.price.amount), cents * 10n ** 16n);
    assert.equal(offer.payTo, item.input.config.sellerId);
  }
  assert.deepEqual(find("trailing-zero").expect, find("explicit").expect);
  for (const name of ["zero", "below-minimum", "fractional-cent", "above-maximum"]) {
    assert.equal(find(name).expect.error.code, "invalid-input");
  }
  assert.ok(find("not-default").expect.result.every((offer) => offer.scheme !== "instrument"));
  assert.deepEqual(find("without-blockchain-assets").input.config.assets, []);
  assert.deepEqual(find("without-blockchain-assets").expect, find("explicit").expect);
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

test("Buyer instrument selection stays outside accepted requirements and cannot fall back", () => {
  for (const item of x402Cases.cases.filter((entry) =>
    entry.id.startsWith("x402.buyer.instrument-"),
  )) {
    const creations = item.platform.exchanges.filter(({ request }) => request.method === "POST");
    assert.equal(creations.length, 1);
    const body = creations[0].request.json;
    assert.deepEqual(body.accept, item.input.requirement);
    assert.equal(
      body.instrumentId,
      item.input.requirement.scheme === "instrument" ? item.input.instrument_id : undefined,
    );
    if (item.input.requirement.scheme !== "instrument") assert.ok(item.input.instrument_id);
    if (item.expect.error) assert.equal(item.platform.exchanges.length, 2);
    if (item.input.requirement.scheme === "instrument" && item.expect.result)
      assert.deepEqual(item.expect.result.paymentPayload.payload, {
        transactionId: item.expect.result.transactionId,
      });
  }
});

test("settlement response fixtures include the requested network on success and failure", () => {
  for (const item of x402Cases.cases.filter((value) => value.suite === "x402-seller")) {
    for (const { request, response } of item.platform?.exchanges ?? []) {
      if (request.path === "/v1/x402/settle" && typeof response.json?.success === "boolean") {
        assert.equal(response.json.network, request.json.paymentRequirements.network);
      }
    }
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
        if (item.expect.result) assert.deepEqual(item.expect.result.paymentPayload, decoded);
      }
    }
  }
});

test("delayed signed payload crosses the buyer wait budget without automatic cancellation", () => {
  const item = x402Cases.cases.find((value) => value.id === "x402.buyer.timeout-during-poll");
  assert.equal(item.expect.error.code, "payment-timeout");
  assert.equal(item.platform.exchanges.length, 3);
  const last = item.platform.exchanges.at(-1);
  assert.ok(last.response.json.encodedPayload);
  assert.ok(last.response.delay_ms > item.input.timeout_ms);
  assert.equal(last.request.method, "GET");
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

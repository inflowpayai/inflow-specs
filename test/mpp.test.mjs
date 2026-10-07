import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { mppCases, mppFailureMessages } from "../fixtures/mpp.mjs";
import { selectCases, validate } from "../runner/validation.mjs";
import { startPlatform } from "../runner/platform.mjs";

const decode = (value) => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
test("Buyer failure expectations preserve transaction identifiers supplied by the platform", () => {
  for (const item of mppCases.cases.filter((entry) => entry.suite === "mpp-buyer")) {
    const failed = item.platform.exchanges.find(
      ({ response }) => response.json?.state === "failed",
    );
    if (!failed) continue;
    assert.equal(item.expect.error.code, "payment-failed");
    assert.deepEqual(item.expect.error.details.problem, failed.response.json.problem);
    assert.equal(item.expect.error.details.transaction_id, failed.response.json.transactionId);
  }
});

test("Instrument Buyer fixtures preserve primary selection and reject replacement purchases", () => {
  for (const name of [
    "instrument-primary",
    "instrument-rejected-no-fallback",
    "ready-instrument",
  ]) {
    const item = mppCases.cases.find((entry) => entry.id === `mpp.buyer.${name}`);
    assert.equal(item.platform.exchanges.length, 1);
    const body = item.platform.exchanges[0].request.json;
    assert.deepEqual(body.options, item.input.context);
    assert.deepEqual(body.challenge, item.input.challenge);
    if (name === "instrument-primary") assert.deepEqual(body.options, {});
    else assert.ok(body.options.instrumentId);
    if (item.expect.result) assert.equal(item.expect.result.payload.type, "instrument");
    else assert.equal(item.expect.error.code, "payment-failed");
  }
});

test("MPP corpus exports a deterministic case index for the runner", () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../fixtures/mpp.mjs", import.meta.url))],
    { encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(output), mppCases);
  validate("case-index", mppCases);
  const selected = selectCases(mppCases, {
    suites: ["mpp-core", "mpp-buyer", "mpp-seller"],
    supported_features: ["mpp-seller-subscriptions"],
    unsupported_features: [],
  });
  assert.equal(selected.length, mppCases.cases.length);
  assert.ok(selected.every(({ omission }) => omission === null));
  for (const item of mppCases.cases) {
    if (item.expect.error) {
      assert.equal(item.expect.error.message, mppFailureMessages[item.expect.error.code]);
      validate("adapter-response", {
        adapter_version: "1",
        sequence: 1,
        case_id: item.id,
        ...item.expect,
      });
    }
  }
});

test("Seller subscription capability preserves charge and Buyer requirements", () => {
  const capabilities = {
    suites: ["mpp-core", "mpp-buyer", "mpp-seller"],
    supported_features: [],
    unsupported_features: [
      {
        id: "mpp-seller-subscriptions",
        reason: "Upstream Seller framework cannot expose subscription terms.",
      },
    ],
  };
  const expected = [
    "mpp.seller.validate-subscription",
    "mpp.seller.verify-subscription",
    "mpp.seller.validation-rejected-subscription",
    "mpp.seller.broadcast-rejected-subscription",
    "mpp.seller.prepare-subscription",
    "mpp.seller.unsupported-intent-currency",
    "mpp.seller.route-binding-subscription-1",
    "mpp.seller.route-binding-subscription-2",
    "mpp.seller.route-binding-subscription-3",
    "mpp.seller.subscription-renewal-in-progress",
  ].sort();
  const selected = selectCases(mppCases, capabilities);
  assert.equal(selected.length, mppCases.cases.length);
  assert.deepEqual(
    selected
      .filter(({ omission }) => omission !== null)
      .map(({ item }) => item.id)
      .sort(),
    expected,
  );
  assert.throws(
    () => selectCases(mppCases, { ...capabilities, unsupported_features: [] }),
    /feature/i,
  );
  const buyerOnly = selectCases(mppCases, {
    suites: ["mpp-core", "mpp-buyer"],
    supported_features: [],
    unsupported_features: [],
  });
  assert.ok(buyerOnly.every(({ omission }) => omission === null));
});

test("encoded literals, purchase credentials and subscription authorization agree with their exchanges", () => {
  const byId = Object.fromEntries(mppCases.cases.map((item) => [item.id, item]));
  assert.deepEqual(
    decode(byId["mpp.core.encode-request"].expect.result),
    byId["mpp.core.encode-request"].input.value,
  );
  for (const item of mppCases.cases) {
    if (item.operation === "mpp.core.decode-credential" && item.expect.result)
      assert.deepEqual(decode(item.input.value), item.expect.result);
    for (const { request, response } of item.platform?.exchanges ?? []) {
      if (response.json?.credential && item.expect.result && item.suite === "mpp-buyer")
        assert.deepEqual(decode(response.json.credential), item.expect.result);
      if (request.path === "/v1/transactions/mpp")
        assert.deepEqual(request.json.challenge, item.input.challenge);
      if (request.path.endsWith("/authorize")) {
        assert.deepEqual(request.json.challenge, item.input.challenge);
        assert.equal(item.platform.exchanges.length, 1);
      }
      if (request.path === "/v1/mpp/validate" && response.json?.success === true) {
        if (!item.id.startsWith("mpp.seller.inconsistent-")) {
          assert.deepEqual(response.json.credential, request.json.credential);
          assert.deepEqual(
            response.json.request,
            decode(request.json.credential.challenge.request),
          );
        }
      }
      if (response.json?.receiptHeader)
        assert.deepEqual(decode(response.json.receiptHeader), response.json.receipt);
    }
  }
});

test("pending timeout cases distinguish waiting between requests from an active poll", () => {
  const waiting = mppCases.cases.find((item) => item.id === "mpp.buyer.timeout");
  const polling = mppCases.cases.find((item) => item.id === "mpp.buyer.timeout-during-poll");
  assert.equal(waiting.platform.exchanges.length, 2);
  assert.equal(polling.platform.exchanges.length, 3);
  const [create, poll, cancel] = polling.platform.exchanges;
  assert.equal(create.response.json.state, "pending");
  assert.equal(create.response.json.retryAfterSeconds, 0);
  assert.equal(poll.request.method, "GET");
  assert.equal(poll.request.path, `/v1/transactions/${create.response.json.transactionId}/mpp`);
  assert.equal(poll.response.json.state, "ready");
  assert.ok(poll.response.delay_ms > polling.input.timeout_ms);
  assert.equal(cancel.request.method, "POST");
  assert.equal(cancel.request.path, `/v1/approvals/${create.response.json.approvalId}/cancel`);
  assert.equal(polling.expect.error.code, "payment-timeout");
  assert.equal(polling.expect.error.details.transaction_id, create.response.json.transactionId);
});

test("MPP operation schemas reject malformed fixture contracts before starting an adapter", () => {
  const original = mppCases.cases.find((item) => item.id === "mpp.buyer.ready-balance");
  for (const mutate of [
    (item) => {
      delete item.platform;
    },
    (item) => {
      delete item.input.context;
    },
    (item) => {
      item.input.extra = true;
    },
    (item) => {
      item.input.timeout_ms = -1;
    },
    (item) => {
      item.operation = "mpp.buyer.unknown";
    },
    (item) => {
      item.expect.result = "not a credential";
    },
    (item) => {
      item.suite = "mpp-seller";
    },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.throws(() => validate("mpp-case", changed), /Invalid/);
  }
});

test("Seller rejection cases have no broadcast and positive verification has both phases", () => {
  for (const item of mppCases.cases.filter((value) => value.suite === "mpp-seller")) {
    const paths = item.platform.exchanges.map(({ request }) => request.path);
    if (
      item.operation === "mpp.seller.validate" ||
      item.id.includes("validation-rejected") ||
      item.id.includes("inconsistent-")
    )
      assert.equal(paths.includes("/v1/mpp/broadcast"), false);
    if (item.operation === "mpp.seller.verify" && item.expect.result) {
      assert.equal(paths[1], "/v1/mpp/validate");
      assert.equal(paths[2], "/v1/mpp/broadcast");
    }
  }
});

for (const item of mppCases.cases.filter((value) => value.platform)) {
  test(`MPP mock reference exchange, not SDK conformance: ${item.id}`, async () => {
    const platform = await startPlatform(item.platform);
    const captured = new Map();
    try {
      for (const { request, response } of item.platform.exchanges) {
        const headers = {};
        for (const [key, value] of Object.entries(request.headers ?? {})) {
          if (value === null) continue;
          if (typeof value === "string") headers[key] = value;
          else if (value.capture) {
            captured.set(value.capture, "synthetic-generated-key");
            headers[key] = captured.get(value.capture);
          } else headers[key] = captured.get(value.same);
        }
        const received = await fetch(platform.baseUrl + request.path, {
          method: request.method,
          headers,
          ...(Object.hasOwn(request, "json") ? { body: JSON.stringify(request.json) } : {}),
        });
        assert.equal(received.status, response.status);
        if (Object.hasOwn(response, "json")) assert.deepEqual(await received.json(), response.json);
        else assert.equal(await received.text(), response.text ?? "");
      }
      await platform.waitComplete(1000);
    } finally {
      await platform.close();
    }
  });
}

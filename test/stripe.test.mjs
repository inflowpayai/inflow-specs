import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { stripeCases } from "../fixtures/stripe.mjs";
import { selectCases, validate } from "../runner/validation.mjs";
import { startPlatform } from "../runner/platform.mjs";

test("Stripe cases are deterministic, schema-checked Seller operations", () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../fixtures/stripe.mjs", import.meta.url))],
    { encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(output), stripeCases);
  const selected = selectCases(stripeCases, {
    suites: ["mpp-seller"],
    supported_features: [],
    unsupported_features: [],
  });
  assert.equal(selected.length, stripeCases.cases.length);
  assert.ok(selected.every(({ omission }) => omission === null));
  for (const item of stripeCases.cases) validate("mpp-case", item);
});

test("Stripe failure cases cannot broadcast before successful validation", () => {
  for (const item of stripeCases.cases) {
    const paths = item.platform.exchanges.map(({ request }) => request.path);
    const broadcast = paths.indexOf("/v1/mpp/broadcast");
    if (broadcast >= 0) {
      assert.equal(paths[broadcast - 1], "/v1/mpp/validate");
      assert.equal(item.platform.exchanges[broadcast - 1].response.json.success, true);
    }
    if (
      item.operation === "mpp.seller.prepare" ||
      item.operation === "mpp.seller.route-binding" ||
      item.id.includes("reference-missing") ||
      item.id.includes("reference-different") ||
      item.id.includes("reference-empty")
    )
      assert.deepEqual(paths, ["/v1/mpp/config"]);
    if (item.id.includes("validation-") || item.id.endsWith("validate-only"))
      assert.equal(broadcast, -1);
  }
});

test("Stripe wire amounts, references and receipt headers preserve their contract", () => {
  for (const item of stripeCases.cases) {
    if (item.operation === "mpp.seller.prepare" && item.expect.result) {
      assert.match(item.expect.result.amount, /^[1-9][0-9]*$/);
      assert.equal(item.expect.result.currency, "usd");
    }
    for (const { request, response } of item.platform.exchanges) {
      if (request.json) assert.deepEqual(request.json.credential, item.input.credential);
      if (response.json?.receiptHeader)
        assert.deepEqual(
          JSON.parse(Buffer.from(response.json.receiptHeader, "base64url").toString()),
          response.json.receipt,
        );
      if (response.json?.success === true && !item.id.includes("validation-inconsistent"))
        assert.deepEqual(response.json.credential, request.json.credential);
    }
  }
});

for (const item of stripeCases.cases) {
  test(`Stripe mock exchange consistency, not SDK conformance: ${item.id}`, async () => {
    const platform = await startPlatform(item.platform);
    const captured = new Map();
    try {
      for (const { request, response } of item.platform.exchanges) {
        const headers = {};
        for (const [key, value] of Object.entries(request.headers)) {
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
          ...(request.json ? { body: JSON.stringify(request.json) } : {}),
        });
        assert.equal(received.status, response.status);
        if (response.json) assert.deepEqual(await received.json(), response.json);
      }
      await platform.waitComplete(1000);
    } finally {
      await platform.close();
    }
  });
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { cardCases } from "../fixtures/card.mjs";
import { selectCases, validate } from "../runner/validation.mjs";

test("CARD cases are deterministic mandatory operations for their selected roles", () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../fixtures/card.mjs", import.meta.url))],
    { encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(output), cardCases);
  const selected = selectCases(cardCases, {
    suites: ["mpp-seller", "mpp-buyer"],
    supported_features: [],
    unsupported_features: [],
  });
  assert.equal(selected.length, cardCases.cases.length);
  assert.ok(selected.every(({ omission }) => omission === null));
  for (const item of cardCases.cases) {
    validate("mpp-case", item);
    if (["mpp.seller.prepare", "mpp.seller.route-binding"].includes(item.operation))
      assert.equal(item.platform.exchanges.length, 1);
    if (item.suite === "mpp-seller") {
      assert.equal(item.platform.exchanges[0].request.path, "/v1/mpp/config");
      assert.equal(item.platform.exchanges[0].request.method, "GET");
    }
  }
});

test("CARD expectations preserve cents and configuration authority", () => {
  for (const item of cardCases.cases.filter(
    (entry) => entry.operation === "mpp.seller.prepare" && entry.expect.result,
  )) {
    const result = item.expect.result;
    const [whole, fraction = ""] = item.input.request.amount.split(".");
    assert.equal(BigInt(result.amount), BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0")));
    assert.equal(result.currency, "usd");
    const details = item.platform.exchanges[0].response.json.supportedMethods[0].methodDetails;
    assert.equal(result.recipient, details.recipient);
    assert.equal(result.methodDetails.merchantName, details.merchantName);
    assert.deepEqual(result.methodDetails.encryptionJwk, details.encryptionJwk);
    const key = createPublicKey({ key: details.encryptionJwk, format: "jwk" });
    assert.equal(key.asymmetricKeyType, "rsa");
    assert.equal(key.asymmetricKeyDetails.modulusLength, 2048);
    assert.deepEqual(result.methodDetails.acceptedNetworks, details.acceptedNetworks);
    assert.equal(result.methodDetails.billingRequired, item.input.request.billingRequired);
  }
});

test("CARD validation precedes broadcast and preserves opaque credentials", () => {
  for (const item of cardCases.cases) {
    if (item.suite !== "mpp-seller") continue;
    const exchanges = item.platform.exchanges;
    const first = exchanges.findIndex(({ request }) => request.path === "/v1/mpp/broadcast");
    if (first >= 0) {
      assert.equal(exchanges[first - 1].request.path, "/v1/mpp/validate");
      assert.equal(exchanges[first - 1].response.json.success, true);
    }
    if (item.id.includes("validation-") || item.id.endsWith("validate-only"))
      assert.equal(first, -1);
    for (const { request } of exchanges) {
      if (!request.json) continue;
      assert.deepEqual(request.json.credential, {
        ...item.input.credential,
        source: item.input.credential.source ?? "",
      });
    }
  }
});

test("CARD Buyer cases never create a second purchase and preserve selection", () => {
  for (const item of cardCases.cases.filter((entry) => entry.suite === "mpp-buyer")) {
    const creates = item.platform.exchanges.filter(
      ({ request }) => request.path === "/v1/transactions/mpp",
    );
    assert.ok(creates.length <= 1);
    if (creates.length) {
      assert.deepEqual(creates[0].request.json, {
        challenge: item.input.challenge,
        options: item.input.context,
      });
      assert.equal(creates[0].request.method, "POST");
    }
    if (item.expect.error?.code === "invalid-input")
      assert.equal(item.platform.exchanges.length, 0);
    if (item.expect.result) assert.deepEqual(item.expect.result.challenge, item.input.challenge);
  }
});

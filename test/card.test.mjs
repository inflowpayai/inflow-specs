import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { cardCases } from "../fixtures/card.mjs";
import { selectCases, validate } from "../runner/validation.mjs";

test("CARD offer cases are deterministic mandatory Seller operations", () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../fixtures/card.mjs", import.meta.url))],
    { encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(output), cardCases);
  const selected = selectCases(cardCases, {
    suites: ["mpp-seller"],
    supported_features: [],
    unsupported_features: [],
  });
  assert.equal(selected.length, cardCases.cases.length);
  assert.ok(selected.every(({ omission }) => omission === null));
  for (const item of cardCases.cases) {
    validate("mpp-case", item);
    assert.equal(item.platform.exchanges.length, 1);
    assert.equal(item.platform.exchanges[0].request.path, "/v1/mpp/config");
    assert.equal(item.platform.exchanges[0].request.method, "GET");
  }
});

test("CARD expectations preserve cents and configuration authority", () => {
  for (const item of cardCases.cases.filter((entry) => entry.expect.result)) {
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

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { releaseCases } from "../interop/releases.mjs";
import { languages } from "../interop/matrix.mjs";

test("released-package checks cover both outcomes and protocols for every language", () => {
  const cases = releaseCases();
  assert.equal(cases.length, 16);
  assert.equal(new Set(cases.map((c) => JSON.stringify(c))).size, 16);
  for (const language of languages)
    for (const protocol of ["mpp", "x402"]) {
      const pair = cases.filter(
        (c) => c.buyer === language && c.seller === language && c.protocol === protocol,
      );
      assert.deepEqual(
        pair.map((c) => c.scenario),
        ["ready", "invalid"],
      );
      assert.ok(pair.every((c) => c.variant === (protocol === "mpp" ? "charge" : "balance")));
    }
});

test("released SDK versions are exact stable pins, not source paths or floating tags", () => {
  const versions = JSON.parse(readFileSync(new URL("../interop/releases.json", import.meta.url)));
  assert.deepEqual(Object.keys(versions), languages);
  assert.deepEqual(Object.keys(versions.node), [
    "@inflowpayai/mpp",
    "@inflowpayai/mpp-buyer",
    "@inflowpayai/mpp-seller",
    "@inflowpayai/x402",
    "@inflowpayai/x402-buyer",
    "@inflowpayai/x402-seller",
  ]);
  for (const v of [...Object.values(versions.node), versions.python, versions.rust])
    assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.match(versions.go, /^v\d+\.\d+\.\d+$/);
});

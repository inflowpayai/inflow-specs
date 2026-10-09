import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { releaseCases, releaseControls } from "../interop/releases.mjs";
import { languages } from "../interop/matrix.mjs";

test("released-package checks cover payment variants, failures and recovery for each language", () => {
  const cases = releaseCases();
  assert.equal(cases.length, 202);
  assert.equal(new Set(cases.map((c) => JSON.stringify(c))).size, 202);
  assert.equal(cases.filter((c) => c.unsupported).length, 4);
  for (const language of languages)
    for (const protocol of ["mpp", "x402"]) {
      const pair = cases.filter(
        (c) => c.buyer === language && c.seller === language && c.protocol === protocol,
      );
      const variants =
        protocol === "mpp"
          ? ["charge", "tempo", "instrument", "card"]
          : ["balance", "exact", "instrument"];
      for (const variant of variants) {
        assert.deepEqual(
          pair.filter((c) => c.variant === variant).map((c) => c.scenario),
          [
            "ready",
            "pending",
            "invalid",
            "settlement-failed",
            "handler-failed",
            ...(["instrument", "card"].includes(variant) ? ["authenticate", "uncertain"] : []),
          ],
        );
      }
      if (protocol === "mpp") {
        for (const variant of ["subscription", "existing-subscription"]) {
          const subscriptions = pair.filter((c) => c.variant === variant);
          if (["python", "rust"].includes(language)) {
            assert.equal(subscriptions.length, 1);
            assert.match(subscriptions[0].unsupported, /upstream limitation/);
            assert.equal(subscriptions[0].passed, undefined);
          } else {
            assert.deepEqual(
              subscriptions.map((c) => c.scenario),
              [
                "ready",
                ...(variant === "subscription" ? ["pending"] : []),
                "invalid",
                "settlement-failed",
                "handler-failed",
              ],
            );
          }
        }
      }
    }
  for (const seller of languages) {
    const stripe = cases.filter((c) => c.variant === "stripe" && c.seller === seller);
    assert.ok(stripe.every((c) => c.buyer === "node" && c.protocol === "mpp"));
    assert.deepEqual(
      stripe.map((c) => c.scenario),
      ["ready", "invalid", "settlement-failed", "handler-failed"],
    );
  }
  assert.ok(cases.every((c) => c.buyer === c.seller || c.variant === "stripe"));
});

test("receipt negative controls cover each installed language and protocol", () => {
  const controls = releaseControls();
  assert.equal(controls.length, 8);
  for (const language of languages)
    for (const protocol of ["mpp", "x402"])
      assert.deepEqual(
        controls.filter((c) => c.buyer === language && c.protocol === protocol),
        [
          {
            buyer: language,
            seller: language,
            protocol,
            variant: protocol === "mpp" ? "charge" : "balance",
            scenario: "ready",
          },
        ],
      );
});

test("released SDK versions are exact stable pins, not source paths or floating tags", () => {
  const versions = JSON.parse(readFileSync(new URL("../interop/releases.json", import.meta.url)));
  assert.deepEqual(Object.keys(versions), [...languages, "peerRevisions"]);
  assert.deepEqual(Object.keys(versions.peerRevisions), languages);
  for (const revision of Object.values(versions.peerRevisions))
    assert.match(revision, /^[0-9a-f]{40}$/);
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

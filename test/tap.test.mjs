import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { tapCases, tapKey, tapSigningExamples } from "../fixtures/tap.mjs";
import { selectCases, validate } from "../runner/validation.mjs";
import { startPlatform } from "../runner/platform.mjs";

test("TAP cases are deterministic and selected without optional omissions", () => {
  assert.deepEqual(
    JSON.parse(
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL("../fixtures/tap.mjs", import.meta.url))],
        { encoding: "utf8" },
      ),
    ),
    tapCases,
  );
  const selected = selectCases(tapCases, {
    suites: ["tap-seller"],
    supported_features: [],
    unsupported_features: [],
  });
  assert.equal(selected.length, tapCases.cases.length);
  assert.ok(selected.every(({ omission }) => omission === null));
  for (const item of tapCases.cases) {
    validate("tap-case", item);
    assert.equal(item.input.steps.length, item.expect.result.steps.length);
    const accepted = item.expect.result.steps.reduce((n, step) => n + step.accepted.length, 0);
    assert.equal(accepted, item.expect.result.handler_calls);
    assert.ok(item.expect.result.claim_calls >= accepted);
    for (const [index, step] of item.input.steps.entries()) {
      const expected = item.expect.result.steps[index];
      assert.equal(step.requests.length, expected.accepted.length + expected.rejected.length);
    }
  }
});

test("synthetic signatures verify independently with Node cryptography", () => {
  const key = createPublicKey({ key: tapKey, format: "jwk" });
  for (const { base, signature } of tapSigningExamples) {
    assert.ok(verify(null, Buffer.from(base), key, Buffer.from(signature, "base64")));
    assert.equal(
      verify(null, Buffer.from(base + "tampered"), key, Buffer.from(signature, "base64")),
      false,
    );
  }
});

test("TAP schema rejects ambiguous adapter inputs and unclassified failures", () => {
  for (const mutate of [
    (item) => {
      item.operation = "tap.other";
    },
    (item) => {
      item.input.steps[0].requests[0].body_base64 = "not base64";
    },
    (item) => {
      item.input.steps = [];
    },
    (item) => {
      item.input.steps[0].now_ms = -1;
    },
    (item) => {
      item.expect.result.steps[0].rejected = ["ANY_ERROR"];
    },
    (item) => {
      item.input.expected = true;
    },
    (item) => {
      item.input.resolver = "http";
    },
  ]) {
    const item = structuredClone(tapCases.cases[0]);
    mutate(item);
    assert.throws(() => validate("tap-case", item), /Invalid tap-case/);
  }
});

for (const item of tapCases.cases.filter((item) => item.platform)) {
  test(`TAP key-server script consistency, not SDK verification: ${item.id}`, async () => {
    const platform = await startPlatform(item.platform);
    try {
      for (const { request, response } of item.platform.exchanges) {
        const result = await fetch(platform.baseUrl + request.path, { headers: request.headers });
        assert.equal(result.status, response.status);
        if (response.json) assert.deepEqual(await result.json(), response.json);
        else await result.arrayBuffer();
      }
      await platform.waitComplete(1000);
    } finally {
      await platform.close();
    }
  });
}

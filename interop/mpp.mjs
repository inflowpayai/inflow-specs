import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mppCases } from "../fixtures/mpp.mjs";

export const languages = ["node", "go", "python", "rust"];
const scenarios = ["ready", "pending", "invalid", "settlement-failed", "handler-failed"];
const id = "22222222-2222-4222-8222-222222222222";
const approval = "33333333-3333-4333-8333-333333333333";
const sellerId = "11111111-1111-4111-8111-111111111111";
const config = mppCases.cases
  .flatMap((c) => c.platform?.exchanges ?? [])
  .find((e) => e.request.path === "/v1/mpp/config").response.json;
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function caseList() {
  return languages.flatMap((buyer) =>
    languages.flatMap((seller) =>
      ["charge", "tempo", "subscription", "existing-subscription"].flatMap((variant) => {
        if (
          ["subscription", "existing-subscription"].includes(variant) &&
          ["python", "rust"].includes(seller)
        )
          return [
            {
              buyer,
              seller,
              variant,
              unsupported: `${seller} Seller does not implement subscriptions; upstream limitation`,
            },
          ];
        return scenarios
          .filter((s) => variant !== "existing-subscription" || s !== "pending")
          .map((scenario) => ({ buyer, seller, variant, scenario }));
      }),
    ),
  );
}

export function checkResult(test, result, events) {
  const count = (path) => events.filter((e) => e === `POST ${path}`).length;
  const existing = test.variant === "existing-subscription";
  assert.equal(count(existing ? `/v1/subscriptions/${id}/authorize` : "/v1/transactions/mpp"), 1);
  assert.equal(count(existing ? "/v1/transactions/mpp" : `/v1/subscriptions/${id}/authorize`), 0);
  assert.equal(count("/v1/mpp/validate"), 1);
  const denied = ["invalid", "settlement-failed"].includes(test.scenario);
  assert.equal(result.status, denied ? 402 : test.scenario === "handler-failed" ? 500 : 200);
  assert.equal(count("/handler"), denied ? 0 : 1);
  assert.equal(count("/v1/mpp/broadcast"), test.scenario === "invalid" ? 0 : 1);
  const polls = events.filter((e) => e === `GET /v1/transactions/${id}/mpp`).length;
  assert.equal(polls, test.scenario === "pending" ? 1 : 0);
  if (!denied) {
    assert.deepEqual(JSON.parse(result.body), { paidResource: true });
    assert.ok(events.indexOf("POST /v1/mpp/broadcast") < events.indexOf("POST /handler"));
    if (test.scenario !== "handler-failed") {
      assert.equal(result.receipt?.reference, id, "receipt mismatch");
      assert.equal(result.receipt.status, "success");
      assert.equal(result.receipt.method, test.variant === "tempo" ? "tempo" : "inflow");
    }
  }
}

export function startPeer(command, settings, signal) {
  const child = spawn(command[0], command.slice(1), {
    cwd: command.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "",
    failure;
  const fail = (error) => {
    failure ??= error;
    child.kill("SIGKILL");
  };
  const abort = () => fail(Error("Matrix interrupted"));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stdout.on("data", (data) => {
    stdout += data;
    if (stdout.length > 1048576) fail(Error("Peer stdout exceeded limit"));
  });
  child.stderr.on("data", (data) => {
    stderr += data;
    if (stderr.length > 1048576) fail(Error("Peer stderr exceeded limit"));
  });
  const timer = setTimeout(() => fail(Error("Peer timeout")), 20000);
  const closed = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    }),
  );
  child.stdin.end(JSON.stringify(settings) + "\n");
  return {
    async ready() {
      for (;;) {
        if (failure) throw failure;
        if (stdout.includes("\n")) {
          const value = JSON.parse(stdout.split("\n")[0]);
          const url = new URL(value.url);
          assert.ok(
            url.protocol === "http:" &&
              url.hostname === "127.0.0.1" &&
              !url.username &&
              !url.password,
          );
          return value.url;
        }
        if (child.exitCode !== null || child.signalCode !== null)
          throw Error(`Seller exited: ${stderr}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    async result() {
      const exit = await closed;
      if (failure) throw failure;
      assert.equal(exit.code, 0, `Buyer failed: ${stderr}`);
      return JSON.parse(stdout);
    },
    async stop() {
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
      await closed;
      clearTimeout(kill);
      signal.removeEventListener("abort", abort);
      return { stdout, stderr };
    },
  };
}

async function runCase(test, commands, signal, corruptReceipt = false) {
  const events = [],
    errors = [];
  const evidence = { ...test, events, passed: false };
  let credential;
  const existing = test.variant === "existing-subscription";
  const platform = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const send = (value) => res.end(JSON.stringify(value));
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        assert.ok(size <= 65536, "Platform request exceeded limit");
        chunks.push(chunk);
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      const path = req.url;
      events.push(`${req.method} ${path}`);
      if (path === "/handler") {
        assert.equal(req.method, "POST");
        return send({ ok: true });
      }
      assert.equal(
        req.headers["x-api-key"],
        `test-only-${path.startsWith("/v1/transactions") || path.startsWith("/v1/subscriptions/") ? "buyer" : "seller"}-key`,
      );
      if (path === "/v1/mpp/config") {
        assert.equal(req.method, "GET");
        return send(config);
      }
      if (path === "/v1/transactions/mpp" || path === `/v1/subscriptions/${id}/authorize`) {
        assert.equal(req.method, "POST");
        assert.equal(path, existing ? `/v1/subscriptions/${id}/authorize` : "/v1/transactions/mpp");
        if (existing) assert.deepEqual(Object.keys(body), ["challenge"]);
        const request = JSON.parse(Buffer.from(body.challenge.request, "base64url"));
        assert.equal(body.challenge.method, test.variant === "tempo" ? "tempo" : "inflow");
        assert.equal(
          body.challenge.intent,
          ["subscription", "existing-subscription"].includes(test.variant)
            ? "subscription"
            : "charge",
        );
        assert.equal(request.amount, test.variant === "tempo" ? "10000" : "0.01");
        assert.equal(
          request.currency,
          test.variant === "tempo" ? "0x20c0000000000000000000000000000000000000" : "USDC",
        );
        assert.equal(
          request.recipient,
          test.variant === "tempo" ? "0x1111111111111111111111111111111111111111" : sellerId,
        );
        credential = {
          challenge: body.challenge,
          source: "did:inflow:66666666-6666-4666-8666-666666666666",
          payload: existing
            ? {
                authorizationExpires: body.challenge.expires,
                authorizationId: approval,
                subscriptionId: id,
                transactionId: id,
                authorizationSignature: "synthetic-platform-signature",
              }
            : test.variant === "tempo"
              ? { type: "hash", hash: `0x${"11".repeat(32)}` }
              : { transactionId: id },
        };
        return send(
          existing
            ? { credential: encode(credential) }
            : test.scenario === "pending"
              ? {
                  state: "pending",
                  transactionId: id,
                  approvalId: approval,
                  retryAfterSeconds: 0,
                }
              : { state: "ready", transactionId: id, credential: encode(credential) },
        );
      }
      if (path === `/v1/transactions/${id}/mpp`) {
        assert.equal(req.method, "GET");
        assert.ok(credential);
        return send({ state: "ready", transactionId: id, credential: encode(credential) });
      }
      if (path === "/v1/mpp/validate" || path === "/v1/mpp/broadcast") {
        assert.equal(req.method, "POST");
        assert.ok(credential);
        assert.deepEqual(body.credential, credential);
        const problem = {
          type: "https://paymentauth.org/problems/verification-failed",
          title: "Rejected test payment",
          status: 402,
        };
        if (path.endsWith("/validate"))
          return send(
            test.scenario === "invalid"
              ? { success: false, problem }
              : {
                  success: true,
                  credential,
                  challenge: credential.challenge,
                  source: credential.source,
                  method: credential.challenge.method,
                  intent: credential.challenge.intent,
                  request: JSON.parse(Buffer.from(credential.challenge.request, "base64url")),
                  details: {},
                },
          );
        assert.equal(events.filter((e) => e === "POST /v1/mpp/validate").length, 1);
        return send(
          test.scenario === "settlement-failed"
            ? { problem }
            : {
                receipt: {
                  method: credential.challenge.method,
                  status: "success",
                  reference: corruptReceipt ? approval : id,
                  timestamp: "2026-09-29T00:00:00Z",
                },
              },
        );
      }
      throw Error(`Unexpected platform request: ${req.method} ${path}`);
    } catch (error) {
      errors.push(error.message);
      res.statusCode = 400;
      send({ error: "Unexpected test request" });
    }
  });
  platform.listen(0, "127.0.0.1");
  await once(platform, "listening");
  const settings = {
    Protocol: "mpp",
    Platform: `http://127.0.0.1:${platform.address().port}`,
    Variant: existing ? "subscription" : test.variant,
    ...(existing ? { SubscriptionID: id } : {}),
    HandlerStatus: test.scenario === "handler-failed" ? 500 : 200,
  };
  let seller, buyer;
  try {
    seller = startPeer(commands[test.seller], { ...settings, Role: "seller" }, signal);
    const target = await seller.ready();
    buyer = startPeer(commands[test.buyer], { ...settings, Role: "buyer", Target: target }, signal);
    evidence.result = await buyer.result();
  } catch (error) {
    evidence.error = error.stack;
  } finally {
    evidence.buyer_log = buyer ? await buyer.stop() : null;
    evidence.seller_log = seller ? await seller.stop() : null;
    evidence.platform_errors = errors;
    platform.closeAllConnections();
    await new Promise((r) => platform.close(r));
  }
  if (!evidence.error) {
    try {
      assert.deepEqual(errors, []);
      checkResult(test, evidence.result, events);
      assert.ok(!corruptReceipt, "Corrupted receipt was not rejected");
      evidence.passed = true;
    } catch (error) {
      if (
        corruptReceipt &&
        error.code === "ERR_ASSERTION" &&
        error.message.startsWith("receipt mismatch") &&
        !errors.length
      ) {
        evidence.passed = true;
        evidence.negative_control = "corrupted receipt rejected";
      } else evidence.error = error.stack;
    }
  }
  return evidence;
}

const exec = (cwd, program, args) =>
  execFileSync(program, args, {
    cwd,
    encoding: "utf8",
    timeout: 600000,
    maxBuffer: 32 * 1024 * 1024,
  }).trim();

async function main() {
  const [sdkDirectory, outputDirectory] = process.argv.slice(2);
  assert.ok(
    sdkDirectory && outputDirectory,
    "Usage: node interop/mpp.mjs SDK_PARENT OUTPUT_DIRECTORY",
  );
  const output = resolve(outputDirectory);
  mkdirSync(output);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const pins = JSON.parse(readFileSync(new URL("sdk-lock.json", import.meta.url)));
  const roots = Object.fromEntries(
    languages.map((language) => [language, resolve(sdkDirectory, `inflow-${language}`)]),
  );
  const report = {
    protocol: "mpp",
    contract_revision: exec(root, "git", ["rev-parse", "HEAD"]),
    contract_dirty: !!exec(root, "git", ["status", "--porcelain"]),
    sdk_revisions: pins,
    platform: "Synthetic loopback HTTP; no live signing or settlement",
    cells: [],
    passed: false,
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    for (const language of languages) {
      assert.equal(
        exec(roots[language], "git", ["rev-parse", "HEAD"]),
        pins[language],
        `${language} must match sdk-lock.json`,
      );
      assert.equal(
        exec(roots[language], "git", ["status", "--porcelain"]),
        "",
        `${language} must be clean`,
      );
    }
    const goBinary = join(output, "go-peer");
    exec(roots.go, "go", ["test", "-c", "-race", "-o", goBinary, "./interop"]);
    const { buildAdapter } = await import(
      pathToFileURL(join(roots.rust, "scripts/conformance.mjs"))
    );
    const rustBinary = buildAdapter("peer");
    const python = join(roots.python, ".venv/bin/python");
    const commands = {
      node: [process.execPath, join(roots.rust, "interop/node-peer.mjs"), roots.node],
      go: [goBinary, "--peer"],
      python: [python, "-m", "interop.peer"],
      rust: [rustBinary, "--peer"],
    };
    for (const language of languages) commands[language].cwd = roots[language];
    report.runtimes = {
      node: process.version,
      go: exec(roots.go, "go", ["version"]),
      python: exec(roots.python, python, ["--version"]),
      rust: exec(roots.rust, "rustc", ["--version"]),
    };
    writeFileSync(
      join(output, "node-dependencies.json"),
      exec(roots.node, "pnpm", ["list", "--recursive", "--depth", "Infinity", "--json"]),
    );
    writeFileSync(join(output, "go-dependencies.txt"), exec(roots.go, "go", ["list", "-m", "all"]));
    writeFileSync(
      join(output, "python-dependencies.txt"),
      exec(roots.python, "uv", ["pip", "freeze", "--python", python]),
    );
    writeFileSync(
      join(output, "rust-dependencies.json"),
      exec(roots.rust, "cargo", ["metadata", "--locked", "--format-version=1"]),
    );
    for (const buyer of languages)
      for (const seller of languages) {
        const cell = { buyer, seller, passed: false, cases: [] };
        report.cells.push(cell);
        for (const test of caseList().filter((t) => t.buyer === buyer && t.seller === seller)) {
          if (controller.signal.aborted) throw Error("Matrix interrupted");
          cell.cases.push(
            test.unsupported ? test : await runCase(test, commands, controller.signal),
          );
        }
        cell.cases.push(
          await runCase(
            { buyer, seller, variant: "charge", scenario: "ready" },
            commands,
            controller.signal,
            true,
          ),
        );
        cell.passed = cell.cases.every((test) => test.unsupported || test.passed);
        process.stdout.write(
          `${cell.passed ? "PASS" : "FAIL"} ${buyer} Buyer -> ${seller} Seller\n`,
        );
        writeFileSync(
          join(output, `${buyer}-${seller}.json`),
          JSON.stringify(cell, null, 2) + "\n",
        );
      }
    report.passed = report.cells.length === 16 && report.cells.every((cell) => cell.passed);
  } catch (error) {
    report.error = error.stack;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
    if (!report.passed) process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

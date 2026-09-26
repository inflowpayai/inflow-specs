import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { run, revision } from "../runner/run.mjs";
import { main } from "../runner/cli.mjs";
import { selectCases, validate } from "../runner/validation.mjs";
import { startAdapter } from "../runner/process.mjs";
import { runtimeScenarios } from "../fixtures/runtime.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = fileURLToPath(new URL("fixture-adapter.mjs", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "inflow-conformance-"));
after(() => rm(temporary, { recursive: true, force: true }));
const capabilities = { suites: ["runtime"], supported_features: [], unsupported_features: [] };
const implementation = {
  name: "fixture adapter, not an SDK",
  runtime: process.version,
  packages: { fixture: "unpublished" },
  dependencies: {},
};
function item(id = "echo", value = { text: "hello 雪", amount: "1000000000000000001" }) {
  return {
    id,
    suite: "runtime",
    operation: "fixture.echo",
    input: { value },
    expect: { result: value },
  };
}
function options(mode = "normal", cases = [item()]) {
  return {
    index: { cases },
    capabilities,
    implementation,
    command: [process.execPath, fixture, mode],
    contractRoot: root,
    sdkRoot: root,
    timeoutMs: 2000,
  };
}

test("central comparison passes real process observations without sending expectations", async () => {
  const error = { http_status: 403, code: "SELLER_ACCOUNT_REQUIRED", message: "Seller required" };
  const failed = {
    ...item("negative"),
    operation: "fixture.error",
    input: { value: error },
    expect: { error },
  };
  const report = await run(options("fragmented", [item(), failed, item("null", null)]));
  assert.equal(report.completed, true);
  assert.equal(report.passed, true);
  assert.equal(report.results.length, 3);
  assert.match(report.inputs.index, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.sdk, revision(root));
  validate("report", report);
});

test("mismatch is a completed failed run, not a crash or skip", async () => {
  const report = await run(options("assertion"));
  assert.equal(report.completed, true);
  assert.equal(report.passed, false);
  assert.equal(report.results[0].status, "failed");
  assert.doesNotMatch(JSON.stringify(report), /hello 雪/);
});

test("runner checks real HTTP exchanges as well as adapter observations", async () => {
  const platform = runtimeScenarios["approval.cancel"];
  const value = {
    ...item("http"),
    operation: "fixture.http",
    input: { requests: platform.exchanges.map(({ request }) => request) },
    platform,
    expect: {
      result: platform.exchanges.map(({ response }) => ({
        status: response.status,
        text: Object.hasOwn(response, "json") ? JSON.stringify(response.json) : "",
      })),
    },
  };
  assert.equal((await run(options("normal", [value]))).passed, true);
  const missing = { ...value, operation: "fixture.echo", input: { value: value.expect.result } };
  const failed = await run(options("normal", [missing]));
  assert.equal(failed.completed, true);
  assert.equal(failed.passed, false);
  assert.match(failed.results[0].message, /incomplete/);
  const overridden = { ...value, input: { ...value.input, base_url: "https://invalid.example" } };
  assert.match((await run(options("normal", [overridden]))).runner_error, /base_url/);
  const interrupted = await run({ ...options("hang", [value]), timeoutMs: 100 });
  assert.equal(interrupted.completed, false);
  assert.match(interrupted.runner_error, /timed out/);
});

test("explicit optional omissions coexist with mandatory cases", async () => {
  const config = options("normal", [
    item(),
    { ...item("optional"), feature: "mcp" },
    { ...item("supported"), feature: "subscription" },
  ]);
  config.capabilities = {
    ...capabilities,
    supported_features: ["subscription"],
    unsupported_features: [{ id: "mcp", reason: "Not implemented in fixture" }],
  };
  const report = await run(config);
  assert.equal(report.passed, true);
  assert.deepEqual(
    report.results.map((result) => result.status),
    ["passed", "skipped", "passed"],
  );
});

for (const mode of [
  "crash",
  "early-exit",
  "malformed",
  "invalid-utf8",
  "oversized",
  "oversized-line",
  "diagnostic-flood",
  "wrong-sequence",
  "wrong-case",
  "unknown-field",
  "both",
  "partial",
  "duplicate",
  "delayed-duplicate",
  "exit-failure",
  "unsolicited",
  "exit-after-one",
]) {
  test(`process failure: ${mode}`, async () => {
    const report = await run(options(mode, [item(), item("second")]));
    assert.equal(report.completed, false);
    assert.equal(report.passed, false);
    assert.ok(report.runner_error);
  });
}

for (const mode of ["hang", "linger"]) {
  test(`deadline terminates owned process: ${mode}`, async () => {
    const report = await run({ ...options(mode), timeoutMs: 200 });
    assert.equal(report.completed, false);
    assert.match(report.runner_error, /timed out|did not exit/);
  });
}

test("diagnostics stay outside report and do not corrupt protocol", async () => {
  const report = await run(options("diagnostic"));
  assert.equal(report.passed, true);
  assert.doesNotMatch(JSON.stringify(report), /fixture diagnostic/);
});

test("missing executable is a failed report", async () => {
  const report = await run({ ...options(), command: [join(temporary, "absent")] });
  assert.equal(report.completed, false);
  assert.match(report.runner_error, /could not be started/);
});

test("request and total output bounds", async () => {
  const request = await run(options("normal", [item("large", "x".repeat(1024 * 1024))]));
  assert.match(request.runner_error, /request exceeded/);
  const report = await run(
    options(
      "normal",
      Array.from({ length: 20 }, (_, i) => item(`case-${i}`, "x".repeat(900000))),
    ),
  );
  assert.match(report.runner_error, /total limit/);
  assert.equal(report.passed, false);
});

test("reject invalid selection before executing adapter", () => {
  const index = { cases: [item(), { ...item("optional"), feature: "mcp" }] };
  assert.throws(() => selectCases({ cases: [item(), item()] }, capabilities), /Duplicate case/);
  assert.throws(
    () => selectCases(index, { ...capabilities, suites: ["unknown"] }),
    /Unknown suite/,
  );
  assert.throws(() => selectCases(index, capabilities), /Undeclared feature/);
  assert.throws(
    () => selectCases(index, { ...capabilities, supported_features: ["unknown"] }),
    /Unknown feature/,
  );
  assert.throws(
    () =>
      selectCases(index, {
        ...capabilities,
        supported_features: ["mcp"],
        unsupported_features: [{ id: "mcp", reason: "no" }],
      }),
    /Duplicate feature/,
  );
  assert.throws(
    () =>
      selectCases(index, { ...capabilities, unsupported_features: [{ id: "mcp", reason: " " }] }),
    /Empty omission/,
  );
  assert.throws(
    () =>
      selectCases(index, {
        ...capabilities,
        unsupported_features: [
          { id: "mcp", reason: "no" },
          { id: "mcp", reason: "no" },
        ],
      }),
    /Duplicate feature/,
  );
  assert.throws(
    () =>
      selectCases(
        { cases: [index.cases[1]] },
        { ...capabilities, unsupported_features: [{ id: "mcp", reason: "no" }] },
      ),
    /No executable/,
  );
  assert.throws(() => validate("nonexistent", {}), /unknown schema/);
});

test("schema rejects ambiguous outcomes and unjustified success", async () => {
  const response = { adapter_version: "1", sequence: 1, case_id: "echo", result: null };
  validate("adapter-response", response);
  assert.throws(() =>
    validate("adapter-response", { ...response, error: { code: "bad", message: "bad" } }),
  );
  assert.throws(() => validate("adapter-response", { ...response, status: "passed" }));
  assert.throws(() => validate("adapter-response", { ...response, sequence: 0 }));
  assert.throws(() => validate("case-index", { cases: [] }));
  const report = await run(options());
  assert.throws(() => validate("report", { ...report, completed: false }));
  assert.throws(() =>
    validate("report", {
      ...report,
      results: [{ case_id: "echo", suite: "runtime", status: "skipped", message: "no" }],
    }),
  );
  assert.throws(() =>
    validate("report", {
      ...report,
      results: [{ case_id: "echo", suite: "runtime", status: "failed" }],
    }),
  );
});

test("validate command and deadline without a shell", () => {
  for (const command of [[], [""], "node", [123]])
    assert.throws(() => startAdapter(command, 100), /executable/);
  for (const timeout of [0, -1, NaN, 300001, 1.5])
    assert.throws(() => startAdapter([process.execPath], timeout), /Timeout/);
  assert.throws(() => startAdapter([process.execPath], 100, AbortSignal.abort()), /cancelled/);
});

test("git revision detects clean and dirty sources", async () => {
  const repo = join(temporary, "sdk");
  await mkdir(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ],
    { cwd: repo },
  );
  assert.equal(revision(repo).dirty, false);
  const report = await run({
    ...options(),
    sdkRoot: repo,
    command: [process.execPath, fixture, "change-source", join(repo, "untracked.txt")],
  });
  assert.equal(report.passed, false);
  assert.match(report.runner_error, /Source revision or dirty state changed/);
  assert.equal(revision(repo).dirty, true);
  assert.throws(() => revision(join(temporary, "absent")), /Cannot identify/);
});

test("inputs are snapshotted without mutating or retaining caller-owned data", async () => {
  const config = options();
  config.implementation = structuredClone(implementation);
  config.capabilities = structuredClone(capabilities);
  const original = structuredClone(config);
  const running = run(config);
  config.index.cases[0].expect.result.text = "changed";
  config.implementation.name = "changed";
  config.capabilities.suites.push("changed");
  const report = await running;
  assert.equal(report.passed, true);
  assert.deepEqual(report.implementation, original.implementation);
  assert.deepEqual(report.capabilities, original.capabilities);
  assert.equal(config.index.cases[0].expect.result.text, "changed");
});

async function waitForPid(path) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const pid = Number(await readFile(path, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw new Error("Fixture adapter did not become ready");
}

test("cancellation stops the adapter and returns an incomplete failed report", async () => {
  const ready = join(temporary, "cancel-pid");
  const controller = new AbortController();
  const running = run({
    ...options(),
    command: [process.execPath, fixture, "ready-hang", ready],
    signal: controller.signal,
  });
  let pid;
  try {
    pid = await waitForPid(ready);
  } finally {
    controller.abort();
  }
  const report = await running;
  assert.equal(report.completed, false);
  assert.equal(report.passed, false);
  assert.equal(report.runner_error, "Run cancelled");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

async function cliArgs(name, mode = "normal") {
  const directory = join(temporary, name);
  await mkdir(directory);
  for (const [file, data] of Object.entries({
    cases: { cases: [item()] },
    capabilities,
    implementation,
  }))
    await writeFile(join(directory, `${file}.json`), JSON.stringify(data));
  return [
    "--cases",
    join(directory, "cases.json"),
    "--capabilities",
    join(directory, "capabilities.json"),
    "--implementation",
    join(directory, "implementation.json"),
    "--sdk-root",
    root,
    "--output",
    join(directory, "report.json"),
    "--",
    process.execPath,
    fixture,
    mode,
  ];
}

test("CLI writes private validated report, refuses overwrites, and propagates failures", async () => {
  const args = await cliArgs("cli-success");
  assert.equal(await main(args), 0);
  const output = args[args.indexOf("--output") + 1];
  assert.equal(JSON.parse(await readFile(output, "utf8")).passed, true);
  if (process.platform !== "win32") assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(main(args), { code: "EEXIST" });
  assert.equal(await main(await cliArgs("cli-failure", "assertion")), 1);
  await assert.rejects(main([]), /Usage/);
  await assert.rejects(main(["--"]), /Usage/);
  const invalid = await cliArgs("cli-invalid");
  await writeFile(invalid[1], "invalid");
  await assert.rejects(main(invalid), SyntaxError);
  await writeFile(invalid[1], "x".repeat(10 * 1024 * 1024 + 1));
  await assert.rejects(main(invalid), /10 MiB/);
  invalid[1] = temporary;
  await assert.rejects(main(invalid), /JSON file/);
});

test("CLI executable exit codes and option errors", async () => {
  const cli = fileURLToPath(new URL("../runner/cli.mjs", import.meta.url));
  const execute = (args) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 10000 });
  const args = await cliArgs("executable");
  assert.equal(execute(args).status, 0);
  assert.equal(execute(args).status, 2);
  assert.match(execute(args).stderr, /Report already exists/);
  assert.equal(execute(["--bogus", "--"]).status, 2);
  const failure = await cliArgs("executable-failed", "crash");
  failure.splice(failure.indexOf("--"), 0, "--timeout-ms", "2000");
  assert.equal(execute(failure).status, 1);
});

test("CLI interruption writes failure evidence and leaves no adapter running", async () => {
  const args = await cliArgs("cli-cancel", "ready-hang");
  const ready = join(temporary, "cli-cancel-pid");
  args.push(ready);
  const cli = fileURLToPath(new URL("../runner/cli.mjs", import.meta.url));
  const child = spawn(process.execPath, [cli, ...args], { stdio: "ignore" });
  const closed = once(child, "close");
  let pid;
  try {
    pid = await waitForPid(ready);
    child.kill("SIGTERM");
    const [code] = await closed;
    assert.equal(code, 1);
    const report = JSON.parse(await readFile(args[args.indexOf("--output") + 1], "utf8"));
    assert.equal(report.runner_error, "Run cancelled");
    assert.equal(report.passed, false);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
  }
});

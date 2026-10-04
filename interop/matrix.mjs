import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const languages = ["node", "go", "python", "rust"];

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

const exec = (cwd, program, args) =>
  execFileSync(program, args, {
    cwd,
    encoding: "utf8",
    timeout: 600000,
    maxBuffer: 32 * 1024 * 1024,
  }).trim();

export async function runMatrix(protocol, caseList, runCase, negativeVariant) {
  const [sdkDirectory, outputDirectory] = process.argv.slice(2);
  assert.ok(
    sdkDirectory && outputDirectory,
    `Usage: node interop/${protocol}.mjs SDK_PARENT OUTPUT_DIRECTORY`,
  );
  const output = resolve(outputDirectory);
  mkdirSync(output);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const pins = JSON.parse(readFileSync(new URL("sdk-lock.json", import.meta.url)));
  const roots = Object.fromEntries(
    languages.map((language) => [language, resolve(sdkDirectory, `inflow-${language}`)]),
  );
  const report = {
    protocol,
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
            { buyer, seller, variant: negativeVariant, scenario: "ready" },
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

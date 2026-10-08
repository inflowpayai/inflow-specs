import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { languages } from "./matrix.mjs";
import { runCase as mpp } from "./mpp.mjs";
import { runCase as x402 } from "./x402.mjs";

export function releaseCases() {
  return languages.flatMap((language) =>
    ["mpp", "x402"].flatMap((protocol) =>
      ["ready", "invalid"].map((scenario) => ({
        buyer: language,
        seller: language,
        protocol,
        variant: protocol === "mpp" ? "charge" : "balance",
        scenario,
      })),
    ),
  );
}

const run = (cwd, command, args, env = {}) =>
  execFileSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 600000,
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");

async function main() {
  const [sdkDirectory, outputDirectory] = process.argv.slice(2);
  assert.ok(
    sdkDirectory && outputDirectory,
    "Usage: node interop/releases.mjs SDK_PARENT NEW_OUTPUT_DIRECTORY",
  );
  const output = resolve(outputDirectory);
  mkdirSync(output);
  const roots = Object.fromEntries(languages.map((l) => [l, resolve(sdkDirectory, `inflow-${l}`)]));
  const versions = JSON.parse(readFileSync(new URL("releases.json", import.meta.url)));
  const pins = versions.peerRevisions;
  const root = fileURLToPath(new URL("..", import.meta.url));
  const report = {
    contract_revision: run(root, "git", ["rev-parse", "HEAD"]),
    contract_dirty: !!run(root, "git", ["status", "--porcelain"]),
    peer_revisions: pins,
    versions,
    platform: "Synthetic loopback HTTP; registry-installed SDKs; no live payments",
    cases: [],
    passed: false,
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    for (const l of languages) {
      assert.equal(run(roots[l], "git", ["rev-parse", "HEAD"]), pins[l]);
      assert.equal(run(roots[l], "git", ["status", "--porcelain"]), "");
    }
    const commands = {};
    for (const language of languages) {
      if (controller.signal.aborted) throw Error("Consumer checks interrupted");
      const dir = join(output, language);
      mkdirSync(dir);
      process.stdout.write(`Installing ${language} registry consumer\n`);
      if (language === "node") {
        const dependencies = {
          ...versions.node,
          "@x402/core": "2.27.0",
          "@x402/express": "2.27.0",
          express: "5.2.1",
          mppx: "0.8.17",
        };
        json(join(dir, "package.json"), { private: true, type: "module", dependencies });
        run(dir, "npm", ["install", "--ignore-scripts", "--registry=https://registry.npmjs.org"]);
        mkdirSync(join(dir, "packages"));
        for (const [name, version] of Object.entries(versions.node)) {
          const installed = join(dir, "node_modules", name);
          assert.equal(JSON.parse(readFileSync(join(installed, "package.json"))).version, version);
          // The existing peer expects a packages directory; every link points inside this registry installation.
          symlinkSync(installed, join(dir, "packages", name.split("/")[1]), "dir");
        }
        mkdirSync(join(dir, "examples/x402-seller-express"), { recursive: true });
        json(join(dir, "examples/x402-seller-express/package.json"), {
          private: true,
          type: "module",
        });
        copyFileSync(join(roots.rust, "interop/node-peer.mjs"), join(dir, "peer.mjs"));
        commands.node = [process.execPath, join(dir, "peer.mjs"), dir];
        json(
          join(output, "node-dependencies.json"),
          JSON.parse(run(dir, "npm", ["ls", "--all", "--json"])),
        );
      } else if (language === "go") {
        copyFileSync(join(roots.go, "interop/peer_test.go"), join(dir, "peer_test.go"));
        const env = {
          GOWORK: "off",
          GOPROXY: "https://proxy.golang.org",
          GOPRIVATE: "",
          GONOPROXY: "",
          GONOSUMDB: "",
          GOSUMDB: "sum.golang.org",
        };
        run(dir, "go", ["mod", "init", "example.com/inflow-release-peer"], env);
        run(
          dir,
          "go",
          ["mod", "edit", `-require=github.com/inflowpayai/inflow-go@${versions.go}`],
          env,
        );
        run(dir, "go", ["mod", "tidy"], env);
        const module = JSON.parse(
          run(dir, "go", ["list", "-m", "-json", "github.com/inflowpayai/inflow-go"], env),
        );
        assert.equal(module.Version, versions.go);
        assert.ok(!module.Replace);
        run(dir, "go", ["test", "-c", "-race", "-o", "peer", "."], env);
        commands.go = [join(dir, "peer"), "--peer"];
        writeFileSync(
          join(output, "go-dependencies.txt"),
          run(dir, "go", ["list", "-m", "all"], env),
        );
      } else if (language === "python") {
        run(dir, "uv", ["venv", ".venv"]);
        const python = join(dir, ".venv/bin/python");
        run(dir, "uv", [
          "pip",
          "install",
          "--python",
          python,
          "--index-url",
          "https://pypi.org/simple",
          `inflowpay[mpp,x402,fastapi]==${versions.python}`,
          "uvicorn==0.54.0",
        ]);
        assert.equal(
          run(dir, python, [
            "-I",
            "-c",
            "import importlib.metadata; print(importlib.metadata.version('inflowpay'))",
          ]),
          versions.python,
        );
        report.python = run(dir, python, ["--version"]);
        copyFileSync(join(roots.python, "interop/peer.py"), join(dir, "peer.py"));
        commands.python = [python, "-I", join(dir, "peer.py")];
        writeFileSync(
          join(output, "python-dependencies.txt"),
          run(dir, "uv", ["pip", "freeze", "--python", python]),
        );
      } else {
        mkdirSync(join(dir, "src/peer"), { recursive: true });
        mkdirSync(join(dir, "src/adapter"));
        copyFileSync(
          join(roots.rust, "conformance/tests/peer/main.rs"),
          join(dir, "src/peer/main.rs"),
        );
        copyFileSync(
          join(roots.rust, "conformance/tests/adapter/transport.rs"),
          join(dir, "src/adapter/transport.rs"),
        );
        const crates = [
          "inflow-core",
          "inflow-mpp",
          "inflow-mpp-buyer",
          "inflow-mpp-seller",
          "inflow-x402",
          "inflow-x402-buyer",
          "inflow-x402-seller",
          "inflow-x402-axum",
        ];
        writeFileSync(
          join(dir, "Cargo.toml"),
          `[package]\nname="inflow-release-peer"\nversion="0.0.0"\nedition="2024"\n[[bin]]\nname="peer"\npath="src/peer/main.rs"\n[dependencies]\n${crates.map((c) => `${c}="=${versions.rust}"`).join("\n")}\naxum={version="0.8",default-features=false,features=["http1","tokio"]}\nhttp="1"\nreqwest={version="0.13",default-features=false,features=["rustls","stream"]}\nserde_json="1"\ntokio={version="1",features=["macros","rt","sync","time"]}\ntokio-util={version="0.7",features=["rt"]}\nurl="2"\n`,
        );
        const target = resolve(process.env.CARGO_TARGET_DIR ?? join(dir, "target"));
        run(dir, "cargo", ["+1.93.0", "generate-lockfile"]);
        const metadata = JSON.parse(
          run(dir, "cargo", ["+1.93.0", "metadata", "--locked", "--format-version=1"]),
        );
        for (const name of crates) {
          const pkg = metadata.packages.find((p) => p.name === name);
          assert.equal(pkg?.version, versions.rust);
          assert.equal(pkg.source, "registry+https://github.com/rust-lang/crates.io-index");
        }
        json(join(output, "rust-dependencies.json"), metadata);
        run(dir, "cargo", [
          "+1.93.0",
          "build",
          "--locked",
          "--target-dir",
          target,
          "--bin",
          "peer",
        ]);
        commands.rust = [join(target, "debug/peer"), "--peer"];
      }
      commands[language].cwd = dir;
    }
    report.runtimes = {
      node: process.version,
      go: run(output, "go", ["version"]),
      python: report.python,
      rust: run(output, "rustc", ["+1.93.0", "--version"]),
    };
    delete report.python;
    for (const test of releaseCases()) {
      if (controller.signal.aborted) throw Error("Consumer checks interrupted");
      const result = await (test.protocol === "mpp" ? mpp : x402)(
        test,
        commands,
        controller.signal,
      );
      report.cases.push(result);
      process.stdout.write(
        `${result.passed ? "PASS" : "FAIL"} ${test.buyer} ${test.protocol} ${test.scenario}\n`,
      );
    }
    report.passed = report.cases.length === 16 && report.cases.every((c) => c.passed);
  } catch (error) {
    report.error = error.stack;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    json(join(output, "report.json"), report);
    if (!report.passed) process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

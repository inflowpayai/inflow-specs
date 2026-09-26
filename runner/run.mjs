import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { startAdapter } from "./process.mjs";
import { selectCases, validate } from "./validation.mjs";

export function revision(directory) {
  const options = {
    cwd: directory,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  };
  try {
    return {
      commit: execFileSync("git", ["rev-parse", "HEAD"], options).trim(),
      dirty:
        execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], options).length >
        0,
    };
  } catch {
    throw new Error("Cannot identify source revision from the supplied directory");
  }
}

export async function run({
  index,
  capabilities,
  implementation,
  command,
  contractRoot,
  sdkRoot,
  timeoutMs = 10000,
  signal,
}) {
  index = structuredClone(index);
  capabilities = structuredClone(capabilities);
  implementation = structuredClone(implementation);
  const cases = selectCases(index, capabilities);
  validate("implementation", implementation);
  const report = {
    report_version: "1",
    contract: revision(contractRoot),
    sdk: revision(sdkRoot),
    implementation: structuredClone(implementation),
    capabilities: structuredClone(capabilities),
    inputs: Object.fromEntries(
      Object.entries({ index, capabilities, implementation }).map(([key, value]) => [
        key,
        createHash("sha256").update(JSON.stringify(value)).digest("hex"),
      ]),
    ),
    completed: false,
    passed: false,
    results: cases.map(({ item, omission }) => ({
      case_id: item.id,
      suite: item.suite,
      status: omission === null ? "not_run" : "skipped",
      ...(omission === null ? {} : { message: omission }),
    })),
  };
  let adapter;
  try {
    adapter = startAdapter(command, timeoutMs, signal);
    for (let index = 0; index < cases.length; index++) {
      const { item, omission } = cases[index];
      if (omission !== null) continue;
      const response = await adapter.exchange({
        adapter_version: "1",
        sequence: index + 1,
        case_id: item.id,
        operation: item.operation,
        input: item.input,
      });
      const observed = Object.hasOwn(response, "result")
        ? { result: response.result }
        : { error: response.error };
      const matches = isDeepStrictEqual(observed, item.expect);
      report.results[index].status = matches ? "passed" : "failed";
      if (!matches)
        report.results[index].message = "SDK observation did not match the expected outcome";
    }
    await adapter.finish();
    if (
      !isDeepStrictEqual(report.contract, revision(contractRoot)) ||
      !isDeepStrictEqual(report.sdk, revision(sdkRoot))
    ) {
      throw new Error("Source revision or dirty state changed during the run");
    }
    report.completed = true;
    report.passed = report.results.every((item) => item.status !== "failed");
  } catch (error) {
    report.runner_error = error.message;
  } finally {
    await adapter?.stop();
  }
  validate("report", report);
  return report;
}

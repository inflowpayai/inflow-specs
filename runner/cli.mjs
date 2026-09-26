import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { run } from "./run.mjs";

const usage =
  "Usage: pnpm conformance --cases FILE --capabilities FILE --implementation FILE --sdk-root DIR --output NEW_FILE [--timeout-ms 10000] -- EXECUTABLE [ARGUMENT ...]";

async function readJson(path) {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 10 * 1024 * 1024)
      throw new Error("Input must be a JSON file no larger than 10 MiB");
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}

export async function main(args) {
  const separator = args.indexOf("--");
  if (separator < 0) throw new Error(usage);
  const { values } = parseArgs({
    args: args.slice(0, separator),
    options: Object.fromEntries(
      ["cases", "capabilities", "implementation", "sdk-root", "output", "timeout-ms"].map((key) => [
        key,
        { type: "string" },
      ]),
    ),
  });
  if (
    ["cases", "capabilities", "implementation", "sdk-root", "output"].some((key) => !values[key]) ||
    args.length === separator + 1
  )
    throw new Error(usage);
  const index = await readJson(values.cases);
  const capabilities = await readJson(values.capabilities);
  const implementation = await readJson(values.implementation);
  const output = await open(values.output, "wx", 0o600);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const report = await run({
      index,
      capabilities,
      implementation,
      command: args.slice(separator + 1),
      contractRoot: fileURLToPath(new URL("..", import.meta.url)),
      sdkRoot: values["sdk-root"],
      timeoutMs: values["timeout-ms"] === undefined ? 10000 : Number(values["timeout-ms"]),
      signal: controller.signal,
    });
    await output.writeFile(JSON.stringify(report, null, 2) + "\n");
    return report.passed ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    await output.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error.code === "EEXIST" ? "Report already exists; choose a new output file" : error.message}\n`,
    );
    process.exitCode = 2;
  }
}

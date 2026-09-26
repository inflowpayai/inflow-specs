import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";

const mode = process.argv[2] ?? "normal";
if (mode === "ready-hang") {
  await writeFile(process.argv[3], String(process.pid));
  setInterval(() => {}, 1000);
}
if (mode === "change-source") await writeFile(process.argv[3], "fixture");
if (mode === "hang") setInterval(() => {}, 1000);
if (mode === "unsolicited") process.stdout.write('{"unexpected":true}\n');
let count = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  count++;
  if (mode === "hang" || mode === "ready-hang") continue;
  if (mode === "crash") process.exit(3);
  if (mode === "early-exit") process.exit(0);
  if (mode === "malformed") {
    process.stdout.write("not json\n");
    continue;
  }
  if (mode === "invalid-utf8") {
    process.stdout.write(Buffer.from([0xff, 10]));
    continue;
  }
  if (mode === "oversized") {
    process.stdout.write("x".repeat(1024 * 1024 + 1));
    continue;
  }
  if (mode === "oversized-line") {
    process.stdout.write("x".repeat(1024 * 1024 + 1) + "\n");
    continue;
  }
  if (mode === "diagnostic-flood") {
    process.stderr.write("x".repeat(65537));
    continue;
  }
  if (mode === "diagnostic") process.stderr.write("fixture diagnostic\n");
  const response = {
    adapter_version: "1",
    sequence: request.sequence,
    case_id: request.case_id,
    ...(request.operation === "fixture.error"
      ? { error: request.input.value }
      : { result: request.input.value }),
  };
  if (request.operation === "fixture.http") {
    const observed = [];
    for (const input of request.input.requests) {
      const result = await fetch(request.input.base_url + input.path, {
        method: input.method,
        headers: input.headers,
      });
      observed.push({ status: result.status, text: await result.text() });
    }
    response.result = observed;
  }
  if (mode === "wrong-sequence") response.sequence++;
  if (mode === "wrong-case") response.case_id = "different";
  if (mode === "unknown-field") response.extra = true;
  if (mode === "both") response.error = { code: "BAD", message: "bad" };
  if (mode === "assertion") response.result = "wrong";
  const encoded = JSON.stringify(response);
  if (mode === "partial") {
    process.stdout.write(encoded);
    break;
  }
  if (mode === "fragmented") {
    const bytes = Buffer.from(encoded + "\n");
    for (let offset = 0; offset < bytes.length; offset += 7)
      process.stdout.write(bytes.subarray(offset, offset + 7));
  } else {
    process.stdout.write(encoded + "\n");
  }
  if (mode === "duplicate") process.stdout.write(encoded + "\n");
  if (mode === "delayed-duplicate") setTimeout(() => process.stdout.write(encoded + "\n"), 10);
  if (mode === "mark-response") await writeFile(process.argv[3], "ready");
  if (mode === "late-http")
    setTimeout(
      () =>
        fetch(request.input.base_url + "/cleanup")
          .then((value) => value.text())
          .catch(() => {
            process.exitCode = 1;
          }),
      20,
    );
  if (mode === "exit-after-one" && count === 1) process.exit(0);
}
if (mode === "linger") setInterval(() => {}, 1000);
if (mode === "exit-failure") process.exitCode = 2;

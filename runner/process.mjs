import { spawn } from "node:child_process";
import { validate } from "./validation.mjs";

const MAX_LINE = 1024 * 1024;
const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_DIAGNOSTICS = 64 * 1024;

export function startAdapter(command, timeoutMs, signal) {
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((part) => typeof part !== "string") ||
    !command[0]
  ) {
    throw new Error("Adapter must be an executable and argument list");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw new Error("Timeout must be an integer from 1 to 300000 milliseconds");
  }
  if (signal?.aborted) throw new Error("Run cancelled");
  const child = spawn(command[0], command.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  let pending;
  let buffer = Buffer.alloc(0);
  let outputBytes = 0;
  let diagnosticBytes = 0;
  let failure;
  let exited = false;
  let stopping = false;
  let rejectFailure;
  const failed = new Promise((_, reject) => {
    rejectFailure = reject;
  });
  failed.catch(() => {});
  function fail(message) {
    if (failure) return;
    failure = new Error(message);
    rejectFailure(failure);
  }
  const cancel = () => fail("Run cancelled");
  signal?.addEventListener("abort", cancel, { once: true });
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      exited = true;
      if (!stopping && (code !== 0 || signal)) fail("Adapter exited unsuccessfully");
      if (!stopping && (pending || buffer.length))
        fail("Adapter exited without a complete response");
      resolve();
    });
  });
  child.on("error", () => fail("Adapter could not be started"));
  child.stdin.on("error", () => fail("Adapter input stream failed"));
  child.stdout.on("error", () => fail("Adapter output stream failed"));
  child.stderr.on("error", () => fail("Adapter diagnostic stream failed"));
  child.stderr.on("data", (chunk) => {
    diagnosticBytes += chunk.length;
    if (diagnosticBytes > MAX_DIAGNOSTICS) fail("Adapter diagnostic output exceeded the limit");
  });
  child.stdout.on("data", (chunk) => {
    if (failure) return;
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT) return fail("Adapter output exceeded the total limit");
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const newline = buffer.indexOf(10);
      if (newline < 0) {
        if (buffer.length > MAX_LINE) fail("Adapter response exceeded the line limit");
        return;
      }
      if (newline > MAX_LINE) return fail("Adapter response exceeded the line limit");
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (!pending) return fail("Adapter returned an unsolicited or duplicate response");
      let response;
      try {
        response = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
        validate("adapter-response", response);
      } catch {
        return fail("Adapter returned an invalid response");
      }
      if (
        response.sequence !== pending.request.sequence ||
        response.case_id !== pending.request.case_id
      ) {
        return fail("Adapter response identity did not match the request");
      }
      const { resolve } = pending;
      pending = undefined;
      resolve(response);
    }
  });

  async function bounded(promise, message) {
    let timer;
    try {
      return await Promise.race([
        promise,
        failed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async exchange(request) {
      validate("adapter-request", request);
      if (failure) throw failure;
      if (exited) throw new Error("Adapter exited before the next request");
      const line = JSON.stringify(request) + "\n";
      if (Buffer.byteLength(line) > MAX_LINE)
        throw new Error("Adapter request exceeded the line limit");
      const response = new Promise((resolve) => {
        pending = { request, resolve };
      });
      child.stdin.write(line);
      return bounded(response, "Adapter response timed out");
    },
    async finish() {
      child.stdin.end();
      await bounded(closed, "Adapter did not exit after input closed");
      if (failure) throw failure;
    },
    async stop() {
      stopping = true;
      signal?.removeEventListener("abort", cancel);
      if (!exited) {
        child.kill("SIGKILL");
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
      await closed;
    },
  };
}

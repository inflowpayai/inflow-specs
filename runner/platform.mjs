import { createServer } from "node:http";
import { once } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { validate } from "./validation.mjs";

const MAX_BODY = 65536;

export async function startPlatform(configuration) {
  const script = structuredClone(configuration);
  validate("platform", script);
  if (Buffer.byteLength(JSON.stringify(script)) > 1024 * 1024)
    throw new Error("Platform script exceeds 1 MiB");
  for (const { response } of script.exchanges) {
    if (
      (response.status === 204 || response.status === 304) &&
      (Object.hasOwn(response, "json") || Object.hasOwn(response, "text"))
    )
      throw new Error("Body is not permitted for this response status");
    if (
      Object.keys(response.headers ?? {}).some((name) =>
        ["connection", "content-length", "transfer-encoding"].includes(name),
      )
    )
      throw new Error("Response framing headers are controlled by the platform");
  }
  let cursor = 0;
  let active = 0;
  let failure;
  let closing = false;
  const requests = [];
  const timers = new Set();
  const activeSockets = new Map();
  const fail = (message) => {
    failure ??= new Error(message);
  };
  const server = createServer((request, response) => {
    const position = cursor++;
    const exchange = script.exchanges[position];
    active++;
    activeSockets.set(request.socket, (activeSockets.get(request.socket) ?? 0) + 1);
    requests.push({ method: request.method, path: request.url });
    if (requests.length > 200) requests.pop();
    response.on("close", () => {
      active--;
      const count = activeSockets.get(request.socket) - 1;
      if (count) activeSockets.set(request.socket, count);
      else activeSockets.delete(request.socket);
    });
    request.on("error", () => {
      if (!closing) fail("Platform request stream failed");
    });
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        fail("Platform request body exceeds 64 KiB");
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => {
      const reject = () => {
        fail(`Unexpected platform request at exchange ${position + 1}`);
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("Conformance request mismatch");
      };
      if (!exchange) return reject();
      const expected = exchange.request;
      const headers = { authorization: null, "x-api-key": null, ...expected.headers };
      if (
        request.method !== expected.method ||
        request.url !== expected.path ||
        Object.entries(headers).some(([key, value]) => {
          const actual = request.headersDistinct[key];
          return value === null
            ? actual !== undefined
            : actual?.length !== 1 || actual[0] !== value;
        })
      )
        return reject();
      try {
        if (Object.hasOwn(expected, "json")) {
          const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
          if (!isDeepStrictEqual(JSON.parse(body), expected.json)) return reject();
        } else if (size !== 0) return reject();
      } catch {
        return reject();
      }
      const reply = () => {
        if (closing || response.destroyed) return;
        const configured = exchange.response;
        if (configured.disconnect) return response.destroy();
        const json = Object.hasOwn(configured, "json");
        response.sendDate = false;
        response.writeHead(configured.status, {
          ...(json ? { "content-type": "application/json" } : {}),
          ...configured.headers,
        });
        response.end(json ? JSON.stringify(configured.json) : configured.text);
      };
      if (exchange.response.delay_ms) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          reply();
        }, exchange.response.delay_ms);
        timers.add(timer);
      } else reply();
    });
  });
  server.requestTimeout = 2000;
  server.headersTimeout = 2000;
  server.setTimeout(2000, (socket) => {
    if (!closing && activeSockets.has(socket)) fail("Platform request timed out");
    socket.destroy();
  });
  server.on("clientError", (_, socket) => {
    if (!closing) fail("Malformed platform HTTP request");
    socket.destroy();
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests: () => structuredClone(requests),
    assertComplete() {
      if (failure) throw failure;
      if (cursor !== script.exchanges.length || active !== 0)
        throw new Error("Platform exchanges are incomplete");
    },
    async close() {
      if (closing) return;
      closing = true;
      for (const timer of timers) clearTimeout(timer);
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

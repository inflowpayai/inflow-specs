import assert from "node:assert/strict";
import { connect } from "node:net";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { startPlatform } from "../runner/platform.mjs";
import { runtimeScenarios } from "../fixtures/runtime.mjs";

const exchange = (request = {}, response = {}) => ({
  request: { method: "GET", path: "/test", ...request },
  response: { status: 200, json: { ok: true }, ...response },
});
const script = (...exchanges) => ({ exchanges });
const send = (base, expected) =>
  fetch(base + expected.path, {
    method: expected.method,
    headers: Object.fromEntries(
      Object.entries(expected.headers ?? {}).filter(([, v]) => v !== null),
    ),
    ...(Object.hasOwn(expected, "json") ? { body: JSON.stringify(expected.json) } : {}),
  });

for (const [name, scenario] of Object.entries(runtimeScenarios)) {
  test(`source-shaped exchange fixture: ${name}`, async () => {
    const platform = await startPlatform(scenario);
    try {
      for (const { request, response } of scenario.exchanges) {
        const actual = await send(platform.baseUrl, request);
        assert.equal(actual.status, response.status);
        for (const [header, value] of Object.entries(response.headers ?? {}))
          assert.equal(actual.headers.get(header), value);
        if (Object.hasOwn(response, "json")) assert.deepEqual(await actual.json(), response.json);
        else assert.equal(await actual.text(), "");
      }
      platform.assertComplete();
      assert.equal(platform.requests().length, scenario.exchanges.length);
      assert.doesNotMatch(JSON.stringify(platform.requests()), /test-only/);
    } finally {
      await platform.close();
    }
  });
}

test("checks method, exact path/query, body, and credential headers", async () => {
  for (const changed of [
    { method: "POST" },
    { path: "/test?extra=1" },
    { headers: { authorization: "Bearer unexpected" } },
    { headers: { "x-api-key": "unexpected" } },
    { headers: { accept: "text/plain" } },
  ]) {
    const platform = await startPlatform(
      script(exchange({ headers: { accept: "application/json" } })),
    );
    try {
      const response = await send(platform.baseUrl, { method: "GET", path: "/test", ...changed });
      assert.equal(response.status, 500);
      await response.text();
      assert.throws(() => platform.assertComplete(), /Unexpected/);
    } finally {
      await platform.close();
    }
  }
  for (const body of ['{"value":2}', "broken", Buffer.from([255])]) {
    const platform = await startPlatform(script(exchange({ method: "POST", json: { value: 1 } })));
    try {
      const response = await fetch(platform.baseUrl + "/test", { method: "POST", body });
      assert.equal(response.status, 500);
      await response.text();
      assert.throws(() => platform.assertComplete(), /Unexpected/);
    } finally {
      await platform.close();
    }
  }
});

test("matches JSON structurally and distinguishes no body from null", async () => {
  const platform = await startPlatform(
    script(
      exchange({ method: "POST", json: { a: 1, b: 2 } }),
      exchange({ method: "POST", json: null }),
      exchange({ method: "POST" }),
    ),
  );
  try {
    for (const body of ['{"b":2,"a":1}', "null", "null"]) {
      const result = await fetch(platform.baseUrl + "/test", { method: "POST", body });
      assert.equal(result.status, body === "null" && platform.requests().length === 3 ? 500 : 200);
      await result.text();
    }
    assert.throws(() => platform.assertComplete(), /Unexpected/);
  } finally {
    await platform.close();
  }
});

test("missing and extra requests fail instead of silently reusing a response", async () => {
  const platform = await startPlatform(script(exchange()));
  try {
    assert.throws(() => platform.assertComplete(), /incomplete/);
    await (await fetch(platform.baseUrl + "/test")).text();
    platform.assertComplete();
    await (await fetch(platform.baseUrl + "/test")).text();
    assert.throws(() => platform.assertComplete(), /Unexpected/);
  } finally {
    await platform.close();
  }
});

test("duplicate credentials cannot hide behind the first header value", async () => {
  const platform = await startPlatform(
    script(exchange({ headers: { authorization: "Bearer test-only-token" } })),
  );
  try {
    const request = httpRequest(platform.baseUrl + "/test", {
      headers: [
        "Host",
        new URL(platform.baseUrl).host,
        "Authorization",
        "Bearer test-only-token",
        "Authorization",
        "Bearer extra-token",
      ],
    });
    const received = once(request, "response");
    request.end();
    const [response] = await received;
    response.resume();
    await once(response, "end");
    assert.equal(response.statusCode, 500);
    assert.throws(() => platform.assertComplete(), /Unexpected/);
  } finally {
    await platform.close();
  }
});

test("independent local environments and caller-owned configuration remain isolated", async () => {
  const config = script(exchange({ headers: { "x-api-key": "test-only-production" } }));
  const first = await startPlatform(config);
  const second = await startPlatform(
    script(exchange({ headers: { "x-api-key": "test-only-sandbox" } })),
  );
  try {
    assert.notEqual(first.baseUrl, second.baseUrl);
    assert.match(first.baseUrl, /^http:\/\/127\.0\.0\.1:/);
    config.exchanges[0].response.json.ok = false;
    assert.deepEqual(
      await (
        await fetch(first.baseUrl + "/test", {
          headers: { "x-api-key": "test-only-production" },
        })
      ).json(),
      { ok: true },
    );
    await (
      await fetch(second.baseUrl + "/test", { headers: { "x-api-key": "test-only-sandbox" } })
    ).text();
    first.assertComplete();
    second.assertComplete();
    first.requests()[0].path = "changed";
    assert.equal(first.requests()[0].path, "/test");
  } finally {
    await first.close();
    await second.close();
  }
});

test("delay, malformed JSON, disconnect, and cancellation are bounded faults", async () => {
  const platform = await startPlatform(
    script(
      exchange({}, { delay_ms: 20 }),
      { request: { method: "GET", path: "/test" }, response: { status: 200, text: "broken" } },
      exchange({}, { disconnect: true }),
      exchange({}, { delay_ms: 1000 }),
    ),
  );
  try {
    const before = performance.now();
    await (await fetch(platform.baseUrl + "/test")).text();
    assert.ok(performance.now() - before >= 15);
    await assert.rejects((await fetch(platform.baseUrl + "/test")).json(), SyntaxError);
    await assert.rejects(fetch(platform.baseUrl + "/test"));
    const pending = fetch(platform.baseUrl + "/test", { signal: AbortSignal.timeout(50) });
    await assert.rejects(pending);
    await delay(20);
    platform.assertComplete();
  } finally {
    await platform.close();
    await platform.close();
  }
  await assert.rejects(fetch(platform.baseUrl + "/test"));
});

test("rejects invalid scripts and HTTP framing overrides before listening", async () => {
  for (const config of [
    script(),
    script(exchange({}, { status: 199 })),
    script(exchange({}, { text: "also json" })),
    script(exchange({}, { delay_ms: 1001 })),
    script(exchange({}, { headers: { "x-bad": "bad\r\nheader" } })),
    script(exchange({}, { status: 204 })),
    script(exchange({}, { status: 304 })),
    script(exchange({}, { headers: { "content-length": "5" } })),
    script(exchange({}, { json: "x".repeat(1024 * 1024) })),
  ])
    await assert.rejects(startPlatform(config));
});

test("oversized bodies and malformed HTTP cannot pass a scenario", async () => {
  const platform = await startPlatform(script(exchange({ method: "POST" })));
  try {
    await assert.rejects(
      fetch(platform.baseUrl + "/test", { method: "POST", body: "x".repeat(65537) }),
    );
    assert.throws(() => platform.assertComplete(), /64 KiB/);
  } finally {
    await platform.close();
  }
  const malformed = await startPlatform(script(exchange()));
  try {
    const socket = connect(Number(new URL(malformed.baseUrl).port), "127.0.0.1");
    const closed = once(socket, "close");
    socket.write("INVALID HTTP\r\n\r\n");
    await closed;
    assert.throws(() => malformed.assertComplete(), /Malformed/);
  } finally {
    await malformed.close();
  }
});

test("stalled request bodies time out and concurrent requests reserve distinct exchanges", async () => {
  const stalled = await startPlatform(script(exchange({ method: "POST", json: {} })));
  try {
    const socket = connect(Number(new URL(stalled.baseUrl).port), "127.0.0.1");
    const closed = once(socket, "close");
    socket.write("POST /test HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{");
    await closed;
    assert.throws(() => stalled.assertComplete(), /timed out|stream failed/);
  } finally {
    await stalled.close();
  }

  const concurrent = await startPlatform(
    script(exchange({ path: "/first" }, { delay_ms: 100 }), exchange({ path: "/second" })),
  );
  try {
    const first = fetch(concurrent.baseUrl + "/first").then((response) => response.text());
    for (let i = 0; i < 100 && concurrent.requests().length === 0; i++) await delay(5);
    assert.equal(concurrent.requests().length, 1);
    assert.throws(() => concurrent.assertComplete(), /incomplete/);
    await (await fetch(concurrent.baseUrl + "/second")).text();
    await first;
    concurrent.assertComplete();
  } finally {
    await concurrent.close();
  }
});

test("shutdown closes active sockets and cancels delayed responses", async () => {
  const platform = await startPlatform(script(exchange({}, { delay_ms: 1000 })));
  const pending = assert.rejects(fetch(platform.baseUrl + "/test"));
  for (let i = 0; i < 100 && platform.requests().length === 0; i++) await delay(5);
  await platform.close();
  await pending;
});

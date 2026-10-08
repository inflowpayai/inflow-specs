import assert from "node:assert/strict";
import { test } from "node:test";
import { caseList, checkResult } from "../interop/mpp.mjs";
import { languages, startPeer } from "../interop/matrix.mjs";

const id = "22222222-2222-4222-8222-222222222222";
const testCase = { buyer: "node", seller: "go", variant: "charge", scenario: "ready" };
const events = [
  "POST /v1/transactions/mpp",
  "POST /v1/mpp/validate",
  "POST /v1/mpp/broadcast",
  "POST /handler",
];
const result = {
  status: 200,
  body: '{"paidResource":true}',
  receipt: { method: "inflow", status: "success", reference: id },
};

test("peer uses real pipes and cleans up an idle Seller", async () => {
  const peer = startPeer(
    [
      process.execPath,
      "-e",
      `process.stdin.once('data', () => {
    console.log(JSON.stringify({url:'http://127.0.0.1:1234/paid'})); setInterval(()=>{},1000);
  })`,
    ],
    {},
    new AbortController().signal,
  );
  try {
    assert.equal(await peer.ready(), "http://127.0.0.1:1234/paid");
  } finally {
    const logs = await peer.stop();
    assert.match(logs.stdout, /127.0.0.1/);
  }
});

test("peer rejects early exit, invalid output, missing executable and nonlocal Seller URLs", async () => {
  const cases = [
    { command: [process.execPath, "-e", "process.exit(7)"], operation: "ready" },
    { command: [process.execPath, "-e", "console.log('not-json')"], operation: "result" },
    {
      command: [process.execPath, "-e", "console.log(JSON.stringify({url:'https://example.com'}))"],
      operation: "ready",
    },
    { command: ["/nonexistent-inflow-matrix-peer"], operation: "result" },
  ];
  for (const { command, operation } of cases) {
    const peer = startPeer(command, {}, new AbortController().signal);
    try {
      await assert.rejects(peer[operation]());
    } finally {
      await peer.stop();
    }
  }
});

test("peer bounds output and responds to cancellation", async () => {
  for (const stream of ["stdout", "stderr"]) {
    const peer = startPeer(
      [
        process.execPath,
        "-e",
        `process.${stream}.write('x'.repeat(1100000)); setInterval(()=>{},1000)`,
      ],
      {},
      new AbortController().signal,
    );
    try {
      await assert.rejects(peer.result(), /exceeded limit/);
    } finally {
      await peer.stop();
    }
  }
  const controller = new AbortController();
  const peer = startPeer(
    [process.execPath, "-e", "setInterval(()=>{},1000)"],
    {},
    controller.signal,
  );
  controller.abort();
  try {
    await assert.rejects(peer.result(), /interrupted/);
  } finally {
    await peer.stop();
  }
});

test("matrix enumerates every pair and explicit subscription limitations", () => {
  const cases = caseList();
  assert.equal(cases.filter((c) => !c.unsupported).length, 472);
  assert.equal(cases.filter((c) => c.unsupported).length, 16);
  for (const buyer of languages)
    for (const seller of languages) {
      const pair = cases.filter((c) => c.buyer === buyer && c.seller === seller);
      for (const variant of ["charge", "tempo"]) {
        assert.equal(pair.filter((c) => c.variant === variant && !c.unsupported).length, 5);
      }
      for (const variant of ["instrument", "card"]) {
        assert.equal(pair.filter((c) => c.variant === variant).length, 7);
      }
      assert.equal(pair.filter((c) => c.variant === "stripe").length, buyer === "node" ? 4 : 0);
    }
});

test("pending settlement preserves its problem without returning paid content", () => {
  const problem = {
    type: "https://paymentauth.org/problems/settlement-unavailable",
    status: 503,
    detail: "Synthetic payment is pending.",
  };
  for (const seller of languages) {
    const sample = { ...testCase, seller, variant: "card", scenario: "uncertain" };
    const pending = {
      status: seller === "python" ? 402 : 503,
      body: JSON.stringify(problem),
      receipt: null,
    };
    checkResult(sample, pending, events.slice(0, 3));
    assert.throws(() =>
      checkResult(sample, { ...pending, body: "Payment required" }, events.slice(0, 3)),
    );
    assert.throws(() =>
      checkResult(sample, { ...pending, receipt: result.receipt }, events.slice(0, 3)),
    );
  }
});

test("successful observations require receipt identity and complete lifecycle", () => {
  checkResult(testCase, result, events);
  for (const changed of [
    { ...result, status: 402 },
    { ...result, body: "{}" },
    { ...result, receipt: null },
    { ...result, receipt: { ...result.receipt, reference: "wrong" } },
    { ...result, receipt: { ...result.receipt, status: "failed" } },
    { ...result, receipt: { ...result.receipt, method: "tempo" } },
  ])
    assert.throws(() => checkResult(testCase, changed, events));
  for (const changed of [
    events.slice(1),
    [...events, events[0]],
    events.slice(0, 3),
    [events[0], events[1], events[3], events[2]],
    [...events, `GET /v1/transactions/${id}/mpp`],
  ])
    assert.throws(() => checkResult(testCase, result, changed));
});

test("rejection never permits the application handler", () => {
  for (const scenario of ["invalid", "settlement-failed"]) {
    const requestEvents = events.slice(0, scenario === "invalid" ? 2 : 3);
    checkResult(
      { ...testCase, scenario },
      { status: 402, body: "Payment required" },
      requestEvents,
    );
    assert.throws(() =>
      checkResult({ ...testCase, scenario }, { status: 402, body: "Payment required" }, [
        ...requestEvents,
        "POST /handler",
      ]),
    );
  }
});

test("pending, existing subscriptions, Tempo and handler failures have distinct evidence", () => {
  checkResult({ ...testCase, scenario: "pending" }, result, [
    events[0],
    `GET /v1/transactions/${id}/mpp`,
    ...events.slice(1),
  ]);
  checkResult({ ...testCase, variant: "existing-subscription" }, result, [
    `POST /v1/subscriptions/${id}/authorize`,
    ...events.slice(1),
  ]);
  checkResult(
    { ...testCase, variant: "tempo" },
    { ...result, receipt: { ...result.receipt, method: "tempo" } },
    events,
  );
  checkResult(
    { ...testCase, scenario: "handler-failed" },
    { status: 500, body: result.body },
    events,
  );
});

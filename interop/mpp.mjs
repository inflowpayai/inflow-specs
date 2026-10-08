import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { languages, startPeer, runMatrix } from "./matrix.mjs";
import { mppCases } from "../fixtures/mpp.mjs";
import { cardCases } from "../fixtures/card.mjs";
import { stripeCases } from "../fixtures/stripe.mjs";

const scenarios = ["ready", "pending", "invalid", "settlement-failed", "handler-failed"];
const id = "22222222-2222-4222-8222-222222222222";
const approval = "33333333-3333-4333-8333-333333333333";
const sellerId = "11111111-1111-4111-8111-111111111111";
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const selectedInstrument = "55555555-5555-4555-8555-555555555555";
const fiat = (variant) => ["instrument", "card", "stripe"].includes(variant);
const method = (variant) => (["tempo", "card", "stripe"].includes(variant) ? variant : "inflow");
const recovery = (scenario) => ["authenticate", "uncertain"].includes(scenario);
const profile = (variant) =>
  variant === "card" ? cardCases : variant === "stripe" ? stripeCases : mppCases;
const configuration = (variant) =>
  profile(variant)
    .cases.flatMap((c) => c.platform?.exchanges ?? [])
    .find((e) => e.request.path === "/v1/mpp/config").response.json;

export function caseList() {
  return languages.flatMap((buyer) =>
    languages.flatMap((seller) =>
      [
        "charge",
        "tempo",
        "subscription",
        "existing-subscription",
        "instrument",
        "card",
        "stripe",
      ].flatMap((variant) => {
        if (variant === "stripe" && buyer !== "node") return [];
        if (
          ["subscription", "existing-subscription"].includes(variant) &&
          ["python", "rust"].includes(seller)
        )
          return [
            {
              buyer,
              seller,
              variant,
              unsupported: `${seller} Seller does not implement subscriptions; upstream limitation`,
            },
          ];
        return [
          ...scenarios,
          ...(fiat(variant) && variant !== "stripe" ? ["authenticate", "uncertain"] : []),
        ]
          .filter((s) => variant !== "stripe" || s !== "pending")
          .filter((s) => variant !== "existing-subscription" || s !== "pending")
          .map((scenario) => ({ buyer, seller, variant, scenario }));
      }),
    ),
  );
}

export function checkResult(test, result, events) {
  const count = (path) => events.filter((e) => e === `POST ${path}`).length;
  const existing = test.variant === "existing-subscription";
  assert.equal(
    count(existing ? `/v1/subscriptions/${id}/authorize` : "/v1/transactions/mpp"),
    test.variant === "stripe" ? 0 : 1,
  );
  assert.equal(count(existing ? "/v1/transactions/mpp" : `/v1/subscriptions/${id}/authorize`), 0);
  assert.equal(count("/v1/mpp/validate"), 1);
  const denied =
    ["invalid", "settlement-failed"].includes(test.scenario) || recovery(test.scenario);
  assert.equal(
    result.status,
    recovery(test.scenario) && test.seller !== "python"
      ? 503
      : denied
        ? 402
        : test.scenario === "handler-failed"
          ? 500
          : 200,
  );
  if (recovery(test.scenario)) {
    const problem = JSON.parse(result.body);
    assert.equal(problem.status, 503);
    assert.equal(problem.type, "https://paymentauth.org/problems/settlement-unavailable");
    assert.equal(problem.detail, "Synthetic payment is pending.");
  }
  assert.equal(count("/handler"), denied ? 0 : 1);
  assert.equal(count("/v1/mpp/broadcast"), test.scenario === "invalid" ? 0 : 1);
  const polls = events.filter((e) => e === `GET /v1/transactions/${id}/mpp`).length;
  assert.equal(polls, test.scenario === "pending" ? 1 : 0);
  if (denied) {
    assert.ok(!result.body.includes('"paidResource"'), "Rejected payment exposed paid response");
    assert.notEqual(
      result.receipt?.status,
      "success",
      "Rejected payment returned a success receipt",
    );
  } else {
    assert.deepEqual(JSON.parse(result.body), { paidResource: true });
    assert.ok(events.indexOf("POST /v1/mpp/broadcast") < events.indexOf("POST /handler"));
    if (test.scenario !== "handler-failed") {
      assert.equal(result.receipt?.reference, id, "receipt mismatch");
      assert.equal(result.receipt.status, "success");
      assert.equal(result.receipt.method, method(test.variant));
    }
  }
}

export async function runCase(test, commands, signal, corruptReceipt = false) {
  const events = [],
    errors = [];
  const evidence = { ...test, events, passed: false };
  let credential,
    recovered = false,
    statusReads = 0;
  const existing = test.variant === "existing-subscription";
  const platform = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const send = (value) => res.end(JSON.stringify(value));
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        assert.ok(size <= 65536, "Platform request exceeded limit");
        chunks.push(chunk);
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      const path = req.url;
      events.push(`${req.method} ${path}`);
      if (path === "/handler") {
        assert.equal(req.method, "POST");
        return send({ ok: true });
      }
      assert.equal(
        req.headers["x-api-key"],
        `test-only-${path.startsWith("/v1/transactions") || path.startsWith("/v1/subscriptions/") ? "buyer" : "seller"}-key`,
      );
      if (path === "/v1/mpp/config") {
        assert.equal(req.method, "GET");
        return send(configuration(test.variant));
      }
      if (path === `/v1/transactions/${id}`) {
        assert.equal(req.method, "GET");
        assert.ok(recovery(test.scenario));
        statusReads++;
        recovered = statusReads === 2;
        return send({
          transactionId: id,
          status: recovered ? "SETTLED" : "PENDING",
          ...(!recovered && test.scenario === "authenticate"
            ? {
                nextAction: {
                  type: "authenticate_card",
                  url: `http://127.0.0.1:${platform.address().port}/must-not-open`,
                },
              }
            : {}),
        });
      }
      if (path === "/v1/transactions/mpp" || path === `/v1/subscriptions/${id}/authorize`) {
        assert.equal(req.method, "POST");
        assert.equal(path, existing ? `/v1/subscriptions/${id}/authorize` : "/v1/transactions/mpp");
        if (existing) assert.deepEqual(Object.keys(body), ["challenge"]);
        const request = JSON.parse(Buffer.from(body.challenge.request, "base64url"));
        assert.equal(body.challenge.method, method(test.variant));
        if (["instrument", "card"].includes(test.variant))
          assert.equal(body.options.instrumentId, selectedInstrument);
        if (test.variant === "card")
          assert.deepEqual(body.options.merchant, {
            name: "Interop shop",
            url: "https://shop.example",
            countryCode: "US",
          });
        assert.equal(
          body.challenge.intent,
          ["subscription", "existing-subscription"].includes(test.variant)
            ? "subscription"
            : "charge",
        );
        assert.equal(
          request.amount,
          test.variant === "tempo"
            ? "10000"
            : test.variant === "card"
              ? "125"
              : test.variant === "instrument"
                ? "1.25"
                : "0.01",
        );
        assert.equal(
          request.currency,
          test.variant === "tempo"
            ? "0x20c0000000000000000000000000000000000000"
            : test.variant === "card"
              ? "usd"
              : test.variant === "instrument"
                ? "USD"
                : "USDC",
        );
        assert.equal(
          request.recipient,
          test.variant === "tempo"
            ? "0x1111111111111111111111111111111111111111"
            : test.variant === "card"
              ? "acct_test_seller"
              : sellerId,
        );
        credential = {
          challenge: body.challenge,
          source: "did:inflow:66666666-6666-4666-8666-666666666666",
          payload: existing
            ? {
                authorizationExpires: body.challenge.expires,
                authorizationId: approval,
                subscriptionId: id,
                transactionId: id,
                authorizationSignature: "synthetic-platform-signature",
              }
            : test.variant === "card"
              ? {
                  encryptedPayload: "synthetic-opaque-token",
                  network: "visa",
                  panLastFour: "1234",
                  panExpirationMonth: "12",
                  panExpirationYear: "2030",
                }
              : test.variant === "tempo"
                ? { type: "hash", hash: `0x${"11".repeat(32)}` }
                : { transactionId: id },
        };
        return send(
          existing
            ? { credential: encode(credential) }
            : test.scenario === "pending"
              ? {
                  state: "pending",
                  transactionId: id,
                  approvalId: approval,
                  retryAfterSeconds: 0,
                }
              : { state: "ready", transactionId: id, credential: encode(credential) },
        );
      }
      if (path === `/v1/transactions/${id}/mpp`) {
        assert.equal(req.method, "GET");
        assert.ok(credential);
        return send({ state: "ready", transactionId: id, credential: encode(credential) });
      }
      if (path === "/v1/mpp/validate" || path === "/v1/mpp/broadcast") {
        assert.equal(req.method, "POST");
        if (test.variant === "stripe" && !credential) {
          credential = body.credential;
          assert.equal(credential.challenge.method, "stripe");
          assert.deepEqual(credential.payload, { spt: "synthetic-external-token" });
          const terms = JSON.parse(Buffer.from(credential.challenge.request, "base64url"));
          assert.equal(terms.amount, "125");
          assert.equal(terms.currency, "usd");
        }
        assert.ok(credential);
        assert.deepEqual(body.credential, credential);
        const problem = {
          type: "https://paymentauth.org/problems/verification-failed",
          title: "Rejected test payment",
          status: 402,
        };
        const pendingProblem = {
          type: "https://paymentauth.org/problems/settlement-unavailable",
          title: "Settlement Pending",
          status: 503,
          detail: "Synthetic payment is pending.",
        };
        if (path.endsWith("/validate"))
          return send(
            test.scenario === "invalid"
              ? { success: false, problem }
              : {
                  success: true,
                  credential,
                  challenge: credential.challenge,
                  source: credential.source,
                  method: credential.challenge.method,
                  intent: credential.challenge.intent,
                  request: JSON.parse(Buffer.from(credential.challenge.request, "base64url")),
                  details: {},
                },
          );
        assert.equal(events.filter((e) => e === "POST /v1/mpp/validate").length, recovered ? 2 : 1);
        return send(
          test.scenario === "settlement-failed" || (recovery(test.scenario) && !recovered)
            ? { problem: recovery(test.scenario) ? pendingProblem : problem }
            : {
                receipt: {
                  method: credential.challenge.method,
                  status: "success",
                  reference: corruptReceipt ? approval : id,
                  challengeId: credential.challenge.id,
                  timestamp: "2026-09-29T00:00:00Z",
                },
              },
        );
      }
      throw Error(`Unexpected platform request: ${req.method} ${path}`);
    } catch (error) {
      errors.push(error.message);
      res.statusCode = 400;
      send({ error: "Unexpected test request" });
    }
  });
  platform.listen(0, "127.0.0.1");
  await once(platform, "listening");
  const settings = {
    Protocol: "mpp",
    Platform: `http://127.0.0.1:${platform.address().port}`,
    Variant: existing ? "subscription" : test.variant,
    ...(existing ? { SubscriptionID: id } : {}),
    ...(["card", "instrument"].includes(test.variant) ? { InstrumentID: selectedInstrument } : {}),
    HandlerStatus: test.scenario === "handler-failed" ? 500 : 200,
  };
  let seller, buyer;
  try {
    seller = startPeer(commands[test.seller], { ...settings, Role: "seller" }, signal);
    const target = await seller.ready();
    buyer = startPeer(commands[test.buyer], { ...settings, Role: "buyer", Target: target }, signal);
    evidence.result = await buyer.result();
    if (recovery(test.scenario)) {
      checkResult(test, evidence.result, events);
      evidence.initial_buyer_log = await buyer.stop();
      buyer = startPeer(
        commands[test.buyer],
        { ...settings, Role: "buyer", Target: target, StatusID: id },
        signal,
      );
      evidence.snapshots = await buyer.result();
      assert.deepEqual(
        evidence.snapshots.map((s) => s.status),
        ["PENDING", "SETTLED"],
      );
      assert.ok(evidence.snapshots.every((s) => s.transactionId === id));
      assert.deepEqual(
        evidence.snapshots[0].nextAction,
        test.scenario === "authenticate"
          ? { type: "authenticate_card", url: `${settings.Platform}/must-not-open` }
          : undefined,
      );
      assert.equal(evidence.snapshots[1].nextAction, undefined);
      assert.equal(statusReads, 2);
      const replay = await fetch(target, {
        headers: {
          "X-App-Session": "test-only-session",
          Authorization: `Payment ${encode(credential)}`,
        },
        redirect: "error",
        signal,
      });
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), { paidResource: true });
      const receipt = JSON.parse(Buffer.from(replay.headers.get("Payment-Receipt"), "base64url"));
      assert.equal(receipt.reference, id);
      assert.equal(receipt.status, "success");
      assert.equal(receipt.method, method(test.variant));
      assert.equal(receipt.challengeId, credential.challenge.id);
      assert.equal(events.filter((e) => e === "POST /v1/transactions/mpp").length, 1);
      assert.equal(events.filter((e) => e === "POST /handler").length, 1);
      evidence.recovery =
        "Original credential replayed after explicit status reads; no replacement purchase";
    }
  } catch (error) {
    evidence.error = error.stack;
  } finally {
    evidence.buyer_log = buyer ? await buyer.stop() : null;
    evidence.seller_log = seller ? await seller.stop() : null;
    evidence.platform_errors = errors;
    platform.closeAllConnections();
    await new Promise((r) => platform.close(r));
  }
  if (!evidence.error) {
    try {
      assert.deepEqual(errors, []);
      if (!recovery(test.scenario)) checkResult(test, evidence.result, events);
      assert.ok(!corruptReceipt, "Corrupted receipt was not rejected");
      evidence.passed = true;
    } catch (error) {
      if (
        corruptReceipt &&
        error.code === "ERR_ASSERTION" &&
        error.message.startsWith("receipt mismatch") &&
        !errors.length
      ) {
        evidence.passed = true;
        evidence.negative_control = "corrupted receipt rejected";
      } else evidence.error = error.stack;
    }
  }
  return evidence;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await runMatrix("mpp", caseList, runCase, "charge");

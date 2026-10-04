import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { languages, startPeer, runMatrix } from "./matrix.mjs";
import { mppCases } from "../fixtures/mpp.mjs";

const scenarios = ["ready", "pending", "invalid", "settlement-failed", "handler-failed"];
const id = "22222222-2222-4222-8222-222222222222";
const approval = "33333333-3333-4333-8333-333333333333";
const sellerId = "11111111-1111-4111-8111-111111111111";
const config = mppCases.cases
  .flatMap((c) => c.platform?.exchanges ?? [])
  .find((e) => e.request.path === "/v1/mpp/config").response.json;
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function caseList() {
  return languages.flatMap((buyer) =>
    languages.flatMap((seller) =>
      ["charge", "tempo", "subscription", "existing-subscription"].flatMap((variant) => {
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
        return scenarios
          .filter((s) => variant !== "existing-subscription" || s !== "pending")
          .map((scenario) => ({ buyer, seller, variant, scenario }));
      }),
    ),
  );
}

export function checkResult(test, result, events) {
  const count = (path) => events.filter((e) => e === `POST ${path}`).length;
  const existing = test.variant === "existing-subscription";
  assert.equal(count(existing ? `/v1/subscriptions/${id}/authorize` : "/v1/transactions/mpp"), 1);
  assert.equal(count(existing ? "/v1/transactions/mpp" : `/v1/subscriptions/${id}/authorize`), 0);
  assert.equal(count("/v1/mpp/validate"), 1);
  const denied = ["invalid", "settlement-failed"].includes(test.scenario);
  assert.equal(result.status, denied ? 402 : test.scenario === "handler-failed" ? 500 : 200);
  assert.equal(count("/handler"), denied ? 0 : 1);
  assert.equal(count("/v1/mpp/broadcast"), test.scenario === "invalid" ? 0 : 1);
  const polls = events.filter((e) => e === `GET /v1/transactions/${id}/mpp`).length;
  assert.equal(polls, test.scenario === "pending" ? 1 : 0);
  if (!denied) {
    assert.deepEqual(JSON.parse(result.body), { paidResource: true });
    assert.ok(events.indexOf("POST /v1/mpp/broadcast") < events.indexOf("POST /handler"));
    if (test.scenario !== "handler-failed") {
      assert.equal(result.receipt?.reference, id, "receipt mismatch");
      assert.equal(result.receipt.status, "success");
      assert.equal(result.receipt.method, test.variant === "tempo" ? "tempo" : "inflow");
    }
  }
}

export async function runCase(test, commands, signal, corruptReceipt = false) {
  const events = [],
    errors = [];
  const evidence = { ...test, events, passed: false };
  let credential;
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
        return send(config);
      }
      if (path === "/v1/transactions/mpp" || path === `/v1/subscriptions/${id}/authorize`) {
        assert.equal(req.method, "POST");
        assert.equal(path, existing ? `/v1/subscriptions/${id}/authorize` : "/v1/transactions/mpp");
        if (existing) assert.deepEqual(Object.keys(body), ["challenge"]);
        const request = JSON.parse(Buffer.from(body.challenge.request, "base64url"));
        assert.equal(body.challenge.method, test.variant === "tempo" ? "tempo" : "inflow");
        assert.equal(
          body.challenge.intent,
          ["subscription", "existing-subscription"].includes(test.variant)
            ? "subscription"
            : "charge",
        );
        assert.equal(request.amount, test.variant === "tempo" ? "10000" : "0.01");
        assert.equal(
          request.currency,
          test.variant === "tempo" ? "0x20c0000000000000000000000000000000000000" : "USDC",
        );
        assert.equal(
          request.recipient,
          test.variant === "tempo" ? "0x1111111111111111111111111111111111111111" : sellerId,
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
        assert.ok(credential);
        assert.deepEqual(body.credential, credential);
        const problem = {
          type: "https://paymentauth.org/problems/verification-failed",
          title: "Rejected test payment",
          status: 402,
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
        assert.equal(events.filter((e) => e === "POST /v1/mpp/validate").length, 1);
        return send(
          test.scenario === "settlement-failed"
            ? { problem }
            : {
                receipt: {
                  method: credential.challenge.method,
                  status: "success",
                  reference: corruptReceipt ? approval : id,
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
    HandlerStatus: test.scenario === "handler-failed" ? 500 : 200,
  };
  let seller, buyer;
  try {
    seller = startPeer(commands[test.seller], { ...settings, Role: "seller" }, signal);
    const target = await seller.ready();
    buyer = startPeer(commands[test.buyer], { ...settings, Role: "buyer", Target: target }, signal);
    evidence.result = await buyer.result();
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
      checkResult(test, evidence.result, events);
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

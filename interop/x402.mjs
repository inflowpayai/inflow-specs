import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { x402Cases } from "../fixtures/x402.mjs";
import { languages, runMatrix, startPeer } from "./matrix.mjs";

const id = "22222222-2222-4222-8222-222222222222";
const approval = "33333333-3333-4333-8333-333333333333";
const sellerId = "11111111-1111-4111-8111-111111111111";
const config = x402Cases.cases.find((c) => c.id === "x402.seller.offers-default").input.config;
const supported = x402Cases.cases
  .flatMap((c) => c.platform?.exchanges ?? [])
  .find((e) => e.request.path === "/v1/transactions/x402-supported").response.json;

export function caseList() {
  return languages.flatMap((buyer) =>
    languages.flatMap((seller) =>
      ["balance", "exact"].flatMap((variant) =>
        ["ready", "pending", "invalid", "settlement-failed", "handler-failed"].map((scenario) => ({
          buyer,
          seller,
          variant,
          scenario,
        })),
      ),
    ),
  );
}

export function checkResult(test, result, events, network) {
  const count = (event) => events.filter((e) => e === event).length;
  assert.equal(count("POST /v1/transactions/x402"), 1);
  assert.equal(count(`GET /v1/transactions/${id}/x402`), test.scenario === "pending" ? 2 : 1);
  assert.equal(count("POST /v1/x402/verify"), 1);
  const denied = ["invalid", "settlement-failed"].includes(test.scenario);
  const settled = !["invalid", "handler-failed"].includes(test.scenario);
  assert.equal(result.status, denied ? 402 : test.scenario === "handler-failed" ? 500 : 200);
  assert.equal(count("POST /handler"), test.scenario === "invalid" ? 0 : 1);
  assert.equal(count("POST /v1/x402/settle"), settled ? 1 : 0);
  if (test.scenario !== "invalid") {
    assert.ok(events.indexOf("POST /v1/x402/verify") < events.indexOf("POST /handler"));
    if (settled)
      assert.ok(events.indexOf("POST /handler") < events.indexOf("POST /v1/x402/settle"));
  }
  if (denied) {
    assert.ok(!result.body.includes('"paidResource"'), "Rejected payment exposed paid response");
    assert.notEqual(result.receipt?.success, true, "Rejected payment returned a success receipt");
  } else {
    assert.deepEqual(JSON.parse(result.body), { paidResource: true });
    if (test.scenario === "handler-failed") {
      assert.notEqual(result.receipt?.success, true);
    } else {
      assert.equal(result.receipt?.success, true);
      assert.equal(result.receipt.network, network);
      assert.match(result.cache, /private/i);
      assert.equal(result.receipt.transaction, id, "receipt mismatch");
    }
  }
}

async function runCase(test, commands, signal, corruptReceipt = false) {
  const events = [],
    errors = [];
  const evidence = { ...test, events, passed: false };
  let payload, target;
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
        `test-only-${path.startsWith("/v1/transactions") ? "buyer" : "seller"}-key`,
      );
      const capabilities = {
        "/v1/x402/config": config,
        "/v1/transactions/x402-supported": supported,
        "/v1/x402/supported": { kinds: config.supported },
      };
      if (Object.hasOwn(capabilities, path)) {
        assert.equal(req.method, "GET");
        return send(capabilities[path]);
      }
      if (path === "/v1/transactions/x402") {
        assert.equal(req.method, "POST");
        assert.equal(events.filter((e) => e === `POST ${path}`).length, 1);
        assert.equal(body.accept.scheme, test.variant);
        assert.equal(
          body.accept.network,
          test.variant === "exact" ? config.assets[0].network : config.paymentMethods[0].network,
        );
        assert.equal(
          body.accept.asset,
          test.variant === "exact" ? config.assets[0].assetId : "USDC",
        );
        assert.equal(body.accept.amount, test.variant === "exact" ? "10000" : "1000000");
        assert.equal(
          body.accept.payTo,
          test.variant === "exact" ? config.wallets[0].address : sellerId,
        );
        assert.equal(body.resource.url, target);
        payload = {
          x402Version: 2,
          accepted: body.accept,
          resource: body.resource,
          payload: { transactionId: id },
          extensions: {
            "payment-identifier": {
              info: { required: false, id: "interop-payment-identifier" },
              schema: {
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                  id: {
                    type: "string",
                    minLength: 16,
                    maxLength: 128,
                    pattern: "^[a-zA-Z0-9_-]+$",
                  },
                  required: { type: "boolean" },
                },
                required: ["required"],
              },
            },
          },
        };
        return send({
          transactionId: id,
          approvalId: approval,
          approvalStatus: "APPROVED",
          amount: "0.01",
          currency: "USDC",
        });
      }
      if (path === `/v1/transactions/${id}/x402`) {
        assert.equal(req.method, "GET");
        assert.ok(payload);
        if (test.scenario === "pending" && events.filter((e) => e === `GET ${path}`).length === 1)
          return send({ status: "INITIATED" });
        return send({
          status: "COMPLETED",
          paymentPayload: payload,
          encodedPayload: Buffer.from(JSON.stringify(payload)).toString("base64"),
        });
      }
      if (path === "/v1/x402/verify" || path === "/v1/x402/settle") {
        assert.equal(req.method, "POST");
        assert.ok(payload);
        assert.equal(body.x402Version, 2);
        assert.deepEqual(body.paymentPayload, payload);
        assert.deepEqual(body.paymentRequirements, payload.accepted);
        const payer = "66666666-6666-4666-8666-666666666666";
        if (path.endsWith("/verify"))
          return send({
            isValid: test.scenario !== "invalid",
            payer,
            ...(test.scenario === "invalid" ? { invalidReason: "test_rejected" } : {}),
          });
        assert.equal(events.filter((e) => e === "POST /v1/x402/verify").length, 1);
        assert.equal(events.filter((e) => e === "POST /handler").length, 1);
        return send({
          success: test.scenario !== "settlement-failed",
          payer,
          network: payload.accepted.network,
          transaction: corruptReceipt ? approval : id,
          ...(test.scenario === "settlement-failed" ? { errorReason: "test_rejected" } : {}),
        });
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
    Protocol: "x402",
    Platform: `http://127.0.0.1:${platform.address().port}`,
    Variant: test.variant,
    HandlerStatus: test.scenario === "handler-failed" ? 500 : 200,
  };
  let seller, buyer;
  try {
    seller = startPeer(commands[test.seller], { ...settings, Role: "seller" }, signal);
    target = await seller.ready();
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
      checkResult(test, evidence.result, events, payload.accepted.network);
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
  await runMatrix("x402", caseList, runCase, "balance");

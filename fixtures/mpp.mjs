import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const sellerId = "11111111-1111-4111-8111-111111111111";
const transactionId = "22222222-2222-4222-8222-222222222222";
const approvalId = "33333333-3333-4333-8333-333333333333";
const subscriptionId = "44444444-4444-4444-8444-444444444444";
const instrumentId = "55555555-5555-4555-8555-555555555555";
const source = "did:inflow:66666666-6666-4666-8666-666666666666";
const buyerHeaders = { "x-api-key": "test-only-buyer-key" };
const sellerHeaders = { "x-api-key": "test-only-seller-key" };
const timestamp = "2026-09-01T12:00:00Z";

// Fixture values use strings for amounts; this encoder is not a general JCS implementation.
const sorted = (value) =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted(value[key])]),
        )
      : value;
const encode = (value) => Buffer.from(JSON.stringify(sorted(value))).toString("base64url");
const clone = (value) => structuredClone(value);
const exchange = (method, path, headers, json, response) => ({
  request: { method, path, headers, ...(json === undefined ? {} : { json }) },
  response: { status: 200, json: response },
});
const problem = {
  type: "https://paymentauth.org/problems/verification-failed",
  title: "Payment Verification Failed",
  status: 402,
  detail: "Synthetic credential rejected.",
  extensions: { payment_reference: "test-only-rejected-payment" },
};
export const mppFailureMessages = {
  "invalid-input": "Invalid input.",
  "invalid-credential": "Invalid credential.",
  "payment-failed": "Payment failed.",
  "payment-expired": "Payment expired.",
  "payment-timeout": "Payment timed out.",
  "payment-cancelled": "Payment cancelled.",
  "unsupported-capability": "Unsupported payment capability.",
};
const failure = (code, details) => ({
  error: { code, message: mppFailureMessages[code], ...(details ? { details } : {}) },
});
function buildCases(signedChallenges = {}) {
  const cases = [];
  const add = (id, suite, operation, input, expect, exchanges) => {
    cases.push(
      clone({
        id,
        suite,
        operation,
        ...(suite === "mpp-seller" &&
        (input.intent ?? input.credential?.challenge?.intent) === "subscription"
          ? { feature: "mpp-seller-subscriptions" }
          : {}),
        input,
        expect,
        ...(exchanges ? { platform: { exchanges } } : {}),
      }),
    );
  };

  const requests = {
    balance: {
      amount: "10.5",
      currency: "USDC",
      recipient: sellerId,
      methodDetails: { rail: "balance" },
    },
    instrument: {
      amount: "10.5",
      currency: "USD",
      recipient: sellerId,
      methodDetails: { rail: "instrument", instrumentId },
    },
    subscription: {
      amount: "5.00",
      currency: "USDC",
      recipient: sellerId,
      methodDetails: { rail: "balance" },
      periodUnit: "month",
      periodCount: 1,
      subscriptionExpires: "2099-01-01T00:00:00Z",
      externalId: "test-plan",
    },
    tempo: {
      amount: "10500000",
      currency: "0x20c0000000000000000000000000000000000000",
      recipient: "0x1111111111111111111111111111111111111111",
      methodDetails: { chainId: 4217, feePayer: false, supportedModes: ["pull"] },
    },
  };
  const challenge = (kind) => ({
    id: `test-${kind}`,
    realm: "seller.example",
    method: kind === "tempo" ? "tempo" : "inflow",
    intent: kind === "subscription" ? "subscription" : "charge",
    request: encode(requests[kind]),
    ...(kind === "subscription" ? { expires: "2099-01-01T00:00:00Z" } : {}),
    ...signedChallenges[kind],
  });
  const credential = (kind) => ({
    challenge: challenge(kind),
    source:
      kind === "tempo" ? "did:pkh:eip155:4217:0x2222222222222222222222222222222222222222" : source,
    payload:
      kind === "tempo"
        ? { type: "transaction", signature: "0xdeadbeef", transactionId }
        : {
            type: kind === "instrument" ? "instrument" : "balance",
            transactionId,
            approvalId,
            ...(kind === "subscription" ? { subscriptionId } : {}),
          },
  });
  const receipt = (kind) => ({
    method: challenge(kind).method,
    reference: transactionId,
    status: "success",
    timestamp,
    challengeId: challenge(kind).id,
    settlement: {
      amount: kind === "subscription" ? "5" : "10.5",
      currency: kind === "instrument" ? "USD" : "USDC",
    },
    ...(kind === "subscription" ? { subscriptionId, externalId: "test-plan" } : {}),
  });
  const config = {
    sellerId,
    featureFlags: { idempotencyKeyEnabled: true },
    replayPolicy: { managedBy: "psp" },
    supportedMethods: [
      {
        id: "inflow",
        label: "inflow",
        supportedCurrencies: ["USD", "USDC"],
        supportedIntents: ["charge", "subscription"],
        methodDetails: {
          currencyRails: {
            USD: { rail: "instrument", instrumentId: "optional" },
            USDC: { rail: "balance" },
          },
          intentCurrencyRails: {
            charge: {
              USD: [{ rail: "instrument", instrumentId: "optional" }],
              USDC: [{ rail: "balance" }],
            },
            subscription: { USDC: [{ rail: "balance" }] },
          },
        },
      },
      {
        id: "tempo",
        label: "tempo",
        supportedCurrencies: ["PUSD", "USDC"],
        supportedIntents: ["charge"],
        methodDetails: {
          chainId: 4217,
          feePayer: false,
          supportedModes: ["pull"],
          intentCurrencyRails: { charge: { USDC: [{ rail: "blockchain" }] } },
        },
      },
    ],
  };
  const getConfig = (value = config) =>
    exchange("GET", "/v1/mpp/config", sellerHeaders, undefined, value);
  const create = (kind, response, context = {}) =>
    exchange(
      "POST",
      "/v1/transactions/mpp",
      buyerHeaders,
      { challenge: challenge(kind), options: context },
      response,
    );
  const poll = (response) =>
    exchange("GET", `/v1/transactions/${transactionId}/mpp`, buyerHeaders, undefined, response);
  const pending = { state: "pending", transactionId, approvalId, retryAfterSeconds: 0 };
  const ready = (kind) => ({ state: "ready", transactionId, credential: encode(credential(kind)) });
  const cancel = (status = 204) => ({
    request: { method: "POST", path: `/v1/approvals/${approvalId}/cancel`, headers: buyerHeaders },
    response: { status },
  });
  const buyerInput = (kind, extra = {}) => ({
    api_key: buyerHeaders["x-api-key"],
    challenge: challenge(kind),
    context: {},
    ...extra,
  });
  const sellerInput = (kind, extra = {}) => ({
    api_key: sellerHeaders["x-api-key"],
    credential: credential(kind),
    ...extra,
  });
  const validation = (kind) => ({
    success: true,
    challenge: challenge(kind),
    credential: credential(kind),
    details: {},
    intent: challenge(kind).intent,
    method: challenge(kind).method,
    request: requests[kind],
    source: credential(kind).source,
  });
  const validateExchange = (kind, response = validation(kind)) =>
    exchange("POST", "/v1/mpp/validate", sellerHeaders, { credential: credential(kind) }, response);
  const broadcastExchange = (
    kind,
    response = { receipt: receipt(kind), receiptHeader: encode(receipt(kind)) },
    key = { capture: "broadcast-key" },
  ) =>
    exchange(
      "POST",
      "/v1/mpp/broadcast",
      { ...sellerHeaders, "idempotency-key": key },
      { credential: credential(kind) },
      response,
    );

  const literalRequest =
    '{"amount":"10.5","currency":"USDC","methodDetails":{"rail":"balance"},"recipient":"11111111-1111-1111-1111-111111111111"}';
  const literalEncoded =
    "eyJhbW91bnQiOiIxMC41IiwiY3VycmVuY3kiOiJVU0RDIiwibWV0aG9kRGV0YWlscyI6eyJyYWlsIjoiYmFsYW5jZSJ9LCJyZWNpcGllbnQiOiIxMTExMTExMS0xMTExLTExMTEtMTExMS0xMTExMTExMTExMTEifQ";
  add(
    "mpp.core.encode-request",
    "mpp-core",
    "mpp.core.encode",
    { value: JSON.parse(literalRequest) },
    { result: literalEncoded },
  );
  add(
    "mpp.core.decode-request",
    "mpp-core",
    "mpp.core.decode",
    { value: literalEncoded },
    { result: JSON.parse(literalRequest) },
  );
  const first = challenge("balance");
  const second = challenge("instrument");
  const header = (value) =>
    `Payment id="${value.id}", realm="${value.realm}", method="${value.method}", intent="${value.intent}", request="${value.request}"`;
  add(
    "mpp.core.combined-challenges",
    "mpp-core",
    "mpp.core.parse-challenges",
    { headers: `${header(first)}, ${header(second)}` },
    { result: [first, second] },
  );
  add(
    "mpp.core.repeated-challenges",
    "mpp-core",
    "mpp.core.parse-challenges",
    { headers: [header(first), header(second)] },
    { result: [first, second] },
  );
  add(
    "mpp.core.escaped-description",
    "mpp-core",
    "mpp.core.parse-challenges",
    { headers: `${header(first)}, description="Pay \\"now\\", then \\\\ later"` },
    { result: [{ ...first, description: 'Pay "now", then \\ later' }] },
  );
  add(
    "mpp.core.duplicate-id",
    "mpp-core",
    "mpp.core.parse-challenges",
    { headers: `${header(first)}, id="duplicate"` },
    failure("invalid-input"),
  );
  for (const kind of Object.keys(requests)) {
    add(
      `mpp.core.credential-${kind}`,
      "mpp-core",
      "mpp.core.decode-credential",
      { value: encode(credential(kind)) },
      { result: credential(kind) },
    );
    add(
      `mpp.core.receipt-${kind}`,
      "mpp-core",
      "mpp.core.decode-receipt",
      { value: encode(receipt(kind)) },
      { result: receipt(kind) },
    );
    const context = kind === "instrument" ? { instrumentId } : {};
    add(
      `mpp.buyer.ready-${kind}`,
      "mpp-buyer",
      "mpp.buyer.fulfil",
      buyerInput(kind, { context }),
      { result: credential(kind) },
      [create(kind, ready(kind), context)],
    );
    add(
      `mpp.buyer.pending-${kind}`,
      "mpp-buyer",
      "mpp.buyer.fulfil",
      buyerInput(kind, { context }),
      { result: credential(kind) },
      [create(kind, pending, context), poll(pending), poll(ready(kind))],
    );
    add(
      `mpp.seller.validate-${kind}`,
      "mpp-seller",
      "mpp.seller.validate",
      sellerInput(kind),
      { result: validation(kind) },
      [getConfig(), validateExchange(kind)],
    );
    add(
      `mpp.seller.verify-${kind}`,
      "mpp-seller",
      "mpp.seller.verify",
      sellerInput(kind),
      { result: receipt(kind) },
      [getConfig(), validateExchange(kind), broadcastExchange(kind)],
    );
  }
  add(
    "mpp.buyer.instrument-primary",
    "mpp-buyer",
    "mpp.buyer.fulfil",
    buyerInput("instrument"),
    { result: credential("instrument") },
    [create("instrument", ready("instrument"))],
  );
  const unavailableInstrument = {
    type: "https://paymentauth.org/problems/payment-insufficient",
    title: "Payment Insufficient",
    status: 402,
    detail: "The selected payment instrument is unavailable.",
  };
  add(
    "mpp.buyer.instrument-rejected-no-fallback",
    "mpp-buyer",
    "mpp.buyer.fulfil",
    buyerInput("instrument", { context: { instrumentId } }),
    failure("payment-failed", { problem: unavailableInstrument }),
    [create("instrument", { state: "failed", problem: unavailableInstrument }, { instrumentId })],
  );
  for (const [name, value] of Object.entries({
    "invalid-json": "eyI",
    "wrong-type": "W10",
    "missing-fields": "e30",
  }))
    add(
      `mpp.core.credential-${name}`,
      "mpp-core",
      "mpp.core.decode-credential",
      { value },
      failure("invalid-credential"),
    );

  const accessCredential = {
    challenge: challenge("subscription"),
    source,
    payload: {
      authorizationId: "77777777-7777-4777-8777-777777777777",
      authorizationExpires: "2099-01-01T00:00:00Z",
      authorizationSignature: "test-only-authorization-signature",
      subscriptionId,
      transactionId,
    },
  };
  const authorize = (response) =>
    exchange(
      "POST",
      `/v1/subscriptions/${subscriptionId}/authorize`,
      buyerHeaders,
      { challenge: challenge("subscription") },
      response,
    );
  add(
    "mpp.buyer.subscription-access",
    "mpp-buyer",
    "mpp.buyer.fulfil",
    buyerInput("subscription", { context: { subscriptionId } }),
    { result: accessCredential },
    [authorize({ credential: encode(accessCredential), expires: "2099-01-01T00:00:00Z" })],
  );
  add(
    "mpp.buyer.subscription-access-denied",
    "mpp-buyer",
    "mpp.buyer.fulfil",
    buyerInput("subscription", { context: { subscriptionId } }),
    failure("payment-failed", { problem }),
    [authorize({ problem })],
  );
  for (const [name, response, expected] of [
    ["failed", { state: "failed", transactionId, problem }, failure("payment-failed", { problem })],
    [
      "expired",
      { state: "expired", transactionId },
      failure("payment-expired", { transaction_id: transactionId }),
    ],
    ["missing-credential", { state: "ready", transactionId }, failure("invalid-credential")],
    [
      "malformed-credential",
      { state: "ready", transactionId, credential: "e30" },
      failure("invalid-credential"),
    ],
  ]) {
    add(`mpp.buyer.${name}`, "mpp-buyer", "mpp.buyer.fulfil", buyerInput("balance"), expected, [
      create("balance", response),
    ]);
    add(
      `mpp.buyer.pending-${name}`,
      "mpp-buyer",
      "mpp.buyer.fulfil",
      buyerInput("balance"),
      expected,
      [create("balance", pending), poll(response), cancel()],
    );
  }
  add(
    "mpp.buyer.cancel-failure-preserves-error",
    "mpp-buyer",
    "mpp.buyer.fulfil",
    buyerInput("balance"),
    failure("payment-failed", { problem }),
    [create("balance", pending), poll({ state: "failed", problem }), cancel(500)],
  );
  add(
    "mpp.buyer.timeout",
    "mpp-buyer",
    "mpp.buyer.fulfil",
    buyerInput("balance", { timeout_ms: 1000 }),
    failure("payment-timeout", { transaction_id: transactionId }),
    [create("balance", { ...pending, retryAfterSeconds: 60 }), cancel()],
  );
  add(
    "mpp.buyer.timeout-during-poll",
    "mpp-buyer",
    "mpp.buyer.fulfil",
    buyerInput("balance", { timeout_ms: 500 }),
    failure("payment-timeout", { transaction_id: transactionId }),
    [
      create("balance", pending),
      {
        ...poll(ready("balance")),
        response: { status: 200, json: ready("balance"), delay_ms: 1000 },
      },
      cancel(),
    ],
  );
  add(
    "mpp.buyer.cancel",
    "mpp-buyer",
    "mpp.buyer.cancel",
    buyerInput("balance"),
    failure("payment-cancelled"),
    [create("balance", { ...pending, retryAfterSeconds: 60 }), cancel()],
  );

  for (const kind of ["balance", "subscription", "tempo"]) {
    add(
      `mpp.seller.validation-rejected-${kind}`,
      "mpp-seller",
      "mpp.seller.verify",
      sellerInput(kind),
      failure("payment-failed", { problem }),
      [getConfig(), validateExchange(kind, { success: false, problem })],
    );
    add(
      `mpp.seller.broadcast-rejected-${kind}`,
      "mpp-seller",
      "mpp.seller.verify",
      sellerInput(kind),
      failure("payment-failed", { problem }),
      [getConfig(), validateExchange(kind), broadcastExchange(kind, { problem })],
    );
  }
  for (const [name, mutate] of Object.entries({
    challenge: (value) => {
      value.challenge.id = "wrong";
    },
    credential: (value) => {
      value.credential.payload.transactionId = "wrong";
    },
    source: (value) => {
      value.source = "did:inflow:wrong";
    },
    method: (value) => {
      value.method = "wrong";
    },
    intent: (value) => {
      value.intent = "wrong";
    },
  })) {
    const response = clone(validation("balance"));
    mutate(response);
    add(
      `mpp.seller.inconsistent-${name}`,
      "mpp-seller",
      "mpp.seller.verify",
      sellerInput("balance", { include_problem: false }),
      failure("payment-failed"),
      [getConfig(), validateExchange("balance", response)],
    );
  }
  for (const [name, response] of Object.entries({
    missing: {},
    unsuccessful: { receipt: { ...receipt("balance"), status: "failed" } },
  }))
    add(
      `mpp.seller.receipt-${name}`,
      "mpp-seller",
      "mpp.seller.verify",
      sellerInput("balance", { include_problem: false }),
      failure("payment-failed"),
      [getConfig(), validateExchange("balance"), broadcastExchange("balance", response)],
    );
  const disabled = { ...config, featureFlags: { idempotencyKeyEnabled: false } };
  add(
    "mpp.seller.idempotency-disabled",
    "mpp-seller",
    "mpp.seller.verify",
    sellerInput("balance"),
    { result: receipt("balance") },
    [
      getConfig(disabled),
      validateExchange("balance"),
      broadcastExchange("balance", undefined, null),
    ],
  );
  const retry = broadcastExchange("balance");
  retry.response = { status: 503, headers: { "retry-after": "0" } };
  add(
    "mpp.seller.idempotency-retry",
    "mpp-seller",
    "mpp.seller.verify",
    sellerInput("balance"),
    { result: receipt("balance") },
    [
      getConfig(),
      validateExchange("balance"),
      retry,
      broadcastExchange("balance", undefined, { same: "broadcast-key" }),
    ],
  );

  for (const kind of ["balance", "instrument", "subscription"]) {
    const request = clone(requests[kind]);
    delete request.recipient;
    delete request.methodDetails;
    const expected = clone(requests[kind]);
    if (kind === "instrument") delete expected.methodDetails.instrumentId;
    add(
      `mpp.seller.prepare-${kind}`,
      "mpp-seller",
      "mpp.seller.prepare",
      {
        api_key: sellerHeaders["x-api-key"],
        method: "inflow",
        intent: challenge(kind).intent,
        request,
      },
      { result: expected },
      [getConfig()],
    );
  }
  const ambiguous = clone(config);
  ambiguous.supportedMethods[0].methodDetails.intentCurrencyRails.charge.USDC.push({
    rail: "instrument",
    instrumentId: "optional",
  });
  const prepare = {
    api_key: sellerHeaders["x-api-key"],
    method: "inflow",
    intent: "charge",
    request: { amount: "10.5", currency: "USDC" },
  };
  add(
    "mpp.seller.ambiguous-rail",
    "mpp-seller",
    "mpp.seller.prepare",
    prepare,
    failure("unsupported-capability"),
    [getConfig(ambiguous)],
  );
  add(
    "mpp.seller.explicit-rail",
    "mpp-seller",
    "mpp.seller.prepare",
    { ...prepare, request: { ...prepare.request, methodDetails: { rail: "balance" } } },
    { result: requests.balance },
    [getConfig(ambiguous)],
  );
  add(
    "mpp.seller.unsupported-currency",
    "mpp-seller",
    "mpp.seller.prepare",
    { ...prepare, request: { amount: "1", currency: "UNSUPPORTED" } },
    failure("unsupported-capability"),
    [getConfig()],
  );
  add(
    "mpp.seller.unsupported-intent-currency",
    "mpp-seller",
    "mpp.seller.prepare",
    { ...prepare, intent: "subscription", request: { ...requests.subscription, currency: "USD" } },
    failure("unsupported-capability"),
    [getConfig()],
  );

  for (const [kind, changes] of Object.entries({
    balance: [{ amount: "11" }],
    instrument: [
      {
        methodDetails: { rail: "instrument", instrumentId: "88888888-8888-4888-8888-888888888888" },
      },
    ],
    subscription: [
      { periodCount: 2 },
      { externalId: "another-plan" },
      { subscriptionExpires: "2098-01-01T00:00:00Z" },
    ],
    tempo: [
      { amount: "11000000" },
      { methodDetails: { ...requests.tempo.methodDetails, chainId: 42431 } },
    ],
  })) {
    for (const [index, change] of changes.entries()) {
      add(
        `mpp.seller.route-binding-${kind}-${index + 1}`,
        "mpp-seller",
        "mpp.seller.route-binding",
        {
          api_key: sellerHeaders["x-api-key"],
          method: challenge(kind).method,
          intent: challenge(kind).intent,
          request: requests[kind],
          replacement_request: { ...requests[kind], ...change },
          credential_payload: credential(kind).payload,
          source: credential(kind).source,
        },
        { result: { status: 402 } },
        [getConfig()],
      );
    }
  }
  const extendedCredential = {
    ...credential("balance"),
    challenge: {
      ...challenge("balance"),
      description: "Synthetic, quoted description",
      digest: "test-digest",
      opaque: "eyJyb3V0ZSI6InRlc3QifQ",
    },
    payload: { ...credential("balance").payload, extra: { trace: "synthetic" } },
  };
  add(
    "mpp.core.optional-fields",
    "mpp-core",
    "mpp.core.decode-credential",
    { value: encode(extendedCredential) },
    { result: extendedCredential },
  );
  add(
    "mpp.buyer.subscription-missing-credential",
    "mpp-buyer",
    "mpp.buyer.fulfil",
    buyerInput("subscription", { context: { subscriptionId } }),
    failure("invalid-credential"),
    [authorize({})],
  );
  add(
    "mpp.buyer.subscription-malformed-credential",
    "mpp-buyer",
    "mpp.buyer.fulfil",
    buyerInput("subscription", { context: { subscriptionId } }),
    failure("invalid-credential"),
    [authorize({ credential: "e30" })],
  );
  add(
    "mpp.buyer.pending-missing-transaction",
    "mpp-buyer",
    "mpp.buyer.fulfil",
    buyerInput("balance"),
    failure("invalid-credential"),
    [create("balance", { state: "pending", approvalId }), cancel()],
  );
  const requiredInstrument = clone(config);
  requiredInstrument.supportedMethods[0].methodDetails.intentCurrencyRails.charge.USD[0].instrumentId =
    "required";
  add(
    "mpp.seller.required-instrument",
    "mpp-seller",
    "mpp.seller.prepare",
    { ...prepare, request: { amount: "1", currency: "USD" } },
    failure("unsupported-capability"),
    [getConfig(requiredInstrument)],
  );
  add(
    "mpp.seller.unsupported-rail",
    "mpp-seller",
    "mpp.seller.prepare",
    { ...prepare, request: { ...prepare.request, methodDetails: { rail: "instrument" } } },
    failure("unsupported-capability"),
    [getConfig()],
  );

  const renewalProblem = {
    type: "https://paymentauth.org/problems/renewal-in-progress",
    title: "Renewal In Progress",
    status: 409,
    detail: "A renewal for this period is already in progress.",
    extensions: { retryAfter: 1 },
  };
  add(
    "mpp.seller.subscription-renewal-in-progress",
    "mpp-seller",
    "mpp.seller.verify",
    sellerInput("subscription"),
    failure("payment-failed", { problem: renewalProblem }),
    [
      getConfig(),
      validateExchange("subscription"),
      broadcastExchange("subscription", { problem: renewalProblem }),
    ],
  );

  return { cases };
}

export const mppCases = buildCases();

// Sign before runner execution; adapters receive neither expected results nor platform scripts.
export function mppCasesWithSellerChallenges(sign) {
  const signatures = Object.fromEntries(
    ["balance", "instrument", "tempo"].map((kind) => {
      const original = mppCases.cases.find((item) => item.id === `mpp.seller.validate-${kind}`)
        .input.credential.challenge;
      const signed = sign(clone(original));
      if (
        !signed ||
        typeof signed.id !== "string" ||
        !signed.id.trim() ||
        typeof signed.expires !== "string" ||
        !(Date.parse(signed.expires) > Date.now())
      )
        throw new Error("Seller fixture signing must return an id and a future expires timestamp");
      return [kind, { id: signed.id, expires: signed.expires }];
    }),
  );
  const signed = buildCases(signatures);
  return {
    cases: signed.cases.map((item, index) =>
      item.suite === "mpp-seller" && item.input.credential && !item.feature
        ? item
        : clone(mppCases.cases[index]),
    ),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.stdout.write(JSON.stringify(mppCases, null, 2) + "\n");

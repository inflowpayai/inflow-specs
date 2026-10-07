import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Test-only public key; no private key or payment credentials are distributed.
const encryptionJwk = {
  kty: "RSA",
  alg: "RSA-OAEP-256",
  use: "enc",
  kid: "test-card-key",
  n: "xKjPwOQ0ctVhIgf0EzbUL51Wh5g3r5hguUmkKIip1LqsNPvlYjHuq-hP5goFtdZisLsq-kEhM76XHX3ocyMnvwU2ZcdbE41Xpl2zvLk4whHdAKnWhvNrFEq8QIBiPfcKmzp56Mq0j3NeVvLhiehztsHex4ApVzDC2o2DaHpWgcbWrc4a16ex1MaCfCoeKa88FX06Pe6KHasSSxQd3AZ1ha2k_2axCrLL6iH6071Ynrmbg6V_JiYhTf9OKzURcIzDD86bHPMG6_t0FnsIJ0B3g9hIn67UtU6zJNpl33-LDoWeB-t7tG7p_bAN9yfHsGQl02WUOsiD0ieogCnpcksF_w",
  e: "AQAB",
};
const methodDetails = {
  acceptedNetworks: ["visa"],
  merchantName: "Test Seller",
  encryptionJwk,
};
const config = {
  sellerId: "11111111-1111-4111-8111-111111111111",
  featureFlags: { idempotencyKeyEnabled: true },
  replayPolicy: { managedBy: "psp" },
  supportedMethods: [
    {
      id: "card",
      label: "Card",
      supportedCurrencies: ["USD"],
      supportedIntents: ["charge"],
      methodDetails: { ...methodDetails, recipient: "acct_test_seller" },
    },
  ],
};
const cases = [];
const prepared = (amount, extra = {}) => ({
  amount,
  currency: "usd",
  recipient: "acct_test_seller",
  methodDetails,
  ...extra,
});
const failure = (code) => ({
  error: {
    code,
    message: code === "invalid-input" ? "Invalid input." : "Unsupported payment capability.",
  },
});
const add = (id, request, expect, configuration = config) =>
  cases.push(
    structuredClone({
      id: `mpp.card.${id}`,
      suite: "mpp-seller",
      operation: "mpp.seller.prepare",
      input: { api_key: "test-only-seller-key", method: "card", intent: "charge", request },
      expect,
      platform: {
        exchanges: [
          {
            request: {
              method: "GET",
              path: "/v1/mpp/config",
              headers: { "x-api-key": "test-only-seller-key" },
            },
            response: { status: 200, json: configuration },
          },
        ],
      },
    }),
  );

for (const [amount, cents] of [
  ["0.5", "50"],
  ["0.50", "50"],
  ["1", "100"],
  ["1.2", "120"],
  ["1.25", "125"],
  ["999999.99", "99999999"],
])
  add(`amount-${amount}`, { amount }, { result: prepared(cents) });
for (const [id, amount] of Object.entries({
  zero: "0",
  small: "0.49",
  negative: "-1",
  precision: "0.501",
  exponent: "1e2",
  leading: "01",
  large: "1000000",
  whitespace: " 1",
  numeric: 1,
}))
  add(`invalid-amount-${id}`, { amount }, failure("invalid-input"));

add(
  "optional-fields",
  { amount: "1", externalId: "order-test", billingRequired: true },
  {
    result: prepared("100", {
      externalId: "order-test",
      methodDetails: { ...methodDetails, billingRequired: true },
    }),
  },
);
add(
  "billing-false",
  { amount: "1", billingRequired: false },
  {
    result: prepared("100", { methodDetails: { ...methodDetails, billingRequired: false } }),
  },
);
add(
  "empty-reference",
  { amount: "1", externalId: "" },
  { result: prepared("100", { externalId: "" }) },
);
add("long-reference", { amount: "1", externalId: "x".repeat(256) }, failure("invalid-input"));
add("invalid-billing", { amount: "1", billingRequired: "true" }, failure("invalid-input"));
add(
  "configuration-authority",
  {
    amount: "1",
    currency: "eur",
    recipient: "acct_other",
    methodDetails: {
      acceptedNetworks: ["mastercard"],
      merchantName: "Other",
      encryptionJwk: { ...encryptionJwk, kid: "other-key" },
      billingRequired: true,
    },
  },
  { result: prepared("100") },
);

for (const [id, mutate] of [
  [
    "absent",
    (value) => {
      value.supportedMethods = [];
    },
  ],
  [
    "currency",
    (value) => {
      value.supportedMethods[0].supportedCurrencies = ["EUR"];
    },
  ],
  [
    "intent",
    (value) => {
      value.supportedMethods[0].supportedIntents = ["subscription"];
    },
  ],
  [
    "details",
    (value) => {
      delete value.supportedMethods[0].methodDetails;
    },
  ],
  [
    "recipient",
    (value) => {
      delete value.supportedMethods[0].methodDetails.recipient;
    },
  ],
  [
    "merchant",
    (value) => {
      delete value.supportedMethods[0].methodDetails.merchantName;
    },
  ],
  [
    "networks",
    (value) => {
      value.supportedMethods[0].methodDetails.acceptedNetworks = [];
    },
  ],
  [
    "network",
    (value) => {
      value.supportedMethods[0].methodDetails.acceptedNetworks = ["mastercard"];
    },
  ],
  [
    "key",
    (value) => {
      delete value.supportedMethods[0].methodDetails.encryptionJwk;
    },
  ],
  [
    "key-algorithm",
    (value) => {
      value.supportedMethods[0].methodDetails.encryptionJwk.alg = "RSA-OAEP";
    },
  ],
  [
    "key-use",
    (value) => {
      value.supportedMethods[0].methodDetails.encryptionJwk.use = "sig";
    },
  ],
  [
    "key-id",
    (value) => {
      value.supportedMethods[0].methodDetails.encryptionJwk.kid = "";
    },
  ],
]) {
  const value = structuredClone(config);
  mutate(value);
  add(`unavailable-${id}`, { amount: "1" }, failure("unsupported-capability"), value);
}

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
const payload = {
  encryptedPayload: "test-only-opaque-credential",
  network: "visa",
  panLastFour: "4242",
  panExpirationMonth: "06",
  panExpirationYear: "2030",
  billingAddress: { zip: "94102", countryCode: "US" },
  extension: "preserved",
};
const credential = {
  challenge: {
    id: "test-card",
    realm: "seller.example",
    method: "card",
    intent: "charge",
    request: encode(prepared("125")),
  },
  payload,
  source: "",
};
const validation = (value) => ({
  success: true,
  challenge: value.challenge,
  credential: value,
  details: {},
  method: "card",
  intent: "charge",
  request: JSON.parse(Buffer.from(value.challenge.request, "base64url").toString()),
  source: value.source,
});
const receipt = {
  method: "card",
  reference: "test-authorization",
  status: "success",
  timestamp: "2026-10-07T12:00:00Z",
  challengeId: "test-card",
  settlement: { amount: "1.25", currency: "USD" },
};
const getConfig = (value = config) => ({
  request: {
    method: "GET",
    path: "/v1/mpp/config",
    headers: { "x-api-key": "test-only-seller-key" },
  },
  response: { status: 200, json: value },
});
const exchange = (path, value, response, headers = {}) => ({
  request: {
    method: "POST",
    path: `/v1/mpp/${path}`,
    headers: { "x-api-key": "test-only-seller-key", ...headers },
    json: { credential: value },
  },
  response: { status: 200, json: response },
});
const validateExchange = (value = credential, result = validation(value)) =>
  exchange("validate", value, result);
const broadcastExchange = (
  value = credential,
  result = { receipt },
  key = { capture: "broadcast-key" },
) => exchange("broadcast", value, result, { "idempotency-key": key });
const lifecycle = (id, operation, input, expect, exchanges) =>
  cases.push(
    structuredClone({
      id: `mpp.card.${id}`,
      suite: "mpp-seller",
      operation: `mpp.seller.${operation}`,
      input: { api_key: "test-only-seller-key", ...input },
      expect,
      platform: { exchanges },
    }),
  );
const rejected = (problem) => ({
  error: {
    code: "payment-failed",
    message: "Payment failed.",
    ...(problem ? { details: { problem } } : {}),
  },
});
lifecycle("validate-only", "validate", { credential }, { result: validation(credential) }, [
  getConfig(),
  validateExchange(),
]);
lifecycle("verify", "verify", { credential }, { result: receipt }, [
  getConfig(),
  validateExchange(),
  broadcastExchange(),
]);
const referenced = {
  ...credential,
  challenge: {
    ...credential.challenge,
    request: encode(prepared("125", { externalId: "order-test" })),
    description: "Test purchase",
    expires: "2030-01-01T00:00:00Z",
  },
};
const referencedReceipt = { ...receipt, externalId: "order-test" };
lifecycle("verify-reference", "verify", { credential: referenced }, { result: referencedReceipt }, [
  getConfig(),
  validateExchange(referenced),
  broadcastExchange(referenced, { receipt: referencedReceipt }),
]);
const identified = { ...credential, source: "did:example:buyer" };
lifecycle("verify-source", "verify", { credential: identified }, { result: receipt }, [
  getConfig(),
  validateExchange(identified),
  broadcastExchange(identified),
]);
const anonymous = structuredClone(credential);
delete anonymous.source;
lifecycle("verify-omitted-source", "verify", { credential: anonymous }, { result: receipt }, [
  getConfig(),
  validateExchange(),
  broadcastExchange(),
]);

for (const [id, change] of Object.entries({
  amount: { amount: "2" },
  reference: { externalId: "other" },
  billing: { billingRequired: false },
})) {
  const request = { amount: "1.25", externalId: "order-test", billingRequired: true };
  lifecycle(
    `route-${id}`,
    "route-binding",
    {
      method: "card",
      intent: "charge",
      request,
      replacement_request: { ...request, ...change },
      credential_payload: payload,
    },
    { result: { status: 402 } },
    [getConfig()],
  );
}
const problem = {
  type: "https://paymentauth.org/problems/verification-failed",
  title: "Payment Verification Failed",
  status: 402,
  detail: "Synthetic CARD rejection.",
};
lifecycle("validation-rejected", "verify", { credential }, rejected(problem), [
  getConfig(),
  validateExchange(credential, { success: false, problem }),
]);
for (const [id, mutate] of Object.entries({
  challenge: (value) => {
    value.challenge.id = "other";
  },
  payload: (value) => {
    value.credential.payload.encryptedPayload = "other";
  },
  source: (value) => {
    value.source = "did:example:other";
  },
  method: (value) => {
    value.method = "stripe";
  },
  intent: (value) => {
    value.intent = "subscription";
  },
})) {
  const response = structuredClone(validation(credential));
  mutate(response);
  lifecycle(
    `validation-inconsistent-${id}`,
    "verify",
    { credential, include_problem: false },
    rejected(),
    [getConfig(), validateExchange(credential, response)],
  );
}
for (const [id, value] of Object.entries({
  rejected: problem,
  pending: {
    type: "https://paymentauth.org/problems/settlement-unavailable",
    title: "Settlement Pending",
    status: 503,
    detail: "Synthetic payment is pending.",
  },
}))
  lifecycle(`broadcast-${id}`, "verify", { credential }, rejected(value), [
    getConfig(),
    validateExchange(),
    broadcastExchange(credential, { problem: value }),
  ]);
for (const [id, result] of Object.entries({
  missing: {},
  failed: { receipt: { ...receipt, status: "failed" } },
  method: { receipt: { ...receipt, method: "stripe" } },
  challenge: { receipt: { ...receipt, challengeId: "other" } },
  "missing-challenge": {
    receipt: Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "challengeId")),
  },
}))
  lifecycle(`receipt-${id}`, "verify", { credential, include_problem: false }, rejected(), [
    getConfig(),
    validateExchange(),
    broadcastExchange(credential, result),
  ]);
const retry = broadcastExchange();
retry.response = { status: 503, headers: { "retry-after": "0" } };
lifecycle("idempotency-retry", "verify", { credential }, { result: receipt }, [
  getConfig(),
  validateExchange(),
  retry,
  broadcastExchange(credential, { receipt }, { same: "broadcast-key" }),
]);
lifecycle("idempotency-disabled", "verify", { credential }, { result: receipt }, [
  getConfig({ ...config, featureFlags: { idempotencyKeyEnabled: false } }),
  validateExchange(),
  broadcastExchange(credential, { receipt }, null),
]);

const buyerKey = "test-only-buyer-key";
const transactionId = "22222222-2222-4222-8222-222222222222";
const approvalId = "33333333-3333-4333-8333-333333333333";
const buyerChallenge = {
  ...credential.challenge,
  expires: "2099-01-01T00:00:00Z",
  description: "Test purchase",
  digest: "sha-256=test-only-binding",
  opaque: encode({ item: "test-report" }),
};
const buyerCredential = { ...credential, challenge: buyerChallenge, source: "did:example:buyer" };
const context = {
  merchant: { name: "Test Seller", url: "https://seller.example", countryCode: "US" },
};
const buyerInput = (options = context) => ({
  api_key: buyerKey,
  challenge: buyerChallenge,
  context: options,
});
const buyerExchange = (method, path, response, json) => ({
  request: {
    method,
    path,
    headers: { "x-api-key": buyerKey },
    ...(json === undefined ? {} : { json }),
  },
  response: { status: 200, json: response },
});
const ready = (value = buyerCredential) => ({
  state: "ready",
  transactionId,
  credential: encode(value),
});
const create = (response, options = context) =>
  buyerExchange("POST", "/v1/transactions/mpp", response, { challenge: buyerChallenge, options });
const poll = (response) => buyerExchange("GET", `/v1/transactions/${transactionId}/mpp`, response);
const buyerCase = (id, input, expect, exchanges) =>
  cases.push(
    structuredClone({
      id: `mpp.card.buyer-${id}`,
      suite: "mpp-buyer",
      operation: "mpp.buyer.fulfil",
      input,
      expect,
      platform: { exchanges },
    }),
  );
const buyerFailure = (code, message, details) => ({
  error: { code, message, ...(details ? { details } : {}) },
});
buyerCase("primary", buyerInput(), { result: buyerCredential }, [create(ready())]);
const selected = { ...context, instrumentId: "55555555-5555-4555-8555-555555555555" };
buyerCase("selected", buyerInput(selected), { result: buyerCredential }, [
  create(ready(), selected),
]);
buyerCase("pending-ready", buyerInput(), { result: buyerCredential }, [
  create({ state: "pending", transactionId, approvalId, retryAfterSeconds: 0 }),
  poll(ready()),
]);
for (const [id, options] of Object.entries({
  "missing-merchant": {},
  "blank-name": { merchant: { ...context.merchant, name: " " } },
  "invalid-url": { merchant: { ...context.merchant, url: "/relative" } },
  "invalid-country": { merchant: { ...context.merchant, countryCode: "USA" } },
  "invalid-instrument": { ...context, instrumentId: "not-a-uuid" },
}))
  buyerCase(id, buyerInput(options), failure("invalid-input"), []);
for (const [id, mutate] of Object.entries({
  id: (value) => {
    value.challenge.id = "other";
  },
  realm: (value) => {
    value.challenge.realm = "other.example";
  },
  method: (value) => {
    value.challenge.method = "inflow";
  },
  intent: (value) => {
    value.challenge.intent = "subscription";
  },
  description: (value) => {
    value.challenge.description = "Other purchase";
  },
  digest: (value) => {
    value.challenge.digest = "sha-256=other-binding";
  },
  amount: (value) => {
    value.challenge.request = encode(prepared("200"));
  },
  recipient: (value) => {
    value.challenge.request = encode(prepared("125", { recipient: "acct_other" }));
  },
  key: (value) => {
    value.challenge.request = encode(
      prepared("125", {
        methodDetails: { ...methodDetails, encryptionJwk: { ...encryptionJwk, kid: "other" } },
      }),
    );
  },
  opaque: (value) => {
    value.challenge.opaque = encode({ item: "other" });
  },
  expiry: (value) => {
    value.challenge.expires = "2098-01-01T00:00:00Z";
  },
  payload: (value) => {
    value.payload.encryptedPayload = "";
  },
  network: (value) => {
    value.payload.network = "mastercard";
  },
})) {
  const value = structuredClone(buyerCredential);
  mutate(value);
  buyerCase(
    `mismatch-${id}`,
    buyerInput(),
    buyerFailure("invalid-credential", "Invalid credential."),
    [create(ready(value))],
  );
}
buyerCase(
  "ready-missing-credential",
  buyerInput(),
  buyerFailure("invalid-credential", "Invalid credential."),
  [create({ state: "ready", transactionId })],
);
const failed = { state: "failed", transactionId, problem };
buyerCase(
  "failed",
  buyerInput(),
  buyerFailure("payment-failed", "Payment failed.", { problem, transaction_id: transactionId }),
  [create(failed)],
);
buyerCase(
  "expired",
  buyerInput(),
  buyerFailure("payment-expired", "Payment expired.", { transaction_id: transactionId }),
  [create({ state: "expired", transactionId })],
);
buyerCase(
  "pending-failed",
  buyerInput(),
  buyerFailure("payment-failed", "Payment failed.", { problem, transaction_id: transactionId }),
  [
    create({ state: "pending", transactionId, approvalId, retryAfterSeconds: 0 }),
    poll(failed),
    {
      request: {
        method: "POST",
        path: `/v1/approvals/${approvalId}/cancel`,
        headers: { "x-api-key": buyerKey },
      },
      response: { status: 204 },
    },
  ],
);

export const cardCases = { cases };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.stdout.write(`${JSON.stringify(cardCases, null, 2)}\n`);

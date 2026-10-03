import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const headers = { "x-api-key": "test-only-seller-key" };
const networkId = "profile_test_seller";
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
const config = {
  sellerId: "11111111-1111-4111-8111-111111111111",
  featureFlags: { idempotencyKeyEnabled: true },
  replayPolicy: { managedBy: "psp" },
  supportedMethods: [
    {
      id: "stripe",
      label: "Stripe",
      supportedCurrencies: ["USD"],
      supportedIntents: ["charge"],
      methodDetails: { networkId, paymentMethodTypes: ["card", "link"] },
    },
  ],
};
const exchange = (path, response, credential, extraHeaders = {}) => ({
  request: {
    method: credential === undefined ? "GET" : "POST",
    path,
    headers: { ...headers, ...extraHeaders },
    ...(credential === undefined ? {} : { json: { credential } }),
  },
  response: { status: 200, json: response },
});
const getConfig = (value = config) => exchange("/v1/mpp/config", value);
const failure = (code, details) => ({
  error: {
    code,
    message: {
      "invalid-input": "Invalid input.",
      "invalid-credential": "Invalid credential.",
      "unsupported-capability": "Unsupported payment capability.",
      "payment-failed": "Payment failed.",
    }[code],
    ...(details === undefined ? {} : { details }),
  },
});
const cases = [];
const add = (id, operation, input, expect, exchanges) =>
  cases.push(
    structuredClone({
      id: `mpp.stripe.${id}`,
      suite: "mpp-seller",
      operation: `mpp.seller.${operation}`,
      input: { api_key: headers["x-api-key"], ...input },
      expect,
      platform: { exchanges },
    }),
  );
const prepared = (amount, extra = {}) => ({
  amount,
  currency: "usd",
  methodDetails: {
    networkId,
    paymentMethodTypes: ["card", "link"],
  },
  ...extra,
});
const prepare = (id, request, expect, configuration = config) =>
  add(
    id,
    "prepare",
    {
      method: "stripe",
      intent: "charge",
      request,
    },
    expect,
    [getConfig(configuration)],
  );

for (const [amount, cents] of [
  ["0.5", "50"],
  ["0.50", "50"],
  ["1", "100"],
  ["1.25", "125"],
  ["999999.99", "99999999"],
])
  prepare(`amount-${amount}`, { amount }, { result: prepared(cents) });
for (const [id, amount] of Object.entries({
  zero: "0",
  small: "0.49",
  large: "1000000",
  precision: "0.501",
  leading: "00.50",
}))
  prepare(`invalid-amount-${id}`, { amount }, failure("invalid-input"));
prepare(
  "authoritative-config",
  {
    amount: "1.25",
    currency: "eur",
    decimals: 3,
    networkId: "caller-profile",
    paymentMethodTypes: ["caller-method"],
    externalId: "order-test",
    metadata: { campaign: "agents" },
  },
  {
    result: prepared("125", {
      externalId: "order-test",
      methodDetails: {
        networkId,
        paymentMethodTypes: ["card", "link"],
        metadata: { campaign: "agents" },
      },
    }),
  },
);
for (const [id, mutate] of Object.entries({
  unavailable: (value) => {
    value.supportedMethods = [];
  },
  currency: (value) => {
    value.supportedMethods[0].supportedCurrencies = ["EUR"];
  },
  intent: (value) => {
    value.supportedMethods[0].supportedIntents = ["subscription"];
  },
  profile: (value) => {
    value.supportedMethods[0].methodDetails.networkId = " ";
  },
  methods: (value) => {
    value.supportedMethods[0].methodDetails.paymentMethodTypes = [];
  },
})) {
  const value = structuredClone(config);
  mutate(value);
  prepare(`config-${id}`, { amount: "1" }, failure("unsupported-capability"), value);
}
for (const [id, key] of Object.entries({
  externalId: "externalId",
  inflowMppTransactionId: "inflowMppTransactionId",
  mppChallengeId: "mppChallengeId",
  mppIntent: "mppIntent",
  mppMethod: "mppMethod",
  stripeNetworkProfile: "stripeNetworkProfile",
  brackets: "bad[key]",
  blank: " ",
  length: "k".repeat(41),
}))
  prepare(
    `metadata-key-${id.toLowerCase()}`,
    { amount: "1", metadata: { [key]: "value" } },
    failure("invalid-input"),
  );
for (const [id, extra] of Object.entries({
  reference: { externalId: "r".repeat(256) },
  value: { metadata: { key: "v".repeat(501) } },
  count: { metadata: Object.fromEntries(Array.from({ length: 46 }, (_, i) => [`key${i}`, "v"])) },
}))
  prepare(`invalid-${id}`, { amount: "1", ...extra }, failure("invalid-input"));
const metadata = Object.fromEntries(Array.from({ length: 44 }, (_, i) => [`key${i}`, "value"]));
metadata["k".repeat(40)] = "v".repeat(500);
prepare(
  "metadata-limits",
  { amount: "1", metadata, externalId: "r".repeat(255) },
  {
    result: prepared("100", {
      externalId: "r".repeat(255),
      methodDetails: { networkId, paymentMethodTypes: ["card", "link"], metadata },
    }),
  },
);

const credential = (
  request = prepared("125"),
  payload = { spt: "spt_test_only" },
  source = "",
) => ({
  challenge: {
    id: "test-stripe",
    realm: "seller.example",
    method: "stripe",
    intent: "charge",
    request: encode(request),
  },
  payload,
  source,
});
const validation = (value) => ({
  success: true,
  challenge: value.challenge,
  credential: value,
  details: {},
  method: "stripe",
  intent: "charge",
  request: JSON.parse(Buffer.from(value.challenge.request, "base64url").toString()),
  source: value.source,
});
const receipt = {
  method: "stripe",
  reference: "pi_test_only",
  status: "success",
  timestamp: "2026-09-01T12:00:00Z",
  challengeId: "test-stripe",
  settlement: { amount: "1.25", currency: "USD" },
};
const validateExchange = (value, response = validation(value)) =>
  exchange("/v1/mpp/validate", response, value);
const broadcastExchange = (
  value,
  response = { receipt, receiptHeader: encode(receipt) },
  key = { capture: "broadcast-key" },
) => exchange("/v1/mpp/broadcast", response, value, { "idempotency-key": key });
const basic = credential();
add("validate-only", "validate", { credential: basic }, { result: validation(basic) }, [
  getConfig(),
  validateExchange(basic),
]);
add("verify", "verify", { credential: basic }, { result: receipt }, [
  getConfig(),
  validateExchange(basic),
  broadcastExchange(basic),
]);
for (const [id, value] of Object.entries({
  source: credential(undefined, undefined, "did:example:buyer"),
  reference: credential(prepared("125", { externalId: "order-test" }), {
    spt: "spt_test_only",
    externalId: "order-test",
  }),
  "buyer-reference": credential(undefined, { spt: "spt_test_only", externalId: "buyer-test" }),
  "empty-reference": credential(prepared("125", { externalId: "" }), {
    spt: "spt_test_only",
    externalId: "",
  }),
})) {
  const result = {
    ...receipt,
    ...(value.payload.externalId === undefined ? {} : { externalId: value.payload.externalId }),
  };
  add(`verify-${id}`, "verify", { credential: value }, { result }, [
    getConfig(),
    validateExchange(value),
    broadcastExchange(value, { receipt: result, receiptHeader: encode(result) }),
  ]);
}
for (const [id, payload] of Object.entries({
  missing: { spt: "spt_test_only" },
  different: { spt: "spt_test_only", externalId: "other" },
  empty: { spt: "spt_test_only", externalId: "" },
})) {
  add(
    `reference-${id}`,
    "verify",
    { credential: credential(prepared("125", { externalId: "order-test" }), payload) },
    failure("invalid-credential"),
    [getConfig()],
  );
}
for (const [id, change] of Object.entries({
  amount: { amount: "2" },
  reference: { externalId: "other" },
  metadata: { metadata: { purpose: "other" } },
})) {
  const request = { amount: "1.25", externalId: "order-test", metadata: { purpose: "original" } };
  add(
    `route-${id}`,
    "route-binding",
    {
      method: "stripe",
      intent: "charge",
      request,
      replacement_request: { ...request, ...change },
      credential_payload: { spt: "spt_test_only", externalId: "order-test" },
    },
    { result: { status: 402 } },
    [getConfig()],
  );
}
const problem = {
  type: "https://paymentauth.org/problems/verification-failed",
  title: "Payment Verification Failed",
  status: 402,
  detail: "Synthetic Stripe rejection.",
};
add(
  "validation-rejected",
  "verify",
  { credential: basic },
  failure("payment-failed", { problem }),
  [getConfig(), validateExchange(basic, { success: false, problem })],
);
for (const [id, value] of Object.entries({
  rejected: problem,
  pending: {
    type: "https://paymentauth.org/problems/settlement-unavailable",
    title: "Settlement Pending",
    status: 503,
    detail: "Synthetic payment is pending.",
  },
}))
  add(
    `broadcast-${id}`,
    "verify",
    { credential: basic },
    failure("payment-failed", { problem: value }),
    [getConfig(), validateExchange(basic), broadcastExchange(basic, { problem: value })],
  );
for (const [id, mutate] of Object.entries({
  challenge: (value) => {
    value.challenge.id = "other";
  },
  token: (value) => {
    value.credential.payload.spt = "spt_other";
  },
  source: (value) => {
    value.source = "did:example:other";
  },
  method: (value) => {
    value.method = "tempo";
  },
})) {
  const value = structuredClone(validation(basic));
  mutate(value);
  add(
    `validation-inconsistent-${id}`,
    "verify",
    { credential: basic, include_problem: false },
    failure("payment-failed"),
    [getConfig(), validateExchange(basic, value)],
  );
}
for (const [id, response] of Object.entries({
  missing: {},
  failed: { receipt: { ...receipt, status: "failed" } },
  method: { receipt: { ...receipt, method: "card" } },
  challenge: { receipt: { ...receipt, challengeId: "other-challenge" } },
  "missing-challenge": {
    receipt: {
      method: receipt.method,
      reference: receipt.reference,
      status: receipt.status,
      timestamp: receipt.timestamp,
    },
  },
}))
  add(
    `receipt-${id}`,
    "verify",
    { credential: basic, include_problem: false },
    failure("payment-failed"),
    [getConfig(), validateExchange(basic), broadcastExchange(basic, response)],
  );
const retry = broadcastExchange(basic);
retry.response = { status: 503, headers: { "retry-after": "0" } };
add("idempotency-retry", "verify", { credential: basic }, { result: receipt }, [
  getConfig(),
  validateExchange(basic),
  retry,
  broadcastExchange(basic, undefined, { same: "broadcast-key" }),
]);
add("idempotency-disabled", "verify", { credential: basic }, { result: receipt }, [
  getConfig({ ...config, featureFlags: { idempotencyKeyEnabled: false } }),
  validateExchange(basic),
  broadcastExchange(basic, undefined, null),
]);

export const stripeCases = { cases };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.stdout.write(JSON.stringify(stripeCases, null, 2) + "\n");

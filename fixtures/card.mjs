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

export const cardCases = { cases };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.stdout.write(`${JSON.stringify(cardCases, null, 2)}\n`);

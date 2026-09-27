import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const sellerId = "11111111-1111-4111-8111-111111111111";
const transactionId = "22222222-2222-4222-8222-222222222222";
const approvalId = "33333333-3333-4333-8333-333333333333";
const paymentId = "pay_0123456789abcdef0123456789abcdef";
const recipient = "0x1111111111111111111111111111111111111111";
const payer = "0x2222222222222222222222222222222222222222";
const proxy = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001";
const asset = "0x3333333333333333333333333333333333333333";
const resource = { url: "https://seller.example/data", mimeType: "application/json" };
const buyerHeaders = { "x-api-key": "test-only-buyer-key" };
const sellerHeaders = { "x-api-key": "test-only-seller-key" };
const clone = (value) => structuredClone(value);
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const exchange = (method, path, headers, json, response, status = 200) => ({
  request: { method, path, headers, ...(json === undefined ? {} : { json }) },
  response: { status, json: response },
});
const cases = [];
const add = (id, suite, operation, input, expect, exchanges) => {
  cases.push(
    clone({
      id,
      suite,
      operation,
      input,
      expect,
      ...(exchanges ? { platform: { exchanges } } : {}),
    }),
  );
};
export const x402FailureMessages = {
  "invalid-input": "Invalid input.",
  "payment-failed": "Payment failed.",
  "payment-timeout": "Payment timed out.",
  "payment-cancelled": "Payment cancelled.",
  "unsupported-capability": "Unsupported payment capability.",
  "api-error": "InFlow API request failed.",
};
const failure = (code, details, status) => ({
  error: {
    code,
    message: x402FailureMessages[code],
    ...(details ? { details } : {}),
    ...(status ? { http_status: status } : {}),
  },
});
const identifierSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    id: { type: "string", minLength: 16, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" },
    required: { type: "boolean" },
  },
  required: ["required"],
};
const identifier = (id = paymentId) => ({
  info: { required: false, id },
  schema: identifierSchema,
});
const balance = {
  scheme: "balance",
  network: "inflow:1",
  asset: "USDC",
  amount: "100000000",
  payTo: sellerId,
  maxTimeoutSeconds: 300,
  extra: {},
};
const exact = {
  scheme: "exact",
  network: "eip155:8453",
  asset,
  amount: "1000000",
  payTo: recipient,
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
};
const permit2 = { ...exact, extra: { assetTransferMethod: "permit2", permit2Proxy: proxy } };
const exactData = {
  signature: `0x${"ab".repeat(65)}`,
  authorization: {
    from: payer,
    to: recipient,
    value: "1000000",
    validAfter: "1700000000",
    validBefore: "1700000300",
    nonce: `0x${"12".repeat(32)}`,
  },
};
const payload = (accepted = balance) => ({
  x402Version: 2,
  accepted,
  resource,
  payload: accepted.scheme === "balance" ? { transactionId } : exactData,
  extensions: { "payment-identifier": identifier() },
});
const permit2Payload = {
  ...payload(permit2),
  payload: {
    signature: exactData.signature,
    permit2Authorization: {
      permitted: { token: asset, amount: "1000000" },
      from: payer,
      spender: proxy,
      nonce: "1",
      deadline: "1700000300",
      witness: { to: recipient, validAfter: "1700000000", extra: "0x" },
    },
  },
};
const supported = {
  kinds: [balance, exact].map(({ scheme, network }) => ({ scheme, network, x402Version: 2 })),
};
const buyerSupport = () =>
  exchange("GET", "/v1/transactions/x402-supported", buyerHeaders, undefined, supported);
const created = {
  amount: "1",
  currency: "USDC",
  approvalId,
  approvalStatus: "PENDING",
  resource,
  transactionId,
};
const create = (requirement = balance, overrides = {}, status = 200) =>
  exchange(
    "POST",
    "/v1/transactions/x402",
    buyerHeaders,
    { accept: requirement, resource, x402Version: 2, remotePaymentId: paymentId },
    { ...created, ...overrides },
    status,
  );
const poll = (body, status = 200) =>
  exchange("GET", `/v1/transactions/${transactionId}/x402`, buyerHeaders, undefined, body, status);
const cancel = (status = 204) => ({
  request: { method: "POST", path: `/v1/approvals/${approvalId}/cancel`, headers: buyerHeaders },
  response: { status },
});
const ready = (requirement = balance) => ({
  status: "PENDING",
  encodedPayload: encode(payload(requirement)),
  paymentPayload: payload(requirement),
});
const buyerInput = (requirement = balance) => ({
  api_key: buyerHeaders["x-api-key"],
  requirement,
  context: { resource, x402Version: 2 },
  payment_id: paymentId,
});
const signed = (requirement = balance) => ({
  result: {
    encodedPayload: ready(requirement).encodedPayload,
    paymentPayload: payload(requirement),
    transactionId,
  },
});

for (const [name, value, valid] of [
  ["minimum", "a".repeat(16), true],
  ["maximum", "a".repeat(128), true],
  ["mixed", "ABC_def-0123456789", true],
  ["short", "a".repeat(15), false],
  ["long", "a".repeat(129), false],
  ["space", "pay_0123456789 abcdef", false],
  ["unicode", "pay_0123456789éabcdef", false],
  ["empty", "", false],
  ["null", null, false],
])
  add(
    `x402.core.identifier-${name}`,
    "x402-core",
    "x402.core.identifier-valid",
    { value },
    { result: valid },
  );
add(
  "x402.core.identifier-declaration",
  "x402-core",
  "x402.core.identifier-declaration",
  {},
  { result: { info: { required: false }, schema: identifierSchema } },
);
for (const required of [false, true]) {
  const declaration = { info: { required, merchant: "test-shop" }, schema: identifierSchema };
  add(
    `x402.core.identifier-entry-${required}`,
    "x402-core",
    "x402.core.identifier-entry",
    { declaration, payment_id: paymentId },
    {
      result: {
        info: { required, merchant: "test-shop", id: paymentId },
        schema: identifierSchema,
      },
    },
  );
}
add(
  "x402.core.identifier-invalid-entry",
  "x402-core",
  "x402.core.identifier-entry",
  { declaration: { info: { required: false }, schema: identifierSchema }, payment_id: "short" },
  { result: null },
);

for (const [name, requirement] of [
  ["balance", balance],
  ["exact", exact],
])
  add(
    `x402.buyer.ready-${name}`,
    "x402-buyer",
    "x402.buyer.sign",
    buyerInput(requirement),
    signed(requirement),
    [buyerSupport(), create(requirement), poll(ready(requirement))],
  );
for (const status of ["INITIATED", "PENDING", "PROCESSING", "SETTLED"]) {
  add(
    `x402.buyer.wait-${status.toLowerCase()}`,
    "x402-buyer",
    "x402.buyer.sign",
    buyerInput(),
    signed(),
    [buyerSupport(), create(), poll({ status }), poll(ready())],
  );
}
for (const status of ["DECLINED", "EXPIRED", "GENERAL_ERROR", "INSUFFICIENT_FUNDS"]) {
  add(
    `x402.buyer.failure-${status.toLowerCase()}`,
    "x402-buyer",
    "x402.buyer.sign",
    buyerInput(),
    failure("payment-failed", { status }),
    [buyerSupport(), create(), poll({ status })],
  );
}
add("x402.buyer.transient-poll-failure", "x402-buyer", "x402.buyer.sign", buyerInput(), signed(), [
  buyerSupport(),
  create(),
  poll({ code: "TEMPORARY_ERROR" }, 503),
  poll(ready()),
]);
for (const status of [401, 403, 404]) {
  const body = { errors: [{ code: "DENIED", message: "Access denied." }] };
  add(
    `x402.buyer.permanent-poll-${status}`,
    "x402-buyer",
    "x402.buyer.sign",
    buyerInput(),
    failure("api-error", { body }, status),
    [buyerSupport(), create(), poll(body, status)],
  );
}
add("x402.buyer.rate-limited-poll", "x402-buyer", "x402.buyer.sign", buyerInput(), signed(), [
  buyerSupport(),
  create(),
  poll({ code: "RATE_LIMITED" }, 429),
  poll(ready()),
]);
const delayedReady = poll(ready());
delayedReady.response.delay_ms = 1000;
add(
  "x402.buyer.timeout-during-poll",
  "x402-buyer",
  "x402.buyer.sign",
  { ...buyerInput(), timeout_ms: 500 },
  failure("payment-timeout"),
  [buyerSupport(), create(), delayedReady],
);
add(
  "x402.buyer.create-not-retried",
  "x402-buyer",
  "x402.buyer.sign",
  buyerInput(),
  failure("api-error", { body: { code: "TEMPORARY_ERROR" } }, 503),
  [
    buyerSupport(),
    exchange(
      "POST",
      "/v1/transactions/x402",
      buyerHeaders,
      create().request.json,
      { code: "TEMPORARY_ERROR" },
      503,
    ),
  ],
);
add(
  "x402.buyer.invalid-identifier",
  "x402-buyer",
  "x402.buyer.sign",
  { ...buyerInput(), payment_id: "short" },
  failure("invalid-input"),
  [buyerSupport()],
);
add(
  "x402.buyer.permit2-external-only",
  "x402-buyer",
  "x402.buyer.sign",
  buyerInput(permit2),
  failure("unsupported-capability"),
  [buyerSupport()],
);
add(
  "x402.buyer.unsupported-network",
  "x402-buyer",
  "x402.buyer.sign",
  buyerInput({ ...exact, network: "eip155:999999" }),
  failure("unsupported-capability"),
  [buyerSupport()],
);
add(
  "x402.buyer.cancel",
  "x402-buyer",
  "x402.buyer.cancel",
  buyerInput(),
  failure("payment-cancelled"),
  [buyerSupport(), create(), cancel()],
);
add(
  "x402.buyer.cancel-api-failure",
  "x402-buyer",
  "x402.buyer.cancel",
  buyerInput(),
  failure("payment-cancelled"),
  [buyerSupport(), create(), cancel(503)],
);
add(
  "x402.buyer.concurrent-await",
  "x402-buyer",
  "x402.buyer.concurrent-await",
  buyerInput(),
  signed(),
  [buyerSupport(), create(), poll(ready())],
);
add(
  "x402.buyer.timeout",
  "x402-buyer",
  "x402.buyer.sign",
  { ...buyerInput(), timeout_ms: 1000, poll_interval_ms: 1100 },
  failure("payment-timeout"),
  [buyerSupport(), create(), poll({ status: "INITIATED" })],
);

const sellerInput = (payment = payload(), requirements = balance) => ({
  api_key: sellerHeaders["x-api-key"],
  payment_payload: payment,
  payment_requirements: requirements,
});
const facilitator = (
  operation,
  input,
  response,
  status = 200,
  wirePayload = input.payment_payload,
) =>
  exchange(
    "POST",
    `/v1/x402/${operation}`,
    input.api_key ? sellerHeaders : {},
    {
      x402Version: 2,
      paymentPayload: wirePayload,
      paymentRequirements: input.payment_requirements,
    },
    response,
    status,
  );
const valid = { isValid: true, payer };
const settlement = {
  success: true,
  transaction: transactionId,
  network: "inflow:1",
  payer,
  amount: "100000000",
};
for (const [name, operation, response, status] of [
  ["verify", "verify", valid, 200],
  ["verify-rejected", "verify", { isValid: false, invalidReason: "invalid_payload" }, 200],
  [
    "verify-allowance",
    "verify",
    { isValid: false, invalidReason: "permit2_allowance_required" },
    412,
  ],
  ["settle", "settle", settlement, 200],
  [
    "settle-rejected",
    "settle",
    { success: false, transaction: "", errorReason: "settlement_failed" },
    200,
  ],
]) {
  const input = name === "verify-allowance" ? sellerInput(permit2Payload, permit2) : sellerInput();
  add(
    `x402.seller.${name}`,
    "x402-seller",
    `x402.seller.${operation}`,
    input,
    { result: response },
    [facilitator(operation, input, response, status)],
  );
}
for (const [name, operation, response, status] of [
  ["verify-http-failure", "verify", { code: "TEMPORARY_ERROR" }, 503],
  ["settle-http-failure", "settle", { code: "TEMPORARY_ERROR" }, 503],
  [
    "settle-conflict",
    "settle",
    { success: false, transaction: "", errorReason: "idempotency_conflict" },
    409,
  ],
  ["settle-unrelated-conflict", "settle", { code: "CONFLICT" }, 409],
  ["verify-unrecognized-412", "verify", { code: "PRECONDITION_FAILED" }, 412],
]) {
  const input = sellerInput();
  add(
    `x402.seller.${name}`,
    "x402-seller",
    `x402.seller.${operation}`,
    input,
    failure("api-error", { body: response }, status),
    [facilitator(operation, input, response, status)],
  );
}
for (const exhausted of [false, true]) {
  const input = sellerInput();
  const pending = { success: false, transaction: "", errorReason: "idempotency_pending" };
  const pendingExchange = facilitator("settle", input, pending, 409);
  pendingExchange.response.headers = { "retry-after": "0" };
  const exchanges = Array.from({ length: exhausted ? 5 : 2 }, () => clone(pendingExchange));
  if (!exhausted) exchanges.push(facilitator("settle", input, settlement));
  add(
    `x402.seller.settle-pending-${exhausted ? "exhausted" : "resolved"}`,
    "x402-seller",
    "x402.seller.settle",
    input,
    exhausted ? failure("api-error", { body: pending }, 409) : { result: settlement },
    exchanges,
  );
}
const solana = {
  ...exact,
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  payTo: "11111111111111111111111111111111",
  extra: { assetTransferMethod: "solana" },
};
for (const [name, requirement, inner, key] of [
  ["transaction-id", balance, { transactionId }, "transactionId"],
  ["transaction", solana, { transaction: "test-only-signed-transaction" }, "transaction"],
  ["signature", exact, exactData, "signature"],
]) {
  const payment = {
    ...payload(requirement),
    payload: inner,
    extensions: { "test-extension": { info: { value: "preserve" } } },
  };
  const input = sellerInput(payment, requirement);
  const value = inner[key];
  const id = `pay_${createHash("sha256").update(`${key}:${value}`).digest("hex").slice(0, 32)}`;
  const expectedPayload = {
    ...payment,
    extensions: { ...payment.extensions, "payment-identifier": identifier(id) },
  };
  const response = { ...settlement, network: requirement.network, amount: requirement.amount };
  add(
    `x402.seller.identifier-${name}`,
    "x402-seller",
    "x402.seller.verify-settle",
    input,
    { result: { verification: valid, settlement: response } },
    [
      facilitator("verify", input, valid, 200, expectedPayload),
      facilitator("settle", input, response, 200, expectedPayload),
    ],
  );
}
const anonymousInput = { payment_payload: payload(exact), payment_requirements: exact };
add(
  "x402.seller.anonymous-verify",
  "x402-seller",
  "x402.seller.verify",
  anonymousInput,
  { result: valid },
  [facilitator("verify", anonymousInput, valid)],
);

const config = {
  sellerId,
  assets: [
    {
      assetId: asset,
      assetName: "USDC",
      currency: "USDC",
      blockchain: "BASE",
      network: exact.network,
      decimals: 6,
      assetTransferMethod: "eip3009",
      permit2Proxy: proxy,
      tokenName: "USDC",
      tokenVersion: "2",
    },
  ],
  wallets: [{ address: recipient, blockchain: "BASE", network: exact.network }],
  paymentMethods: [{ scheme: "balance", network: "inflow:1", payTo: sellerId, decimals: 8 }],
  supported: supported.kinds,
};
const offer = {
  scheme: "exact",
  network: exact.network,
  payTo: recipient,
  price: { asset, amount: "1000000" },
  maxTimeoutSeconds: 300,
  extra: { assetName: "USDC", name: "USDC", version: "2", assetTransferMethod: "eip3009" },
};
const balanceOffer = {
  scheme: "balance",
  network: "inflow:1",
  payTo: sellerId,
  price: { asset: "USDC", amount: "100000000" },
  maxTimeoutSeconds: 300,
  extra: { assetName: "USDC" },
};
for (const [name, options, result] of [
  ["default", { price: "$1" }, [offer, balanceOffer]],
  ["currency", { price: "1 USDC" }, [offer, balanceOffer]],
  ["balance-only", { price: "$1", schemes: ["balance"] }, [balanceOffer]],
  ["network-only", { price: "$1", networks: [exact.network] }, [offer]],
  ["intersect-filters", { price: "$1", schemes: ["balance"], networks: [exact.network] }, []],
  [
    "large-amount",
    { price: "9007199254740993 USDC", schemes: ["exact"] },
    [{ ...offer, price: { asset, amount: "9007199254740993000000" } }],
  ],
])
  add(
    `x402.seller.offers-${name}`,
    "x402-seller",
    "x402.seller.offers",
    { config, options },
    { result },
  );
for (const [name, price] of [
  ["negative", "-1 USDC"],
  ["exponent", "1e3 USDC"],
  ["precision", "1.0000001 USDC"],
  ["currency-missing", "1"],
]) {
  add(
    `x402.seller.invalid-price-${name}`,
    "x402-seller",
    "x402.seller.offers",
    { config, options: { price } },
    failure("invalid-input"),
  );
}
const meteredConfig = clone(config);
meteredConfig.supported.push({
  scheme: "upto",
  network: exact.network,
  x402Version: 2,
  extra: {
    assetTransferMethod: "permit2",
    permit2Proxy: "0x4444444444444444444444444444444444444444",
    facilitatorAddress: payer,
  },
});
add(
  "x402.seller.metered-explicit",
  "x402-seller",
  "x402.seller.offers",
  { config: meteredConfig, options: { price: "$1", schemes: ["upto"] } },
  {
    result: [
      { ...offer, scheme: "upto", extra: { ...offer.extra, ...meteredConfig.supported[2].extra } },
    ],
  },
);
add(
  "x402.seller.metered-not-default",
  "x402-seller",
  "x402.seller.offers",
  { config: meteredConfig, options: { price: "$1" } },
  { result: [offer, balanceOffer] },
);
const incomplete = clone(meteredConfig);
delete incomplete.supported[2].extra.facilitatorAddress;
add(
  "x402.seller.metered-incomplete-config",
  "x402-seller",
  "x402.seller.offers",
  { config: incomplete, options: { price: "$1", schemes: ["upto"] } },
  { result: [] },
);

const sponsoredConfig = clone(config);
sponsoredConfig.assets[0].supportsEip7702 = true;
const sponsorSupport = {
  kinds: [
    { scheme: "exact", network: exact.network, x402Version: 2, extra: { supportsEip7702: true } },
  ],
  extensions: ["inflowEip7702GasSponsoring"],
};
const sponsorOffer = {
  ...offer,
  extra: {
    ...offer.extra,
    assetTransferMethod: "permit2",
    permit2Proxy: proxy,
    supportsEip7702: true,
  },
};
for (const [name, suppliedConfig, suppliedSupport, enabled] of [
  ["advertised", sponsoredConfig, sponsorSupport, true],
  ["token-unconfirmed", config, sponsorSupport, false],
  ["facilitator-unconfirmed", sponsoredConfig, { ...sponsorSupport, extensions: [] }, false],
  ["network-unconfirmed", sponsoredConfig, { ...sponsorSupport, kinds: [] }, false],
]) {
  const selectedOffer = clone(sponsorOffer);
  if (!suppliedConfig.assets[0].supportsEip7702) delete selectedOffer.extra.supportsEip7702;
  add(
    `x402.seller.sponsorship-${name}`,
    "x402-seller",
    "x402.seller.route",
    {
      config: suppliedConfig,
      supported: suppliedSupport,
      options: { price: "$1", schemes: ["exact"], assetTransferMethod: "permit2" },
    },
    {
      result: {
        accepts: [selectedOffer],
        ...(enabled
          ? { extensions: { inflowEip7702GasSponsoring: { info: { version: "1" } } } }
          : {}),
      },
    },
  );
}

const permitFields = [
  ["from", "^0x[a-fA-F0-9]{40}$", "The address of the sender."],
  ["asset", "^0x[a-fA-F0-9]{40}$", "The address of the ERC-20 token contract."],
  ["spender", "^0x[a-fA-F0-9]{40}$", "The address of the spender (Canonical Permit2)."],
  ["amount", "^[0-9]+$", "The amount to approve (uint256). Typically MaxUint."],
  ["nonce", "^[0-9]+$", "The current nonce of the sender."],
  ["deadline", "^[0-9]+$", "The timestamp at which the signature expires."],
  [
    "signature",
    "^0x[a-fA-F0-9]+$",
    "The 65-byte concatenated signature (r, s, v) as a hex string.",
  ],
  ["version", "^[0-9]+(\\.[0-9]+)*$", "Schema version identifier."],
];
const eip2612Declaration = {
  info: {
    description: "The facilitator accepts EIP-2612 gasless Permit to `Permit2` canonical contract.",
    version: "1",
  },
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: Object.fromEntries(
      permitFields.map(([name, pattern, description]) => [
        name,
        { type: "string", pattern, description },
      ]),
    ),
    required: permitFields.map(([name]) => name),
  },
};
const bothConfig = clone(sponsoredConfig);
bothConfig.assets[0].supportsEip2612 = true;
const bothSupport = {
  ...sponsorSupport,
  extensions: ["eip2612GasSponsoring", "inflowEip7702GasSponsoring"],
};
add(
  "x402.seller.sponsorship-prefers-eip2612",
  "x402-seller",
  "x402.seller.route",
  {
    config: bothConfig,
    supported: bothSupport,
    options: { price: "$1", schemes: ["exact"], assetTransferMethod: "permit2" },
  },
  {
    result: {
      accepts: [{ ...sponsorOffer, extra: { ...sponsorOffer.extra, supportsEip2612: true } }],
      extensions: { eip2612GasSponsoring: eip2612Declaration },
    },
  },
);
const missingDomain = clone(bothConfig);
delete missingDomain.assets[0].tokenVersion;
const missingDomainOffer = clone(sponsorOffer);
delete missingDomainOffer.extra.version;
missingDomainOffer.extra.supportsEip2612 = true;
add(
  "x402.seller.sponsorship-eip2612-missing-domain",
  "x402-seller",
  "x402.seller.route",
  {
    config: missingDomain,
    supported: bothSupport,
    options: { price: "$1", schemes: ["exact"], assetTransferMethod: "permit2" },
  },
  {
    result: {
      accepts: [missingDomainOffer],
      extensions: { inflowEip7702GasSponsoring: { info: { version: "1" } } },
    },
  },
);

const rejected = { isValid: false, invalidReason: "invalid_payload" };
add(
  "x402.seller.rejected-verification-no-settlement",
  "x402-seller",
  "x402.seller.verify-settle",
  sellerInput(),
  { result: { verification: rejected } },
  [facilitator("verify", sellerInput(), rejected)],
);

export const x402Cases = { cases };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.stdout.write(`${JSON.stringify(x402Cases, null, 2)}\n`);

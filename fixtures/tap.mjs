import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Public, synthetic signing seed. Never use this key outside conformance tests.
const privateKey = createPrivateKey({
  key: Buffer.from("302e020100300506032b657004220420" + "11".repeat(32), "hex"),
  format: "der",
  type: "pkcs8",
});
export const tapKey = {
  ...createPublicKey(privateKey).export({ format: "jwk" }),
  kid: "test-tap-key",
  alg: "Ed25519",
  use: "sig",
};
const created = 1800000000;
const components = ["@method", "@authority", "@path", "@query"];
const parameters = [
  ["created", created],
  ["expires", created + 300],
  ["keyid", tapKey.kid],
  ["alg", "ed25519"],
  ["nonce", "test-nonce"],
  ["tag", "agent-browser-auth"],
];
export const tapSigningExamples = [];
function signed(options = {}) {
  const fields = options.components ?? components;
  const params = options.parameters ?? parameters;
  const request = {
    method: "GET",
    url: "https://merchant.example:8443/catalog%2Fitems?q=red%20shoes&kind=a&kind=b",
    headers: {},
    ...options.request,
  };
  const url = new URL(request.url);
  const values = {
    "@method": request.method,
    "@authority": url.host,
    "@path": url.pathname,
    "@query": url.search || "?",
  };
  if (request.body_base64 !== undefined) {
    request.headers["content-type"] = "application/json";
    request.headers["content-digest"] =
      `sha-256=:${createHash("sha256").update(Buffer.from(request.body_base64, "base64")).digest("base64")}:`;
    Object.assign(values, request.headers);
  }
  const canonical =
    `(${fields.map((field) => JSON.stringify(field)).join(" ")})` +
    params.map(([name, value]) => `;${name}=${JSON.stringify(value)}`).join("");
  const base = [
    ...fields.map((field) => `${JSON.stringify(field)}: ${values[field]}`),
    `"@signature-params": ${canonical}`,
  ].join("\n");
  const signature = sign(null, Buffer.from(base), privateKey).toString("base64");
  request.headers["signature-input"] = `sig2=${options.wire ?? canonical}`;
  request.headers.signature = `sig2=:${signature}:`;
  const effective = Object.fromEntries(params);
  const facts = {
    verified: true,
    keyid: effective.keyid,
    algorithm: "ed25519",
    intent: effective.tag === "agent-payer-auth" ? "pay" : "browse",
    nonce: effective.nonce,
    created: effective.created,
    expires: effective.expires,
    coveredComponents: fields,
  };
  tapSigningExamples.push({ base, signature });
  return { request, facts, canonical };
}
const baseline = signed();
const changed = (key, value) =>
  parameters.map(([name, original]) => [name, name === key ? value : original]);
const cases = [];
const success = (facts) => ({ accepted: [facts], rejected: [] });
const rejected = (code) => ({ accepted: [], rejected: [code] });
function add(id, sample = baseline, options = {}) {
  const error = options.error;
  cases.push(
    structuredClone({
      id: `tap.${id}`,
      suite: "tap-seller",
      operation: "tap.seller.verify",
      input: {
        key: tapKey,
        steps: [{ now_ms: created * 1000, requests: [sample.request] }],
        ...options.input,
      },
      expect: {
        result: {
          steps: [error ? rejected(error) : success(sample.facts)],
          handler_calls: error ? 0 : 1,
          claim_calls: error ? 0 : 1,
          ...options.result,
        },
      },
      ...(options.exchanges ? { platform: { exchanges: options.exchanges } } : {}),
    }),
  );
}
add("bodyless");
const signatureWhitespace = structuredClone(baseline);
signatureWhitespace.request.headers.signature = `  ${signatureWhitespace.request.headers.signature.replace(/=+:$/, ":")} \t`;
add("signature-whitespace-padding", signatureWhitespace);
add("no-query", signed({ request: { url: "https://merchant.example/" } }));
for (const body of ["", '{"message":"hello"}', "\u0000\u00ff"]) {
  const body_base64 = Buffer.from(body).toString("base64");
  add(
    `body-${body_base64.length}`,
    signed({
      components: [...components, "content-digest", "content-type"],
      parameters: changed("tag", "agent-payer-auth"),
      request: { method: "POST", body_base64 },
    }),
  );
}
add("algorithm-case", signed({ parameters: changed("alg", "Ed25519") }));
add("component-order", signed({ components: [...components].reverse() }));
add("parameter-order", signed({ parameters: [...parameters].reverse() }));
add(
  "duplicate-first-position",
  signed({
    parameters: [parameters[2], ...parameters.filter(([name]) => name !== "keyid")],
    wire: baseline.canonical.replace(";created=", ';keyid="ignored";created='),
  }),
);
add("duplicate-identical-at-end", signed({ wire: baseline.canonical + ";created=" + created }));
add(
  "whitespace",
  signed({
    wire:
      baseline.canonical
        .replaceAll(" ", "   ")
        .replaceAll(";", ";  ")
        .replace("(", "(  ")
        .replace(")", "  )") + " \t",
  }),
);
add(
  "integer-serialization",
  signed({ wire: baseline.canonical.replace(";created=", ";created=000") }),
);
const escaped = signed({ parameters: changed("nonce", 'with "quotes" and \\ slash') });
add("string-escaping", escaped);
for (const [name, value] of parameters) {
  add(
    `duplicate-${name}`,
    signed({ wire: baseline.canonical.replace(`;${name}=`, `;${name}="ignored";${name}=`) }),
  );
  const code = {
    created: "SIGNATURE_LIFETIME_INVALID",
    expires: "SIGNATURE_LIFETIME_INVALID",
    keyid: "KEY_NOT_FOUND",
    alg: "SIGNATURE_INPUT_INVALID",
    nonce: "SIGNATURE_INVALID",
    tag: "SIGNATURE_INVALID",
  }[name];
  const final = {
    created: 1,
    expires: 1,
    keyid: "unknown",
    alg: "rsa",
    nonce: "tampered",
    tag: "agent-payer-auth",
  }[name];
  const request = structuredClone(baseline.request);
  request.headers["signature-input"] += `;${name}=${JSON.stringify(final)}`;
  add(`duplicate-${name}-tampered`, { request }, { error: code });
  const missing = structuredClone(baseline.request);
  missing.headers["signature-input"] = missing.headers["signature-input"].replace(
    `;${name}=${JSON.stringify(value)}`,
    "",
  );
  add(`missing-${name}`, { request: missing }, { error: "SIGNATURE_INPUT_INVALID" });
}
for (const [name, raw] of Object.entries({
  decimal: "1.5",
  token: "ignored",
  bytes: ":AQI=:",
  boolean: "?0",
  implicit: null,
})) {
  const prefix = raw === null ? ";created" : `;created=${raw}`;
  add(
    `overwritten-${name}`,
    signed({ wire: baseline.canonical.replace(";created=", `${prefix};created=`) }),
  );
}
for (const [name, suffix] of Object.entries({
  decimal: ";created=1.0",
  string: ';created="1"',
  boolean: ";created=?1",
  token: ";created=value",
  overflow: ";created=1000000000000000",
  exponent: ";created=1e3",
  unknown: ";other=1",
  escape: ';nonce="bad\\x"',
  newline: ";created=1\n",
  invalidEarlier: ";created=1e3;created=1800000000",
  invalidBytes: ";created=:A:;created=1800000000",
})) {
  const request = structuredClone(baseline.request);
  request.headers["signature-input"] += suffix;
  add(`invalid-${name.toLowerCase()}`, { request }, { error: "SIGNATURE_INPUT_INVALID" });
}
for (const [name, fields] of Object.entries({
  missing: components.slice(1),
  duplicate: [...components, "@query"],
  unsupported: [...components, "date"],
}))
  add(`components-${name}`, signed({ components: fields }), { error: "SIGNATURE_INPUT_INVALID" });
for (const [name, mutate] of Object.entries({
  method: (request) => {
    request.method = "POST";
  },
  authority: (request) => {
    request.url = request.url.replace("merchant.example", "other.example");
  },
  path: (request) => {
    request.url = request.url.replace("catalog%2Fitems", "other");
  },
  query: (request) => {
    request.url = request.url.replace("kind=a&kind=b", "kind=b&kind=a");
  },
  signature: (request) => {
    request.headers.signature = `sig2=:${Buffer.alloc(64).toString("base64")}:`;
  },
})) {
  const request = structuredClone(baseline.request);
  mutate(request);
  add(`tampered-${name}`, { request }, { error: "SIGNATURE_INVALID" });
}
for (const header of ["signature", "signature-input"]) {
  const request = structuredClone(baseline.request);
  delete request.headers[header];
  add(`missing-${header}`, { request }, { error: "SIGNATURE_INPUT_INVALID" });
}
for (const [name, value] of Object.entries({
  label: "sig1=:AAAA:",
  invalid: "sig2=:????:",
  multiple: baseline.request.headers.signature + ", sig3=:AAAA:",
})) {
  const request = structuredClone(baseline.request);
  request.headers.signature = value;
  add(`signature-${name}`, { request }, { error: "SIGNATURE_INPUT_INVALID" });
}
for (const [name, value] of [
  ["alg", "rsa"],
  ["tag", "other"],
])
  add(`unsupported-${name}`, signed({ parameters: changed(name, value) }), {
    error: "SIGNATURE_INPUT_INVALID",
  });
const bodySample = signed({
  components: [...components, "content-digest", "content-type"],
  request: { method: "POST", body_base64: Buffer.from("{}").toString("base64") },
});
for (const [name, mutate, error] of [
  [
    "body",
    (request) => {
      request.body_base64 = Buffer.from("{ }").toString("base64");
    },
    "CONTENT_DIGEST_INVALID",
  ],
  [
    "digest",
    (request) => {
      delete request.headers["content-digest"];
    },
    "CONTENT_DIGEST_INVALID",
  ],
  [
    "content-type",
    (request) => {
      delete request.headers["content-type"];
    },
    "SIGNATURE_INPUT_INVALID",
  ],
  [
    "content-type-change",
    (request) => {
      request.headers["content-type"] = "text/plain";
    },
    "SIGNATURE_INVALID",
  ],
]) {
  const request = structuredClone(bodySample.request);
  mutate(request);
  add(`body-${name}`, { request }, { error });
}
for (const [id, seconds, error] of [
  ["future", created - 1, "SIGNATURE_NOT_YET_VALID"],
  ["expires", created + 300, "SIGNATURE_EXPIRED"],
])
  add(`time-${id}`, baseline, {
    input: { steps: [{ now_ms: seconds * 1000, requests: [baseline.request] }] },
    error,
  });
for (const lifetime of [0, -1, 481])
  add(
    `lifetime-${String(lifetime).replace("-", "minus")}`,
    signed({ parameters: changed("expires", created + lifetime) }),
    { error: "SIGNATURE_LIFETIME_INVALID" },
  );
add("lifetime-480", signed({ parameters: changed("expires", created + 480) }));
add("lookup-after-expiration", baseline, {
  input: { resolver_completion_ms: (created + 301) * 1000 },
});
add("resolver-failure", baseline, {
  input: { resolver_failure: true },
  error: "CUSTOM_RESOLVER_FAILED",
});
add("store-failure", baseline, {
  input: { store_failure: true },
  error: "CUSTOM_STORE_FAILED",
  result: { claim_calls: 1 },
});
add("replay", baseline, {
  input: {
    steps: [
      { now_ms: created * 1000, requests: [baseline.request] },
      { now_ms: created * 1000, requests: [baseline.request] },
    ],
  },
  result: {
    steps: [success(baseline.facts), rejected("NONCE_REPLAYED")],
    handler_calls: 1,
    claim_calls: 2,
  },
});
add("concurrent-replay", baseline, {
  input: { steps: [{ now_ms: created * 1000, requests: [baseline.request, baseline.request] }] },
  result: {
    steps: [{ accepted: [baseline.facts], rejected: ["NONCE_REPLAYED"] }],
    handler_calls: 1,
    claim_calls: 2,
  },
});
const badSignature = structuredClone(baseline.request);
badSignature.headers.signature = `sig2=:${Buffer.alloc(64).toString("base64")}:`;
add("bad-signature-does-not-claim", baseline, {
  input: {
    steps: [
      { now_ms: created * 1000, requests: [badSignature] },
      { now_ms: created * 1000, requests: [baseline.request] },
    ],
  },
  result: {
    steps: [rejected("SIGNATURE_INVALID"), success(baseline.facts)],
    handler_calls: 1,
    claim_calls: 1,
  },
});
const keyExchange = (keys = [tapKey], response) => ({
  request: { method: "GET", path: "/keys", headers: { accept: "application/json" } },
  response: response ?? { status: 200, json: { keys } },
});
add("http-key", baseline, { input: { resolver: "http" }, exchanges: [keyExchange()] });
for (const [name, keys, error] of [
  ["missing", [], "KEY_NOT_FOUND"],
  ["duplicate", [tapKey, tapKey], "KEY_RETRIEVAL_FAILED"],
  ["wrong-use", [{ ...tapKey, use: "enc" }], "KEY_NOT_FOUND"],
  ["wrong-algorithm", [{ ...tapKey, alg: "rsa" }], "KEY_NOT_FOUND"],
  ["wrong-material", [{ ...tapKey, x: "invalid" }], "KEY_RETRIEVAL_FAILED"],
])
  add(`http-${name}`, baseline, {
    input: { resolver: "http" },
    error,
    exchanges: [keyExchange(keys)],
  });
add("http-unavailable", baseline, {
  input: { resolver: "http" },
  error: "KEY_RETRIEVAL_FAILED",
  exchanges: [keyExchange([], { status: 503 })],
});
const next = signed({ parameters: changed("nonce", "next-nonce") });
for (const [id, nowOffset, maxAge, second, exchanges] of [
  ["fresh", 0, 2000, success(next.facts), [keyExchange()]],
  [
    "outage-fallback",
    101,
    2000,
    success(next.facts),
    [keyExchange(), keyExchange([], { status: 503 })],
  ],
  [
    "outage-too-old",
    201,
    200,
    rejected("KEY_RETRIEVAL_FAILED"),
    [keyExchange(), keyExchange([], { status: 503 })],
  ],
  [
    "replacement-removes-key",
    101,
    2000,
    rejected("KEY_NOT_FOUND"),
    [keyExchange(), keyExchange([])],
  ],
]) {
  add(`cache-${id}`, baseline, {
    input: {
      resolver: "http",
      cache_ttl_ms: 100,
      cache_max_age_ms: maxAge,
      steps: [
        { now_ms: created * 1000, requests: [baseline.request] },
        { now_ms: created * 1000 + nowOffset, requests: [next.request] },
      ],
    },
    result: {
      steps: [success(baseline.facts), second],
      handler_calls: 1 + second.accepted.length,
      claim_calls: 1 + second.accepted.length,
    },
    exchanges,
  });
}
add("http-concurrent-refresh", baseline, {
  input: {
    resolver: "http",
    steps: [{ now_ms: created * 1000, requests: [baseline.request, baseline.request] }],
  },
  result: {
    steps: [{ accepted: [baseline.facts], rejected: ["NONCE_REPLAYED"] }],
    handler_calls: 1,
    claim_calls: 2,
  },
  exchanges: [keyExchange([tapKey], { status: 200, json: { keys: [tapKey] }, delay_ms: 20 })],
});
add("http-negative-cache", baseline, {
  input: {
    resolver: "http",
    steps: [
      { now_ms: created * 1000, requests: [baseline.request] },
      { now_ms: created * 1000, requests: [baseline.request] },
    ],
  },
  result: {
    steps: [rejected("KEY_NOT_FOUND"), rejected("KEY_NOT_FOUND")],
    handler_calls: 0,
    claim_calls: 0,
  },
  exchanges: [keyExchange([])],
});

export const tapCases = { cases };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.stdout.write(JSON.stringify(tapCases, null, 2) + "\n");

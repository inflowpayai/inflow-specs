# TAP Seller verification contract

This contract defines the InFlow profile of Visa Trusted Agent Protocol (TAP) agent recognition. A
Seller verifies an HTTP request signed by a trusted agent key before passing it to application code.
Verification is independent of payments: it does not identify the buyer, grant account access,
authorize a purchase, or prove settlement. Applications still perform their AEP, MPP, x402 and
business authorization checks.

This is a restricted profile, not a general-purpose Visa TAP implementation. Consumer-recognition
objects, payment containers, other signature algorithms and arbitrary HTTP signature profiles are
outside this contract. The words "must" and "reject" below describe requirements for SDKs claiming
this profile, not additional requirements imposed on every Visa TAP implementation.

## Sources and authority

- [Visa merchant specification](https://developer.visa.com/capabilities/trusted-agent-protocol/trusted-agent-protocol-specifications/):
  agent-recognition fields, intent tags, validity bounds and trusted public-key retrieval.
- [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421.html): HTTP signature parsing, component values,
  signature-base construction and cryptographic verification, particularly sections 2, 3.2 and 4.
- [RFC 9530, section 2](https://www.rfc-editor.org/rfc/rfc9530.html#section-2): content digests.
- [InFlow request profile](https://github.com/inflowpayai/inflow-node/blob/309aab2650dcb06dd652a5076dc176d5c41196d7/docs/tap/README.md):
  stronger request coverage, Ed25519, intent mapping and verification-start time semantics.
- [Node verifier and supporting modules](https://github.com/inflowpayai/inflow-node/tree/309aab2650dcb06dd652a5076dc176d5c41196d7/packages/tap-seller/src):
  implementation reference for the public verification, key-resolver and replay-store boundaries.
  Code is evidence, not authority to override the protocol or this contract.

Visa's minimum signed request components are authority and path. InFlow additionally binds the
method and query, and binds body bytes and content type for requests with bodies. Keep those
stronger requirements when implementing this contract. Do not accept a weaker request merely because
it meets Visa's minimum profile.

## Request and signature input

The application supplies the actual request method, absolute URL, headers and, when present, exact
body bytes. Strings represent UTF-8 bytes. Do not parse and reserialize JSON, reorder query
parameters, decode and re-encode the query, or replace missing signed fields with empty values.
Framework integrations must obtain the effective URL from trusted request metadata, not blindly
trust client-supplied forwarding headers. Verification must not modify caller-owned input.

The supported signed components are exactly:

| Request                   | Covered components                                       |
| ------------------------- | -------------------------------------------------------- |
| Body absent               | `@method`, `@authority`, `@path`, `@query`               |
| Body supplied, even empty | The four above, plus `content-digest` and `content-type` |

Each component appears once. Reject missing, duplicate or unsupported components rather than
silently ignoring them. Preserve the signer's component order in the signature base. Derive values
using RFC 9421: method is case-sensitive, authority includes a non-default port, path remains
encoded, and query includes its leading `?`. An absent query contributes `?`, not an empty string.

The profile uses one `sig2` entry in each of `Signature-Input` and `Signature`. Support for other
labels or multiple signatures is not part of this profile. Reject an input outside that supported
shape; never select a signature by trial verification or combine fields from different signatures.

The signature parameters are `created`, `expires`, `keyid`, `alg`, `nonce` and `tag`. All are
required; unknown parameters are outside this profile. Times are integer Unix seconds. Key
identifiers and nonces are nonempty strings. The accepted algorithm spellings are `ed25519` and
`Ed25519`, both identifying Ed25519, and the accepted tags are `agent-browser-auth` and
`agent-payer-auth`.

Parse the supported fields as RFC 9421 Structured Fields, including valid whitespace and string
escaping. Parameter order is chosen by the signer; it is not fixed to the order listed above. Use
the last value of a repeated parameter, retaining its first position in parameter order, as
specified by
[RFC 8941, section 4.2.3.2](https://www.rfc-editor.org/rfc/rfc8941.html#section-4.2.3.2). Apply
type, time, algorithm and key checks to those effective values, and use those same values to
serialize `@signature-params`. Earlier occurrences must still be syntactically valid Structured
Field values. Preserve parameter order and the received algorithm spelling; serialize whitespace,
integers and escaped strings according to Structured Fields rather than signing the raw received
substring. The signature label is not part of `@signature-params`. Malformed input, invalid
effective field types and invalid signature encoding must fail verification. This parameter rule
does not permit duplicate covered components or select the last of arbitrary repeated HTTP header
lines.

For a body, require the actual `Content-Type` and `Content-Digest` fields. The profile uses
`sha-256=:BASE64_DIGEST:` over the exact supplied bytes, including an explicitly empty body. Verify
the digest as well as the signature covering that digest. A valid signature over a digest alone does
not prove that the received body matches it. HTTP header names are case-insensitive; ambiguous
duplicate values must not be silently collapsed into a chosen value.

## Time, cryptography and replay

Evaluate the validity interval when verification starts: `created <= now < expires`, with
`0 < expires - created <= 480` seconds. InFlow signs with a five-minute interval; verifiers accept
up to eight minutes. Key retrieval and replay storage may finish after expiration. Do not add a
second expiration check after those operations or silently grant clock-skew tolerance.

Resolve the trusted key for `keyid` and the accepted algorithm, reconstruct the signature base from
the received request, then cryptographically verify its Ed25519 signature. The key material and
algorithm must agree. Missing keys and failed verification must never produce verified facts.

After cryptographic verification succeeds, atomically claim the `(keyid, nonce)` pair through the
replay store. Reject an already claimed pair. Invalid signatures must not consume a nonce. A
replay-store failure must not invoke the protected handler. Concurrent requests arriving within the
validity interval must not both pass using the same retained claim.

The default memory store is process-local and retains claims until the signature expiration.
Applications with multiple processes or instances must supply a shared atomic store. Expired claims
can be removed; callers must not interpret this as lifetime uniqueness of a nonce. Time is checked
at verification start, so this policy does not promise deduplication of arbitrarily delayed
operations after their claims expire. It is not payment idempotency or a durable payment ledger.

## Trusted keys and cache behavior

The default resolver retrieves keys from `https://mcp.visa.com/.well-known/jwks`. The application
may configure a different trusted key source or supply a resolver. Neither a signature's `keyid` nor
other untrusted request data chooses a URL to fetch. A custom resolver is responsible for returning
a trusted key corresponding to the requested identifier and algorithm; it is not a bypass of
cryptographic verification.

The built-in resolver selects Ed25519 public keys by `kid`: `kty` is `OKP`, `crv` is `Ed25519`,
`alg` is one of the accepted spellings, and `use`, if supplied, is `sig`. Unrelated keys may be
ignored. Duplicate eligible key identifiers and unusable selected key material cannot establish
trust. Build a replacement cache before publishing it so a failed refresh does not expose a
partially updated key set.

The Node reference defaults are a one-hour fresh-cache interval, a 24-hour maximum age for outage
fallback, and a three-second retrieval timeout. These are configurable SDK defaults, not Visa's
signature-validity rules. Age is measured since the last successful key-set refresh:

1. Use a known fresh cached key without a fetch. Remember a missing key within that cache generation
   to avoid repeatedly fetching the same missing identifier.
2. Refresh for a stale cache or a previously unseen identifier. Concurrent refreshes share one
   outstanding retrieval. A successful refresh replaces the cache, including removing old keys, and
   clears remembered misses.
3. If retrieval fails, use a previously trusted matching key only while it is within the configured
   outage-fallback age. This is permission to use a cached key during a temporary outage, not to
   accept an unknown key or a key removed by a successful refresh.
4. Without a usable cached key, fail closed. Distinguish successful retrieval with no matching key
   from retrieval failure.

The maximum outage age is not an independent hard expiry applied to a still-fresh cache. Signature
expiration and key-cache freshness are separate checks. Applications choosing custom cache settings
or a custom resolver own their trust and availability policy.

## Results and failures

Success returns verified facts: signing key identifier, normalized `ed25519` algorithm, intent,
nonce, creation and expiration times, and covered components in their signed order. Map
`agent-browser-auth` to `browse` and `agent-payer-auth` to `pay`. An intent tag is the signer's
assertion, not proof of a customer's consent or a successful payment.

The middleware invokes application code only after all verification steps, including the replay
claim, succeed. On failure, return an error, not partial success. The application owns HTTP status
and response presentation. SDKs may use language-appropriate error types; their shared adapters must
preserve these distinctions rather than flattening failures into a boolean:

| Failure category             | Node reference code                                 |
| ---------------------------- | --------------------------------------------------- |
| Missing or malformed input   | `SIGNATURE_INPUT_INVALID`                           |
| Body does not match digest   | `CONTENT_DIGEST_INVALID`                            |
| Invalid validity interval    | `SIGNATURE_LIFETIME_INVALID`                        |
| Before creation / expired    | `SIGNATURE_NOT_YET_VALID` / `SIGNATURE_EXPIRED`     |
| Trusted key absent           | `KEY_NOT_FOUND`                                     |
| Key retrieval unavailable    | `KEY_RETRIEVAL_FAILED`                              |
| Cryptographic check failed   | `SIGNATURE_INVALID`                                 |
| Nonce already claimed        | `NONCE_REPLAYED`                                    |
| Custom resolver/store failed | Propagated failure; no protected handler invocation |

## Conformance evidence

Acceptance requires calling the public verifier and middleware. A test-only signature parser or
verifier cannot stand in for the SDK. Use synthetic keys, fixed clocks and controlled key endpoints;
do not contact production key services or make payments as part of conformance runs.

Cover signed bodyless and body-bearing requests, both intent tags and accepted algorithm spellings,
different valid component and parameter orders, and Structured Field serialization. Include
tampering with each bound request value, changed body bytes, missing/duplicate fields, unsupported
components and algorithms, malformed signatures, time boundaries and a lookup completing after
expiration. Re-sign deliberately different valid inputs; modifying a header without re-signing it
does not test acceptance of an alternative valid representation.

Exercise trusted-key selection, cache hits and replacement, unknown keys, retrieval failure with and
without a usable cache, concurrent refresh, nonce replay, concurrent claims and custom-store
failure. Assert that rejection prevents the protected handler from running and that invalid
signatures do not claim nonces. Shared vectors establish cross-language agreement; language-native
tests also cover custom implementations and concurrency.

## Shared adapter operation

Generate the executable corpus with `node fixtures/tap.mjs`. Select the mandatory `tap-seller`
suite. The [case schema](../schemas/tap-case.schema.json) defines `tap.seller.verify` inputs and
observations. These cases verify the SDK through its public verifier, middleware, key resolver and
replay store; a test-only implementation of any of those behaviors is not conformance evidence.

Each case creates one verifier and replay store, reused across its ordered `steps`. A step sets the
injected clock to `now_ms`, then verifies its `requests` concurrently and waits for all of them to
finish. Decode `body_base64` into exact bytes when present, including the empty string. Pass the
request headers through without pre-parsing signatures or changing their values.

By default, an application-supplied resolver returns the synthetic public `key` for its matching
identifier and algorithm. `resolver: "http"` instead uses the SDK's built-in resolver pointed at
`/keys` on the runner's injected `base_url`. The runner checks every actual key request against the
script, including missing or extra requests. Optional `cache_ttl_ms` and `cache_max_age_ms`
configure that resolver. The adapter must not fetch, cache, select or refresh these HTTP keys
itself.

`resolver_completion_ms` advances the clock inside the custom resolver to test a lookup completing
after expiration. `resolver_failure` and `store_failure` make the corresponding application-supplied
implementation throw a synthetic error. They must not replace SDK validation or cryptographic
checks. Wrap the SDK's memory replay store to count claims; call that store for every claim unless
the explicit store-failure case applies.

Return `steps`, `handler_calls` and `claim_calls`. Each observed step has `accepted` verified-fact
objects and `rejected` error codes. Record facts from the protected middleware callback, not by
parsing the fixture. Increment `handler_calls` only inside that callback. Each concurrent batch has
at most one accepted request in this corpus; sort its rejected codes lexically. Preserve step order.
Map equivalent SDK failure categories to the table above. Only the two injected failures become
`CUSTOM_RESOLVER_FAILED` and `CUSTOM_STORE_FAILED`; an unrelated exception fails the adapter. Verify
that caller-owned input is unchanged on both accepted and rejected paths.

The corpus uses a public synthetic Ed25519 seed and real signatures, with an isolated local HTTP key
service where required. It does not certify production key registration, browser proxy
configuration, distributed replay storage, or live payment authorization. The separate
[Node signing vectors](https://github.com/inflowpayai/inflow-node/tree/309aab2650dcb06dd652a5076dc176d5c41196d7/docs/tap)
remain useful signing evidence; they do not replace these public-SDK verification cases.

# MPP SDK cases

The [MPP corpus](../fixtures/mpp.mjs) checks InFlow's Core, Buyer, and Seller integration with
[MPP](https://mpp.dev/). It is development tooling, not a payment service or a runtime dependency.

Generate the runner's case index from the single maintained source:

```sh
node fixtures/mpp.mjs > /tmp/inflow-mpp-cases.json
```

Use that file as `--cases` with the [runner](../runner/README.md). Select `mpp-core`, `mpp-buyer`,
and/or `mpp-seller` for the roles implemented by the SDK. Cases without a feature declaration within
each selected suite are mandatory. The corpus does not certify unselected roles, optional MCP
integration, TAP, live settlement, or the platform's database/replay implementation.

### Seller subscription capability

Seller cases with the `subscription` intent declare the feature `mpp-seller-subscriptions`. An SDK
selecting `mpp-seller` must explicitly declare that feature as supported, or unsupported with a
reason. Supported SDKs execute every subscription case, including rejection and route-binding
checks. Unsupported SDKs retain those cases as explicit skips in their reports; their charge cases
remain mandatory. This declaration does not exclude any Buyer subscription cases.

For example, an integration whose upstream framework cannot expose subscription terms can report
that limitation without claiming subscription conformance or omitting the entire Seller suite. A
failing implementation of a supported feature must be fixed, not reclassified as unsupported.

Adapters adopting this contract revision must supply the declaration. Node and Go support Seller
subscriptions and must list `mpp-seller-subscriptions` in `supported_features` when selecting the
Seller suite. The Python integration does not expose Seller subscriptions and declares the feature
in `unsupported_features`, with its upstream limitation as the reason. Update each SDK's contract
pin and capability declaration together.

## Evidence and limits

These cases cover the InFlow HTTP contract and SDK behavior, not every feature of the underlying MPP
protocol. The Node reference inspected is commit
[`bfa2c3f`](https://github.com/inflowpayai/inflow-node/tree/bfa2c3f88b6f0c104f39887dce15779b88d42885):

- [Core codecs and literal wire vectors](https://github.com/inflowpayai/inflow-node/blob/bfa2c3f88b6f0c104f39887dce15779b88d42885/packages/mpp/test/unit/server-vectors.test.ts).
- [Buyer lifecycle](https://github.com/inflowpayai/inflow-node/blob/bfa2c3f88b6f0c104f39887dce15779b88d42885/packages/mpp-buyer/src/fulfilment.ts)
  and
  [public payment methods](https://github.com/inflowpayai/inflow-node/blob/bfa2c3f88b6f0c104f39887dce15779b88d42885/packages/mpp-buyer/src/methods.client.ts).
- [Seller methods](https://github.com/inflowpayai/inflow-node/blob/bfa2c3f88b6f0c104f39887dce15779b88d42885/packages/mpp-seller/src/methods.server.ts)
  and
  [framework integration tests](https://github.com/inflowpayai/inflow-node/blob/bfa2c3f88b6f0c104f39887dce15779b88d42885/packages/mpp-seller/test/unit/methods-server.test.ts).

The platform request, response, account, and lifecycle implementations were also inspected before
writing these fixtures. Wire fields are public contract examples; private platform source is not
distributed here. A discrepancy with the actual platform requires investigation, not automatically
changing expectations to whatever the Node implementation does.

All identifiers, API keys, signatures, addresses, and credentials are synthetic. Signatures are
opaque placeholders, not signed payments. Fixed receipt timestamps exercise data preservation, not
freshness. The distant subscription dates avoid wall-clock expiry in SDK plumbing tests; they do not
specify a permitted authorization lifetime. No case demonstrates that the platform would accept
these credentials or authorize these accounts.

## Operations

`base_url` is supplied by the runner for platform cases. `api_key` is the synthetic credential to
configure through the SDK's public client options. Challenge objects in inputs and observations use
the InFlow wire form: `request` is an encoded string. An adapter can use the SDK's public codecs to
translate a foundation library's decoded request object to or from this wire form. It must preserve
payload, source, and all supplied challenge fields.

| Operation                    | Input beyond platform configuration                                                  | Observation                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `mpp.core.encode`            | `value`: JSON value                                                                  | Encoded string                                                        |
| `mpp.core.decode`            | `value`: encoded string                                                              | Decoded JSON value                                                    |
| `mpp.core.parse-challenges`  | `headers`: one string or an array of header strings                                  | Ordered array of wire challenges                                      |
| `mpp.core.decode-credential` | `value`: encoded credential                                                          | Complete decoded credential                                           |
| `mpp.core.decode-receipt`    | `value`: encoded receipt                                                             | Complete decoded receipt                                              |
| `mpp.buyer.fulfil`           | `challenge`, `context`; optional `timeout_ms`                                        | Decoded credential, or classified SDK failure                         |
| `mpp.buyer.cancel`           | `challenge`, `context`                                                               | Caller-cancellation failure; mock also requires approval cancellation |
| `mpp.seller.prepare`         | `method`, `intent`, `request`                                                        | SDK-prepared request, or unsupported-capability failure               |
| `mpp.seller.validate`        | `credential`                                                                         | Successful validation envelope, or failure                            |
| `mpp.seller.verify`          | `credential`; optional `include_problem` (default `true`)                            | Receipt, or failure                                                   |
| `mpp.seller.route-binding`   | `method`, `intent`, `request`, `replacement_request`, `credential_payload`, `source` | `{ "status": 402 }` from the real protected-route integration         |

Use the public SDK implementation of each operation. A Buyer adapter must not call create and poll
itself; a Seller adapter must not call validate and broadcast itself to implement `verify`. The SDK
and its foundation library own those sequences. Calling the two hooks separately would test the
adapter's sequencing instead of the SDK integration.

For Buyer fulfilment, choose the public method from the supplied challenge's method and intent. Pass
`context` as the public per-call options; do not move those options into the challenge. Configure
the SDK's public poll interval to zero for these deterministic fixtures. Honor the response's
`retryAfterSeconds`. Pass `timeout_ms` when present. The pending budget starts when transaction
creation returns and includes both polling delays and polling HTTP requests. It is separate from the
transport's per-request timeout. A credential received after that budget expires must not be
returned as a successful result.

The `mpp.buyer.timeout` case allows one second, shorter than the pending response's 60-second
polling advice; the SDK must stop waiting and cancel the approval without another poll. The wait
must recheck its target time after an early timer wake rather than poll before the advised delay or
treat an unfinished wait as timeout completion. Test cancellation during that remaining wait. The
`mpp.buyer.timeout-during-poll` case allows 500 milliseconds and delays the poll response for one
second; the SDK must time out and cancel the known approval even though an HTTP request is in
progress. The report checks the outcome and request sequence, not the exact time of interruption.
Language-native timeout tests must also verify that a stalled request is interrupted when its
pending budget expires. Do not implement timeout or polling in the adapter.

For cancellation, invoke the SDK's public cancellation/cleanup control once the initial pending
response reaches the SDK. Prefer the SDK's public progress notification when available. A
transparent public transport wrapper may observe that response and schedule cancellation after
delivery (for example, on the following event-loop turn in Node). It must still perform real HTTP
and pass the original response through unchanged. It must not send the approval-cancel request
itself. The 60-second retry advice in this case keeps polling out of the cancellation window.

### Core codecs and method schemas

Challenge header codecs must escape and unescape quoted values consistently, including the realm,
and reject control characters that could corrupt a header. Test literal wire values as well as round
trips; a serializer and parser can otherwise share the same mistake.

Tempo credential payload validation requires `signature` for `transaction` and `proof`, and `hash`
for `hash`. An unrelated proof field does not satisfy the selected type. These shape checks do not
verify a signature or establish settlement; the platform performs those checks.

InFlow-issued credentials carry a payer `source`. This is not a universal requirement of the MPP
envelope: individual payment methods determine when source is required. SDK changes must preserve
the payer identity used by the platform's transaction and subscription binding checks.

If an SDK exposes subscription-option fingerprinting, unusable decoded requests must not crash
option listing. Test malformed JSON, non-object requests, and missing or non-string amounts
alongside valid options. Fingerprinting is not payment-request validation and must not replace it.

These checks belong in the language-native codec and schema tests; the shared corpus does not
exercise every exported helper or schema.

### Core API transport

The API transport must not automatically follow redirects. Surface the redirect as an HTTP failure,
preserving its status and location for the caller; do not forward API credentials or the request
body to its destination. Verify this with two real local HTTP origins and synthetic credentials.

Caller cancellation stops both an in-flight request and any retry delay. A cancelled call must not
start another HTTP attempt or obtain credentials for a retry. Test cancellation before the request,
during headers/body receipt, and during both status-error and network-error retry waits. Cover the
language's supported cancellation reasons, rather than recognizing cancellation only by an exception
name. Core transport errors retain each SDK's native error representation; the Buyer workflow's
payment-cancellation result is a separate layer.

Transaction creation and existing-subscription authorization default to zero automatic retries. The
first request may have created an approval or authorization even when its response was lost. An
explicit retry override may be supported, but callers must understand that it can create another
record. Read operations retain their transient-error retry policy. This does not change broadcast
idempotency or authorize a retry of an entire payment workflow.

Language-native tests must exercise these defaults through the public Core client, separately from
Buyer orchestration that supplies its own retry settings. Verify explicit overrides without mutating
caller-owned options. These transport checks supplement the shared corpus; its Buyer cases do not
establish the direct Core client's retry behavior.

### Language-native cancellation tests

Cancellation also applies while transaction creation, polling, or existing-subscription
authorization is in progress. SDKs must expose their language-appropriate cancellation outcome
rather than report caller cancellation as an unrelated network failure. When a backing approval
identifier is known, attempt to cancel that approval without replacing the original outcome if
cancellation fails. If creation is interrupted before an identifier is received, the SDK cannot
cancel an unknown approval; server-side expiry remains the backstop. Stopping subscription
authorization must not cancel the existing subscription.

Each SDK must test these three in-flight phases with its native cancellation controls, including
concurrent requests and reuse after cleanup where those controls support them. Synchronize tests
with the request actually being in progress; an arbitrary sleep is not proof of that condition.
Include real local HTTP coverage to verify that the transport honors cancellation, and distinguish
it from tests using a simulated transport. Do not require a shared error class, thread model, or a
method named `cleanup` across languages.

These tests supplement the shared cancellation case, which only exercises cancellation between
requests. A passing shared report alone does not establish in-flight cancellation coverage.

### Signed test challenges

The default corpus uses synthetic challenge identifiers for method-level validation and settlement
hooks. A full Seller API can additionally check challenge signatures and expiration before it calls
those hooks. Use `mppCasesWithSellerChallenges(sign)` from `fixtures/mpp.mjs` to test that API
without bypassing its checks.

The synchronous `sign` callback receives a copy of each balance, instrument, and Tempo charge
challenge. It returns `{ id, expires }`, signed with a test-only Seller secret and a future
expiration, using the SDK or its upstream challenge factory. The factory must sign the supplied
realm, method, intent, and encoded request unchanged, together with the returned expiration.
Configure the tested Seller with the same realm and secret. Do not use production credentials or
signing keys.

Generate the case index before starting the runner. The generator inserts those identifiers and
expirations into the charge validation/settlement inputs, expected echoes, platform scripts, and
receipt encodings. Deliberately inconsistent responses remain inconsistent. Payment amounts,
payloads, failure classifications, and request sequences do not change. Core, Buyer, preparation,
route-binding, and subscription cases retain their original values. The existing `mppCases` export
is unchanged.

The adapter still receives only input and must call the public Seller API. It must not re-sign a
credential after receiving it, inspect expected outcomes, or normalize failed signature verification
into successful payment. Reports fingerprint the generated index, so retain it with the report for
reproduction. A signed challenge establishes test provenance, not a real payment signature or live
settlement.

### Seller observations

Seller implementations that cache platform configuration must allow a later operation to load it
again after a failed request. A failed load must not permanently disable a long-lived Seller
instance. Concurrent operations should share an in-flight configuration load. This does not require
periodic refresh of successful configuration or changes to issued challenge bindings. Cover failure,
later recovery, and concurrent callers in each SDK's native tests.

When a framework integration exposes per-offer selection callbacks, apply them consistently to
charge and subscription offers, with the corresponding request fields available to the callback.
Test allowed and denied offers and callback failure through the actual framework. Offer selection
controls which challenges are advertised; it is not resource authorization or payment validation. An
integration must not represent hiding an offer as revoking an already-issued credential.

Successful Seller validation observations contain `success: true`, `challenge`, `credential`,
`details`, `method`, `intent`, `request`, and `source`. `request` here is decoded. An SDK that
signals successful validation by returning an envelope rather than a boolean normalizes that
successful return to `success: true`. No exception may become a successful observation.

Route-binding cases use the real framework integration, not a method hook alone. Issue a challenge
for `request` using a synthetic local Seller secret, serialize a credential with the supplied
payload and source through the public codec, then submit that unchanged credential to a route
configured with `replacement_request`. Keep the realm and secret the same. The issued challenge has
valid provenance but does not match the destination route's payment terms. The framework must reject
it before platform validation or broadcast. Do not invent a challenge identifier or change the
echoed challenge: that would test a different integrity failure. Challenge timestamps and
identifiers come from the library and are not compared against a hard-coded value.

## Failure observations

These classifications exist only between the test adapter and runner. SDKs retain their native
exception classes and messages. Map recognized typed errors or structured SDK failure results; never
classify by case identifier, expected outcome, or an arbitrary exception's text. Unknown exceptions
must fail the adapter.

| `error.code`             | Fixed test `error.message`        | Meaning                                               |
| ------------------------ | --------------------------------- | ----------------------------------------------------- |
| `invalid-input`          | `Invalid input.`                  | Public codec rejects malformed challenge/input        |
| `invalid-credential`     | `Invalid credential.`             | Credential decoding or required credential data fails |
| `payment-failed`         | `Payment failed.`                 | Recognized payment/verification rejection             |
| `payment-expired`        | `Payment expired.`                | Platform reports expired payment                      |
| `payment-timeout`        | `Payment timed out.`              | SDK's configured waiting budget expires               |
| `payment-cancelled`      | `Payment cancelled.`              | Caller stops the SDK payment workflow                 |
| `unsupported-capability` | `Unsupported payment capability.` | Request cannot select an advertised capability        |

Preserve returned platform problems exactly as `error.details.problem`, including their nested
`extensions` object. This is the InFlow API problem representation, not the flattened problem body
rendered by a protected resource's HTTP middleware. Expiry and timeout observations preserve the
transaction identifier as `error.details.transaction_id`. Cancellation cases compare the
classification and the actual approval-cancellation HTTP request, rather than requiring an approval
identifier in every language's native cancellation exception. Omit `details` when the operation does
not define it.

Malformed Seller-response cases set `include_problem: false`: they check rejection and absence of
unsafe follow-up calls without standardizing the wording of a locally synthesized problem. This is
an explicit projection of a recognized rejection, not permission to turn any exception into a
matching failure. Platform-provided rejection cases retain their complete problem. Transport API
failures continue to use their actual server code, message, and HTTP status, as in the
[shared runtime contract](runtime.md).

## Workflows and negative cases

- **Core:** canonical request bytes, combined/repeated challenges, quoted descriptions, duplicate
  parameters, credentials, receipts, optional fields, and malformed credential data.
- **Buyer:** balance, instrument, Tempo pull, and subscription purchases; immediate and pending
  readiness; failed/expired payments; missing or malformed credentials; missing pending identifier;
  timeout and cancellation. A failed cancellation must not replace the original payment failure.
- **Subscription access:** an existing subscription uses `/authorize` with the current challenge. It
  must not create another transaction. Authorization identifiers, signatures, expiry, subscription
  and transaction correlation fields are preserved; these are not ordinary purchase credentials.
- **Seller:** config-derived request preparation, explicit and ambiguous rail selection, unsupported
  currencies/rails, required instruments, validation without broadcast, validation followed by
  broadcast, inconsistent validation envelopes, terminal problems and malformed receipts, generated
  idempotency keys, key reuse on retry, and route-specific binding.

Missing credentials/identifiers, inconsistent envelopes, incomplete receipts, injected HTTP 500/503,
and alternate required/ambiguous capability configurations are fault or configuration-variation
fixtures. They do not assert that the current platform emits bad data or advertises those settings.
The mock does not perform funds movement, signing, ownership checks, or replay protection. Those
remain responsibilities of the real platform and require their own integration coverage.

## What repository checks prove

`pnpm verify` validates case structure, deterministic output, encoded/decoded relationships, payment
sequence expectations, and actual local HTTP reference exchanges. The reference-exchange tests
deliberately replay fixture requests to test the mock; they are labeled **not SDK conformance**.
Maintained language-native adapters must separately execute these cases through public SDK APIs and
retain runner reports identifying the exact SDK, contract, and dependency revisions.

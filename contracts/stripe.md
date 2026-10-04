# Stripe charge Seller contract

This contract covers accepting Stripe Shared Payment Tokens through InFlow's MPP Seller integration.
A Seller advertises `stripe/charge`, an external Buyer supplies a token, and InFlow validates and
processes that payment. It does not provide Stripe token creation through the InFlow Buyer SDK,
subscriptions, or the separate `card/charge` method for encrypted network tokens.

The protocol authority is the
[Stripe charge draft](https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/methods/stripe/draft-stripe-charge-00.md).
The implementation reference is the
[Node Stripe method at 309aab2](https://github.com/inflowpayai/inflow-node/blob/309aab2650dcb06dd652a5076dc176d5c41196d7/packages/mpp-seller/src/methods.server.ts)
and its
[public framework tests](https://github.com/inflowpayai/inflow-node/blob/309aab2650dcb06dd652a5076dc176d5c41196d7/packages/mpp-seller/test/unit/stripe-method.test.ts).
InFlow's authenticated configuration, validation, broadcast, and Stripe processing implementations
were inspected to establish the InFlow-specific restrictions below. These restrictions are not
universal requirements of the Stripe protocol.

## Configuration and amounts

The application supplies an InFlow Seller API key. Initialization reads `GET /v1/mpp/config` with
that key; it must not substitute the public Buyer capability endpoint. Stripe is available only when
the response advertises `stripe`, `USD`, `charge`, a nonblank `methodDetails.networkId`, and a
nonempty list of nonblank `methodDetails.paymentMethodTypes`. An unavailable capability prevents the
application from advertising an unusable offer.

The offer uses that configured profile and payment-method list. Route options cannot replace them,
change the currency from `usd`, or change the conversion precision from two decimal places. The
current InFlow profile advertises `card` and `link`. Those values are read from configuration, not
inferred from a caller's preferred payment method. The Seller application does not receive Stripe
secret keys or configure Stripe Connect settlement routing.

The supported price is USD 0.50 through 999999.99, inclusive. Node accepts decimal dollar strings
such as `"1.25"`; the issued challenge contains `"amount": "125"` in integer cents. Do not round
extra fractional digits. Shared offer inputs are decimal dollar strings. Adapters must exercise the
SDK's amount conversion and validation, not reproduce them. Each SDK must document the units of its
public amount parameters explicitly.

## References, metadata and challenge binding

`externalId` is optional and has a limit of 255 characters. Under the InFlow profile, when the
challenge supplies it, the credential must repeat it exactly, including an explicitly empty string.
When the challenge omits it, a Buyer may supply its own reference or omit it. A successful receipt
preserves the credential's reference. This matching rule is an InFlow restriction; the upstream
draft describes the challenge reference as the merchant's identifier and the payload reference as
the client's identifier.

Metadata is carried inside `methodDetails.metadata`. It allows at most 45 string entries. Keys must
be nonblank, at most 40 characters, and contain neither `[` nor `]`. Values may be empty and have a
limit of 500 characters. The keys `externalId`, `inflowMppTransactionId`, `mppChallengeId`,
`mppIntent`, `mppMethod`, and `stripeNetworkProfile` are reserved. The limit leaves room for the
payment processor's own metadata. An invalid request must fail before advertising an offer.

The protected-route integration verifies the issued challenge and its expiration before forwarding
the payment token. It binds the amount, currency, profile, payment-method list, metadata and
reference to the offered terms. A credential for different terms must not reach validation or
settlement. Applications must also distinguish resources using the framework's route or scope
binding; two resources having the same price is not proof they are interchangeable.

## Validation and settlement

1. The SDK forwards the complete credential to `POST /v1/mpp/validate`, authenticated as the Seller.
   The token remains in `payload.spt`; the SDK must not exchange it with Stripe itself. Preserve any
   supplied `source`. Stripe does not require an InFlow payer identity; the InFlow wire form
   represents an omitted source as an empty string.
2. Validation checks acceptability without consuming payment state. A failed or inconsistent
   validation response stops the flow. A standalone validation call must not settle the payment.
3. Only after successful validation does the framework invoke `POST /v1/mpp/broadcast`. InFlow
   rechecks the credential and owns replay protection, Stripe processing and payment recovery.
   Earlier successful validation does not guarantee settlement.
4. A successful receipt identifies method `stripe`, the Stripe PaymentIntent reference, confirmation
   timestamp and status `success`. Preserve InFlow's challenge identifier, settlement
   amount/currency and optional external reference. Reject a receipt with a different method, a
   different challenge identifier, or no challenge identifier. A missing or unsuccessful receipt
   cannot authorize delivery.
5. Payment failures and pending settlement remain failures, with their Problem Details retained. The
   HTTP response must not carry a success receipt. Do not treat an HTTP 200 platform envelope
   containing a problem as a successful payment.

When configuration enables idempotency keys, one broadcast attempt and its transport retries share
one generated key. This does not authorize restarting an entire payment flow or inventing a local
settlement queue. If configuration disables the feature, omit that header. Stripe keys and the
platform's persisted replay/recovery state are outside the SDK.

## Running the shared cases

The separate [Stripe corpus](../fixtures/stripe.mjs) uses the existing
[MPP Seller operations](mpp.md#operations). Generate it with:

```sh
node fixtures/stripe.mjs > /tmp/inflow-stripe-cases.json
```

Select `mpp-seller` with no optional feature declarations. Every case in this corpus is required for
an SDK claiming Stripe Seller support. Selecting the ordinary MPP corpus does not certify Stripe
support. `mpp.seller.prepare` and `mpp.seller.route-binding` inputs use decimal USD strings and
top-level offer metadata; their prepared result uses integer cents and nested method details.
Validation and verification inputs already contain encoded wire challenges. Adapters invoke the
public SDK and foundation framework, not their own validation or settlement implementation.

Cases exercise real SDK calls against a scripted local HTTP platform with synthetic tokens. They
verify configuration, exact conversion, rejected inputs, reference and route binding, sequencing,
receipt preservation and transport retry keys. They do not prove live Stripe acceptance, token
single-use enforcement, database concurrency, or actual fund settlement. The protocol's challenge
signature, expiry and no-receipt-on-error requirements also need language-native protected-route
tests; standalone method-hook tests do not establish them.

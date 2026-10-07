# CARD charge contract

CARD carries an encrypted network-token credential. It is distinct from Stripe Shared Payment Tokens
and from selecting a linked InFlow instrument for an x402 purchase. InFlow's CARD profile supports
one-time Visa payments in USD.

The protocol reference is the
[CARD charge draft](https://paymentauth.org/draft-card-charge-00.html), sections 6.1–6.3. The InFlow
implementation references are the
[Node Seller factory](https://github.com/inflowpayai/inflow-node/blob/1e55446bc612796c5e24c76cd9ef6a375de045ee/packages/mpp-seller/src/methods.server.ts#L380)
and
[CARD schemas](https://github.com/inflowpayai/inflow-node/blob/1e55446bc612796c5e24c76cd9ef6a375de045ee/packages/mpp/src/card.ts).
The USD limits, Visa restriction, required recipient, and authenticated configuration behavior below
are InFlow's profile, not restrictions on every implementation of the protocol.

## Configuration authority

Initialize with the Seller API key against `GET /v1/mpp/config`. The public Buyer capabilities
endpoint is not a substitute. Configuration must advertise `card`, `USD`, and `charge`, with the
recipient, merchant name, accepted networks, and public encryption key. Reject an unavailable or
incomplete configuration before advertising an offer.

The key has RSA public parameters `n` and `e`, a nonempty `kid`, algorithm `RSA-OAEP-256`, and use
`enc`. Offer construction uses the configured public key; it does not obtain or decrypt payment
tokens. The separate credential processing flow performs cryptographic verification.

Route options cannot replace the configured recipient, merchant name, networks, or encryption key.
They cannot change the currency from `usd`. A route can supply an external reference of at most 255
characters, and a boolean `billingRequired`. An omitted billing requirement remains omitted;
explicit `false` remains false. Preserve an explicitly empty external reference.

## Amounts

The public offer input is a decimal USD string; the challenge amount is an integer string in cents.
For example, `"1.25"` produces `"125"`. Accept USD 0.50 through 999999.99 inclusive, without
rounding. The shared input format uses an unsigned decimal string with at most two fractional digits
and no redundant leading zeroes, surrounding whitespace, or exponent notation. A JSON number is not
this operation's amount input. Other language-native amount interfaces must document their units and
preserve the same exact values and limits.

## Credentials, validation and settlement

The Seller forwards the credential to InFlow without inspecting or decrypting its encrypted payload.
Preserve the payload's optional billing fields and extensions, the challenge fields, and any
supplied `source`. An omitted source is sent as an empty string in the InFlow API request; an
external CARD payer does not need an InFlow payer identity.

The protected route checks the issued challenge's signature, expiry, and bound terms before calling
InFlow. A credential issued for another amount, external reference, or billing requirement must not
reach payment validation or broadcast. The configured merchant, networks, and encryption key also
form part of the bound request. Route or scope binding must distinguish different resources even
when they have equal prices.

1. Call authenticated `POST /v1/mpp/validate` with the complete credential. Standalone validation
   does not broadcast or authorize delivery.
2. Require successful validation of the same challenge, credential, source, method, and intent. A
   failed or inconsistent result stops the flow before broadcast.
3. Call `POST /v1/mpp/broadcast` only after successful validation. InFlow performs the authoritative
   credential verification and processing; successful validation alone is not a payment receipt.
4. Accept only a successful CARD receipt with the matching challenge identifier. Preserve its
   reference, timestamp, settlement fields, and optional external reference. Missing, unsuccessful,
   wrong-method, or wrong-challenge receipts do not authorize delivery.
5. Preserve payment problems, including pending settlement, rather than treating the HTTP response
   status alone as success. Error responses must not carry a successful Payment-Receipt header.

If Seller configuration enables idempotency keys, transport retries of one broadcast use the same
generated key. When disabled, omit that header. This transport header is separate from InFlow's
persisted CARD redemption identity, which includes the Seller and challenge identifier. SDKs do not
replace that server-managed state with a local queue or create a fresh payment to recover an
uncertain result.

These requirements follow the [CARD draft](https://paymentauth.org/draft-card-charge-00.html)
sections 7–9 and InFlow's validation/broadcast API. The Node
[CARD lifecycle hooks](https://github.com/inflowpayai/inflow-node/blob/1e55446bc612796c5e24c76cd9ef6a375de045ee/packages/mpp-seller/src/methods.server.ts#L435)
and
[protected-route tests](https://github.com/inflowpayai/inflow-node/blob/1e55446bc612796c5e24c76cd9ef6a375de045ee/packages/mpp-seller/test/unit/card-method.test.ts)
provide implementation examples.

## Buyer selection and fulfilment

The Buyer supplies merchant context (`name`, absolute HTTP or HTTPS `url`, and two-letter
`countryCode`) and may select a linked card using its UUID `instrumentId`. When omitted, InFlow uses
the account's primary instrument. The server checks ownership, enabled Visa status, and an unexpired
USD allowance covering the purchase. The SDK does not choose an arbitrary card or infer an
allowance. Merchant context does not override the signed challenge or the server's configured
merchant records.

Reject structurally invalid options before making a platform request. Server validation remains
authoritative for registered countries, card eligibility, allowances, merchant ownership, and
cryptographic key validity. Node's public reference is the
[CARD Buyer method](https://github.com/inflowpayai/inflow-node/blob/1e55446bc612796c5e24c76cd9ef6a375de045ee/packages/mpp-buyer/src/methods.client.ts#L11).

Submit the unchanged wire challenge and selected options to `POST /v1/transactions/mpp` using Buyer
authentication. Do not automatically retry creation after an uncertain response. A pending result is
polled at `GET /v1/transactions/{transactionId}/mpp`; it is not permission to create another
purchase. Preserve a failed result's problem and transaction identifier, and distinguish expiry from
failure. If fulfilment fails after receiving an approval identifier, attempt approval cancellation
without replacing the original failure with a cancellation error.

A ready result means that an encrypted purchase credential is available, not that the Seller has
accepted or settled the payment. Before returning it, require the entire returned challenge to match
the requested challenge, including its request, expiry, description, digest and opaque data. Reject
a missing or malformed credential or payload. Preserve valid opaque encrypted data, source, billing
fields and payload extensions. The Buyer neither decrypts the credential nor replaces a mismatched
challenge with the expected one. The credential is submitted to the Seller for processing.

The
[Node HTTP-fetch tests](https://github.com/inflowpayai/inflow-node/blob/1e55446bc612796c5e24c76cd9ef6a375de045ee/packages/mpp-buyer/test/integration/card-fetch.test.ts)
exercise the real upstream client framework, including API-key isolation from the Seller and bearer
authentication. Shared fulfilment cases alone do not certify that full HTTP transport.

## Shared cases and limits of verification

Generate the [CARD corpus](../fixtures/card.mjs) with:

```sh
node fixtures/card.mjs > /tmp/inflow-card-cases.json
```

Select `mpp-seller`, `mpp-buyer`, or both according to the packages under test, with no optional
feature declarations. Offer cases use `mpp.seller.prepare`: the adapter initializes the public CARD
Seller factory and asks its real payment framework to construct a challenge. It returns that
challenge's decoded request, excluding nondeterministic challenge identifiers and expiry. The
adapter must not perform the conversion or configuration validation itself. Normalize invalid route
inputs to `invalid-input` and unavailable configuration to `unsupported-capability`, using the
[MPP error messages](mpp.md).

Lifecycle cases use the existing `mpp.seller.validate`, `mpp.seller.verify`, and
`mpp.seller.route-binding` operations. Validation and verification inputs contain wire-encoded
challenges; adapters decode them only as required by the public API. Route-binding cases issue a
challenge through the actual framework, submit its credential to a route with changed terms, and
require rejection without platform calls. Adapters must not implement binding or settlement checks.

Buyer cases use `mpp.buyer.fulfil` through the public CARD method. Return the decoded Payment
credential, or the shared error classification. Invalid options use `invalid-input`; a missing or
mismatched credential uses `invalid-credential`. Failed and expired results retain a supplied
transaction identifier as `error.details.transaction_id`; failed results also retain their problem
as `error.details.problem`. Empty platform scripts assert no requests, not skipped verification.

The corpus uses a test-only public key, synthetic opaque credentials, and a scripted local platform.
It verifies offer construction, credential forwarding, selected route changes, validation/broadcast
sequencing, receipt checks, and retry keys. It does not prove encryption, decryption, token
validity, persisted replay protection, actual Buyer token issuance, or live settlement.
Language-native protected-route tests must also cover signature tampering, expiry, challenge
description preservation, successful content delivery with a receipt, and absence of a receipt on
errors. Standalone lifecycle hooks do not prove those framework behaviors. Tooling tests validate
fixtures and the runner, not an SDK.

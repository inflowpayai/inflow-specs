# CARD charge Seller offers

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

## Shared cases and limits of verification

Generate the [CARD offer corpus](../fixtures/card.mjs) with:

```sh
node fixtures/card.mjs > /tmp/inflow-card-cases.json
```

Select `mpp-seller` with no optional feature declarations. These cases use `mpp.seller.prepare`: the
adapter initializes the public CARD Seller factory and asks its real payment framework to construct
a challenge. It returns that challenge's decoded request, excluding nondeterministic challenge
identifiers and expiry. The adapter must not perform the conversion or configuration validation
itself. Normalize invalid route inputs to `invalid-input` and unavailable configuration to
`unsupported-capability`, using the [MPP error messages](mpp.md).

This corpus verifies offer construction only, using a test-only RSA public key. It does not exercise
encryption or decryption. It compares request fields, not the framework's challenge-level
description or expiry. Passing it does not certify Buyer token issuance, credential forwarding,
route binding, validation/broadcast sequencing, receipt handling, or live card settlement. Those
require separate integration checks; neither this corpus nor its tooling tests prove them.

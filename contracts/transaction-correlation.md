# InFlow transaction correlation

Successful InFlow settlement results identify the InFlow Transaction recorded for the seller. This
identifier is separate from the buyer identity, an Agent identity, an order identifier, and the
payment network's reference. Sellers can save it alongside their order and retrieve the transaction
through `GET /v1/transactions/{transactionId}` using their own InFlow credentials.

## Response fields

| Protocol | Field                                                 | Existing reference                                               |
| -------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| MPP      | `receipt.inflowTransactionId`                         | `receipt.reference` retains its method-specific meaning.         |
| x402     | `extensions["inflow-transaction"].info.transactionId` | `transaction` retains its existing settlement-reference meaning. |

Both identifiers are UUID strings. The MPP field is included in the receipt encoded in
`receiptHeader` and `Payment-Receipt`. The x402 extension is retained in `PAYMENT-RESPONSE`. The
x402 extension includes an `info` object and a `schema` describing that object:

```json
{
  "info": {
    "transactionId": "22222222-2222-4222-8222-222222222222"
  },
  "schema": {
    "type": "object",
    "properties": {
      "transactionId": { "type": "string", "format": "uuid" }
    },
    "required": ["transactionId"]
  }
}
```

These are InFlow additions, not standard transaction-identity fields of either protocol. They use
the
[MPP receipt extensibility rules](https://paymentauth.org/draft-httpauth-payment-01.html#section-5.3)
and the
[x402 extension structure](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md).
They do not change payment credentials, signatures, authorization, settlement timing, or user IDs.

## Correlation rules

- The identifier refers to the seller-accessible Transaction. If an on-chain payment has separate
  buyer and seller records, the settlement result identifies the seller record.
- A replayed settlement returns the same identifier. A subscription renewal identifies its own
  charge, not the original subscription payment.
- Existing blockchain hashes, processor payment references, challenge IDs, subscription IDs, and
  seller-provided `externalId` values remain unchanged.
- Verification alone does not establish a completed payment. These additions belong to successful
  settlement results, not verification responses.
- Responses from older deployments or previously stored receipts can omit the identifier. Anonymous
  facilitation without an InFlow seller Transaction also omits it. SDKs must accept absence without
  inferring an identifier from another field or initiating a replacement payment.
- SDKs preserve the additions through their upstream-library adapters and receipt/header codecs.
  Integrators must not need to parse private implementation fields to access the identifier.

## Verification

Shared cases exercise populated and absent identifiers and preserve existing references and other
extensions. Each SDK also tests the real upstream adapter and middleware path, including receipt
encoding and decoding. Mock platform responses verify SDK handling only; transaction ownership,
durable settlement, replay, and bookkeeping failures require platform integration tests.

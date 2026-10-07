# Buyer payment status and recovery

Use payment status to inspect an existing payment after submission, an uncertain settlement result,
or a request for card authentication. Both MPP and x402 expose the authenticated
`GET /v1/transactions/{transactionId}` endpoint through their public SDK clients.

This read is separate from MPP credential readiness and x402 payload readiness. Having a credential
or signed payload does not establish settlement. A status read must not create another payment,
cancel its approval, confirm a payment, or open a returned URL.

## Results and next steps

Preserve the transaction identifier and the server's status. `INITIATED`, `PENDING`, and
`PROCESSING` are not settlement success. A `GENERAL_ERROR` response is still a successful status
read describing a failed transaction, not an HTTP failure. Do not replace an unfamiliar status with
`SETTLED` or infer settlement from the absence of a next action.

`nextAction` can contain `type: "authenticate_card"` and an authenticated dashboard `url`. Return
that information to the caller so the application can direct the buyer to authenticate. It is not a
payment credential or a processor client secret. The SDK must not send its API key or Bearer token
to the action URL. A later explicit read of the same transaction can return `SETTLED` without an
action; each read must fetch the current snapshot rather than reuse the previous result.

When the result remains uncertain, keep the original transaction identifier. A failed status read
does not establish payment failure, success, or permission to create a replacement purchase.
Likewise, a 404 does not establish that a prior payment was never processed. Recovery reads do not
replace method-specific credential polling or settlement retries using the same credential.

## Shared adapter operations

The [corpus](../fixtures/payment-status.mjs) uses `mpp.buyer.payment-status` and
`x402.buyer.payment-status`. Construct the appropriate public SDK client with the supplied API key
or access-token provider and local `base_url`. Call its payment-status method for `transaction_id`.
Do not implement the HTTP request inside the adapter. x402 client construction also reads Buyer
capabilities; an empty capability list must not prevent reading an existing payment.

`reads` defaults to one. When greater than one, make that many explicit sequential calls on the same
client; this is a caller-driven recheck, not a requirement for an automatic background poller.
Return an array projecting each result's `transactionId`, `status`, and, when present, `nextAction`.
Other transaction fields are outside this operation's comparison. Preserve caller inputs and
options.

Omit retry options unless `retries` is supplied. The default is one HTTP attempt per status read; an
explicit retry setting may retry the read but never create or cancel a payment. Normalize HTTP
errors to `api-error`, message `InFlow API request failed.`, the original `http_status`, and
`details.body`. Redirects are returned as errors, not followed. Identifiers must remain one encoded
path segment; the non-UUID identifier case is transport fault injection, not a valid platform ID.

These synthetic exchanges test SDK behavior, not platform ownership enforcement, processor
authentication, live settlement, or recovery after a real financial incident. Native SDK tests must
also verify aborting a status request without cancelling the payment and check redirects against a
second local origin that receives no credentials. Permanent adapters belong in each SDK repository.

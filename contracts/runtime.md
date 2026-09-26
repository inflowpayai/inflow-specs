# Shared runtime test fixtures

The [runtime scenarios](../fixtures/runtime.mjs) provide synthetic InFlow HTTP exchanges for SDK
tests. They are not an authentication server, a payment engine, or a claim that live services return
these particular identifiers. Tokens and keys prefixed `test-only-` are inert strings understood
only by these scripted tests. No OAuth token issuance, signature verification, database, or live
account is involved.

## Authentication and account roles

API-key clients send `X-API-KEY`. OAuth clients send `Authorization: Bearer <token>`. The fixtures
exercise these modes independently. Missing or invalid authentication on an authenticated endpoint
produces HTTP 401 with an empty body and this header:

```http
WWW-Authenticate: Bearer resource_metadata="/.well-known/oauth-protected-resource"
```

The expired-Bearer fixture represents the rejection after token validation fails; it does not
validate a token's lifetime itself.

Ordinary authenticated endpoints are not restricted to Developer accounts. The approval-read
fixtures cover Buyer, Developer, Seller, and Agent accounts with both credential forms. Seller-only
operations are a different boundary. The configuration rejection fixtures return HTTP 403 from
`GET /v1/mpp/config` for non-Seller accounts, preserving the supplied account-specific message:

```json
{
  "errors": [
    {
      "code": "SELLER_ACCOUNT_REQUIRED",
      "message": "The supplied credentials belong to a Developer account. This endpoint requires a Seller account."
    }
  ],
  "id": "44444444-4444-4444-8444-444444444444"
}
```

SDK tests must check the status, code, and message delivered to the caller. A generic fallback that
discards a structured server error is not equivalent. Empty error bodies are separate cases; the
mock does not manufacture an error envelope for every failure.

## Approval polling and cancellation

The fixtures use `GET /v1/approvals/{approvalId}` for the shared approval lifecycle:

- Pending reads followed by `APPROVED` or `DECLINED`.
- A pending read followed by HTTP 404 with `APPROVAL_NOT_FOUND`.
- `POST /v1/approvals/{approvalId}/cancel` returning HTTP 204 with no body.
- A follow-up read or repeated cancellation returning HTTP 404 after successful cancellation.
- Cancellation attempted with another owner's credentials returning HTTP 404.
- A cancellation failure with an empty HTTP 500 response.

The response uses `requestId` for the approval identifier and uppercase `status` values. Successful
cancellation does not promise a subsequently readable `CANCELLED` resource. The scripted 404
represents an unavailable approval, not a consistency guarantee about the timing of every live read.
An unavailable approval is not proof of successful payment or a refund.

These are approval responses, not MPP transaction responses. MPP uses a separate lowercase `state`
field; its credential readiness and the x402 signing/settlement flows require their own protocol
cases. The shared runtime fixtures do not infer settlement from approval.

## Environments

The SDK environment defaults are production `https://api.inflowpay.ai` and sandbox
`https://sandbox.inflowpay.ai`. An explicit API base URL overrides the environment default. See the
public
[MPP environment resolver](https://github.com/inflowpayai/inflow-node/blob/bfa2c3f88b6f0c104f39887dce15779b88d42885/packages/mpp/src/environment.ts)
and
[x402 environment resolver](https://github.com/inflowpayai/inflow-node/blob/bfa2c3f88b6f0c104f39887dce15779b88d42885/packages/x402/src/environment.ts).

Tests must not contact those public hosts. The mock binds an ephemeral port on `127.0.0.1`; two
instances provide isolated local environments with distinct expected credentials. The SDK adapter
must use the supplied base URL through the SDK's public configuration. Default environment selection
must be tested separately without making outbound requests. Local mock isolation alone does not
prove the SDK chose the correct production or sandbox default.

## Fault injection versus server behavior

Delay, disconnect, malformed JSON, and caller-defined response scripts are test controls. They do
not assert that the production server normally behaves that way. Retry and cancellation tests must
assert their actual request sequence and error outcome, rather than accepting any eventual success.
Do not introduce a generic retry rule here: payment creation and safe read operations have different
side-effect risks.

Fixtures test what an SDK does with verified wire shapes. They do not replace server integration
tests or authorized end-to-end payment tests. Source authority and evidence requirements are in
[CONTRIBUTING.md](../CONTRIBUTING.md).

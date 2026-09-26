# InFlow SDK contracts

This repository defines shared expectations for InFlow payment SDKs: the API exchanges and payment
workflows that implementations in different languages must handle consistently.

It is for SDK contributors and maintainers. To integrate payments into an application, start with
the [InFlow Node SDK](https://github.com/inflowpayai/inflow-node). The
[Go](https://github.com/inflowpayai/inflow-go),
[Python](https://github.com/inflowpayai/inflow-python), and
[Rust](https://github.com/inflowpayai/inflow-rust) SDK repositories are also available; consult each
repository for its implementation and release status.

## Scope

The contract work covers InFlow-specific Buyer and Seller behavior for [MPP](https://mpp.dev/) and
[x402](https://www.x402.org/):

- Authentication, account permissions, production and sandbox environments, and error handling.
- Payment creation, approvals, polling, cancellation, verification, and settlement.
- InFlow balance and instrument payments, Tempo charges, and recurring subscriptions.
- x402 managed signing, external-wallet integration, metered payments, and gas sponsorship.
- Optional MCP payment integration and separate Visa TAP Seller verification.

These are the repository's scope, not a claim that every SDK implements every feature. Network,
account, and signing restrictions remain part of each feature's contract. InFlow-specific behavior
does not replace the underlying payment protocol specifications.

## Verification status

This repository contains a [conformance runner and adapter contract](runner/README.md), schemas, and
process-level tests for the tooling. It does not yet provide payment conformance cases, mock payment
services, or SDK adapters. Passing its current checks does not certify an SDK's payment behavior.

Conformance tools and fixtures are development dependencies. They are not loaded by production SDKs.
Tests must use synthetic credentials and local services; live payments require separate explicit
authorization.

## Contract revisions

A contract revision is an exact Git commit, not a semantic-version release. An SDK's tests must pin
the commit they use rather than following `main`. Updating that pin is a reviewed SDK change.

Verification results identify the contract commit, SDK commit, SDK package versions, and actual
upstream dependency versions tested. SDK releases and MPP/x402 protocol versions remain independent
of the contract revision. A passing run against one dependency version does not prove compatibility
with every version allowed by its dependency range.

## Local checks

Use Node.js 24 and the pnpm version declared in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm verify
```

Verification checks formatting and runs the tooling tests with coverage thresholds. To apply
formatting, run `pnpm format`. The same verification command runs on pull requests and pushes to
`main`. Tooling is private and is not published as an npm package.

## Contributing and policies

See [CONTRIBUTING.md](CONTRIBUTING.md) for evidence and review requirements. Report vulnerabilities
privately through the organization's
[security policy](https://github.com/inflowpayai/.github/blob/main/SECURITY.md). Participation
follows the shared
[Code of Conduct](https://github.com/inflowpayai/.github/blob/main/CODE_OF_CONDUCT.md).

Repository content is available under the [MIT license](LICENSE).

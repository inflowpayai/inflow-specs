# InFlow SDK contracts

This repository defines shared expectations for InFlow payment SDKs: the API exchanges and payment
workflows that implementations in different languages must handle consistently.

It is for SDK contributors and maintainers. To integrate payments into an application, choose the
[Go](https://github.com/inflowpayai/inflow-go#readme),
[Node.js](https://github.com/inflowpayai/inflow-node#readme),
[Python](https://github.com/inflowpayai/inflow-python#readme), or
[Rust](https://github.com/inflowpayai/inflow-rust#readme) SDK guide. Each contains installation
instructions and runnable Buyer and Seller examples. The
[compatibility and support matrix](#sdk-compatibility-and-support) links to runtime requirements and
language-specific limitations.

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
process-level tests for the tooling. A [local mock platform](runner/README.md#local-http-platform)
and [shared runtime fixtures](contracts/runtime.md) cover synthetic authentication errors and
approval exchanges. The [MPP corpus](contracts/mpp.md) supplies Core, Buyer, and Seller cases. The
[x402 corpus](contracts/x402.md) covers payment identifiers, managed signing, facilitator responses,
and seller offers. The [Stripe charge corpus](contracts/stripe.md) covers Seller acceptance of
Shared Payment Tokens separately from the ordinary MPP cases. SDK adapters live in the SDK
repositories. Passing the repository's tooling checks does not certify an SDK's payment behavior.

The [payment-status corpus](contracts/payment-status.md) checks read-only Buyer recovery for MPP and
x402, including card-authentication actions and rechecking the original payment.

Conformance tools and fixtures are development dependencies. They are not loaded by production SDKs.
The manual [MPP and x402 interoperability matrices](interop/README.md) exercise all four languages'
Buyers against all four Sellers and retain per-case service logs and dependency versions. The
separate [TAP Seller verification contract](contracts/tap.md) defines the stronger InFlow
request-signature profile and its executable shared corpus. The cases exercise SDK verification,
replay protection and trusted-key retrieval through public APIs; tooling tests alone do not certify
an SDK implementation.

Tests must use synthetic credentials and local services; live payments require separate explicit
authorization.

## Contract revisions

A contract revision is an exact Git commit, not a semantic-version release. An SDK's tests must pin
the commit they use rather than following `main`. Updating that pin is a reviewed SDK change.

Verification results identify the contract commit, SDK commit, SDK package versions, and actual
upstream dependency versions tested. SDK releases and MPP/x402 protocol versions remain independent
of the contract revision. A passing run against one dependency version does not prove compatibility
with every version allowed by its dependency range.

## SDK compatibility and support

Each SDK has its own release versions. Matching version numbers across languages are not required.
We support the latest stable release of each SDK; fixes for older releases are considered
individually, without a commitment to maintained release branches. For Node, this applies to each
published package.

Before version 1.0, incompatible public API changes require a minor increment; compatible fixes use
a patch increment. From version 1.0, releases follow semantic versioning. Published versions and
release tags must not be replaced.

The table describes dependency declarations, not certification of every permitted dependency
version. Follow the linked manifests for exact requirements and the SDK release's verification
reports for the versions actually tested.

| SDK                                                    | Runtime and CI coverage                      | Upstream payment dependencies                                                                                                                                                                                        | Integration limitations                                                                                                                                                   |
| ------------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Node](https://github.com/inflowpayai/inflow-node)     | Node 22 or newer; CI tests 22 and 24         | [MPP](https://github.com/inflowpayai/inflow-node/blob/main/packages/mpp/package.json): `mppx ^0.8.17`; [x402](https://github.com/inflowpayai/inflow-node/blob/main/packages/x402/package.json): `@x402/core ^2.27.0` | [MPP](https://github.com/inflowpayai/inflow-node/tree/main/docs/mpp) and [x402](https://github.com/inflowpayai/inflow-node/tree/main/docs/x402) integration documentation |
| [Go](https://github.com/inflowpayai/inflow-go)         | Go 1.26 or newer; CI tests 1.26 and 1.27     | [go.mod](https://github.com/inflowpayai/inflow-go/blob/main/go.mod): `mpp-go v0.2.0`, `x402/go/v2 v2.27.0`                                                                                                           | [Upstream compatibility notes](https://github.com/inflowpayai/inflow-go#upstream-compatibility-notes)                                                                     |
| [Python](https://github.com/inflowpayai/inflow-python) | Python 3.11 or newer; CI tests 3.11–3.14     | [pyproject.toml](https://github.com/inflowpayai/inflow-python/blob/main/pyproject.toml): `pympp >=0.11.0,<0.12`, `x402 >=2.25.0,<3`; optional extras                                                                 | [Upstream MPP compatibility](https://github.com/inflowpayai/inflow-python#upstream-mpp-compatibility)                                                                     |
| [Rust](https://github.com/inflowpayai/inflow-rust)     | Rust 1.93 or newer; CI tests 1.93 and stable | [Cargo.toml](https://github.com/inflowpayai/inflow-rust/blob/main/Cargo.toml): `mpp ~0.14.0`, `x402-* ~2.0.2`; optional features                                                                                     | [MPP compatibility notes](https://github.com/inflowpayai/inflow-rust/blob/main/crates/inflow-mpp/README.md#differences-from-upstream-mpp-014)                             |

Go requirements select minimum module versions; an application's dependency graph can select newer
versions. Node peer dependencies and Python and Rust manifests define allowed ranges. Lockfiles
record a tested dependency set, not a restriction on every consuming application's dependency
resolution.

Dependency updates require review and verification against the SDK's pinned contract and native
tests. Node also tests the latest x402 2.x dependencies. The
[interoperability and published-package reports](interop/README.md) identify the exact combinations
exercised; they do not certify real fund transfers.

Report ordinary integration problems in the relevant SDK's issue tracker. Report security concerns
privately through the
[organization security policy](https://github.com/inflowpayai/.github/blob/main/SECURITY.md).

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

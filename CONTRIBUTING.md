# Contributing

## Evidence before expectations

InFlow API behavior must be verified against the server's request, response, and lifecycle
implementation. MPP and x402 requirements come from their respective protocol specifications.
Existing SDK code and tests are useful implementation evidence, not authority to override either.
Report conflicts for review rather than changing expected results to match one implementation.

Public documentation must stand on its own. Do not copy private server source, internal planning
documents, production payloads, credentials, or customer data into this repository. A local API
snapshot can help development but is not an exhaustive description of runtime validation or errors.

## Contract changes

- Explain the behavior, who relies on it, and the source that establishes it.
- Distinguish required behavior from optional features and unsupported combinations.
- Give cases stable identifiers. Explain changes to an existing expected result.
- Exercise public SDK entry points. An adapter must not implement the behavior it is testing.
- Include relevant failure paths, especially retries, cancellation, credential forwarding, replay,
  and settlement. HTTP success alone does not prove successful payment.
- Distinguish mocked SDK integration from tests against the real platform.
- Identify incompatible changes explicitly and describe how affected SDK test pins are updated.

Use exact Git commits to identify contract revisions. Do not create semantic-version releases for
this repository or silently update an SDK to a moving branch.

## Pull requests

Use a focused branch and a Conventional Commit title, such as `docs: clarify settlement results` or
`test: cover cancelled payment approval`. Keep the pull request squashed to one commit.

Run `pnpm install --frozen-lockfile` and `pnpm verify`. Report what actually ran and what it proves;
the formatting check is not a payment conformance test. Include additional checks when introducing
executable tooling. Do not commit generated reports or dependency directories.

Follow the shared
[Code of Conduct](https://github.com/inflowpayai/.github/blob/main/CODE_OF_CONDUCT.md) and
[security reporting policy](https://github.com/inflowpayai/.github/blob/main/SECURITY.md).

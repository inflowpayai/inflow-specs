# Buyer and Seller interoperability

The manual **MPP interoperability** and **x402 interoperability** workflows each run all 16
combinations of Node, Go, Python, and Rust Buyers and Sellers. Each pair exchanges real HTTP
challenges and credentials through the SDKs and their existing upstream integrations. A local
synthetic platform supplies approval and settlement responses. No account credentials, blockchain
transactions, or live payments are used.

The SDK revisions are pinned in `sdk-lock.json`. The runner uses the SDK repositories' existing peer
programs, including the Node peer maintained in the Rust repository. It does not implement a
replacement payment client or Seller. Update pins deliberately and review changes to these peers
when updating SDK revisions.

## MPP cases

Every pair exercises InFlow balance charges and Tempo charges with:

- An immediately available credential.
- A pending approval followed by a ready credential.
- Rejected payment verification.
- Rejected settlement.
- An application handler returning an error after successful payment.

All Buyers also exercise new and existing subscriptions against Node and Go Sellers. Python and Rust
Seller subscription combinations are explicitly unsupported because their upstream integrations do
not implement that intent. They are not counted as passing subscription tests. Each pair also
receives a deliberately corrupted receipt; the report checker must reject it.

Assertions cover payment terms, credential preservation, API-key separation, request counts,
approval polling, receipt identity, application responses, and settlement before application
execution. Rejected verification must not broadcast or run the application handler. Rejected
settlement must not run the handler. Peer stdout, stderr, and platform request sequences are
retained for each case. The normal case suite contains 232 executions, 16 explicit unsupported
entries, and 16 receipt negative controls.

These tests do not prove live signing, fund movement, platform replay protection, or every SDK
feature. They supplement—not replace—the shared conformance corpus and language-native tests.
Instrument-rail charges, Stripe, TAP, x402 interoperability, and credentialed sandbox certification
are outside this matrix.

## x402 cases

Every pair exercises InFlow balance payments and EVM exact payments using the Base configuration
from the shared x402 fixtures. Each scheme runs five scenarios: ready payment, pending approval,
rejected verification, rejected settlement, and application handler failure. This produces 160
normal executions and 16 corrupted-receipt controls, with no unsupported cells.

Assertions check the scheme, network, asset, amount, recipient, resource URL, complete payment
payload and identifier, separate Buyer and Seller API keys, polling, and receipt identity. The
protected request must preserve its application session header without leaking a platform API key.
Successful paid responses must have private caching.

x402 executes the handler after verification but before settlement. A verification rejection must
not run the handler or settle. A handler error must not settle. A settlement rejection must return
402 without the paid response body or a successful receipt, even though the handler has already run.
Each payment must be created once, verified once, and settled at most once in these scenarios.

The platform returns synthetic signed payloads. This matrix does not verify cryptographic signing,
on-chain transactions, replay protection, external-wallet Buyers, every blockchain, Permit2, metered
payments, sponsorship, TAP, or live sandbox payments. It tests the SDK and middleware exchange, not
the platform's ability to accept a real payment.

## Run and read the report

Run **Actions → MPP interoperability → Run workflow** or **Actions → x402 interoperability → Run
workflow** in this repository. Both run only on manual dispatch, not on every pull request or merge.
Download the corresponding `mpp-interoperability` or `x402-interoperability` artifact:

- `report.json`: all 16 cells, individual cases, SDK revisions, runtime versions, and overall
  result.
- `<buyer>-<seller>.json`: the corresponding cell's results and service logs.
- `*-dependencies.json` and `*-dependencies.txt`: actual installed dependency versions.

A cell passes only when all its supported cases and its negative control pass. Unsupported entries
remain visible. An interrupted or failed run does not receive an overall passing result.

For a local run, place clean checkouts at the pinned revisions under a common parent directory,
named `inflow-node`, `inflow-go`, `inflow-python`, and `inflow-rust`. Build Node with
`pnpm install --frozen-lockfile && pnpm build`; install Python dependencies with
`uv sync --all-extras --all-groups --locked`. Install the Go and Rust versions used by the workflow.
Then, from this repository:

```sh
node interop/mpp.mjs /path/to/sdk-parent /path/to/new-report-directory
node interop/x402.mjs /path/to/sdk-parent /path/to/another-new-report-directory
```

The report directory must not already exist. The runner compiles the Go and Rust peers, limits peer
execution time, and shuts down its child processes after each case. Unit tests of the report checker
are tooling tests; only running this matrix exercises the four SDKs together.

## Published-package payment checks

The manual **Released-package payment checks** workflow installs the exact versions in
`releases.json` from npm, the Go module proxy, PyPI, and crates.io into separate consumer projects.
For each language it runs a successful and a verification-rejected payment through MPP and x402
balance routes: 16 cases, not another cross-language matrix.

Release workflows already check package contents, imports, and selected public APIs. This check adds
the complete local challenge, payment, verification, settlement, receipt, and protected-response
exchange using the installed packages. It requires no sandbox deployment, account, wallet, funds, or
real credentials. The platform responses are synthetic; deployed-platform behavior and actual
signing and settlement are not certified.

The peer programs are copied from the revisions in `sdk-lock.json`; SDK implementations are not
copied or linked from those checkouts. Node's peer uses directory links within its npm installation
to retain its expected directory layout. Go has no module replacement, Python runs in an isolated
virtual environment, and every InFlow Rust dependency must resolve from crates.io at the pinned
version. The Rust peer's existing test transport redirects SDK requests to the local platform.

Run **Actions → Released-package payment checks → Run workflow** and download the
`released-package-payments` artifact. It contains `report.json` with all case results and peer logs,
runtime and package versions, and dependency inventories. A failed installation, build, or payment
case prevents a passing result. Updating release pins is independent of publishing an SDK.

For a local run, use the same clean pinned SDK checkouts described above; no Node build or Python
checkout environment is needed. Install Node, npm, Go, uv, and Rust 1.93.0, then run:

```sh
node interop/releases.mjs /path/to/sdk-parent /path/to/new-consumer-directory
```

The directory must not exist. Consumers and their dependency lockfiles remain there for inspection.
`CARGO_TARGET_DIR` may select a reusable compilation cache; Cargo still resolves and verifies the
registry dependencies. The workflow uploads only the top-level report and dependency inventories,
not the installed packages or compiled binaries.

# MPP Buyer and Seller interoperability

The manual **MPP interoperability** workflow runs all 16 combinations of Node, Go, Python, and Rust
Buyers and Sellers. Each pair exchanges real HTTP challenges and credentials through the SDKs and
their existing upstream integrations. A local synthetic platform supplies approval and settlement
responses. No account credentials, blockchain transactions, or live payments are used.

The SDK revisions are pinned in `sdk-lock.json`. The runner uses the SDK repositories' existing peer
programs, including the Node peer maintained in the Rust repository. It does not implement a
replacement payment client or Seller. Update pins deliberately and review changes to these peers
when updating SDK revisions.

## Cases

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

## Run and read the report

Run **Actions → MPP interoperability → Run workflow** in this repository. It runs only on manual
dispatch, not on every pull request or merge. Download the `mpp-interoperability` artifact:

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
```

The report directory must not already exist. The runner compiles the Go and Rust peers, limits peer
execution time, and shuts down its child processes after each case. Unit tests of the report checker
are tooling tests; only running this matrix exercises the four SDKs together.

# SDK conformance runner

This development tool runs a language-native SDK adapter and compares its observations with shared
expected results. It is not a production SDK dependency. The adapter in `test/fixture-adapter.mjs`
tests the runner itself; it does not call an InFlow SDK or certify payment behavior.

## Responsibilities

The runner owns case selection, request sequencing, deadlines, comparisons, and reports. An SDK
adapter calls the real public SDK methods and converts their results or errors to the shared
observation format. It must not implement payment selection, signing, polling, cancellation, or
settlement on behalf of the SDK. Review the adapter's calls as well as its test results: a passing
report cannot prove that an adapter actually used the SDK.

Payment cases and local mock services are separate from this runner. There are no payment cases or
SDK adapters in this repository yet. Use only synthetic credentials and local services. The runner
is not a network sandbox: it executes the supplied program with the caller's environment and working
directory. Run trusted adapters without production credentials.

## Run

Install with `pnpm install --frozen-lockfile`. Run the tooling tests with `pnpm verify`.

Once an SDK supplies its adapter and configuration files, invoke it from the `inflow-specs`
checkout:

```sh
pnpm conformance \
  --cases /path/to/cases.json \
  --capabilities /path/to/sdk/capabilities.json \
  --implementation /path/to/sdk/implementation.json \
  --sdk-root /path/to/sdk \
  --output /path/to/new-report.json \
  --timeout-ms 10000 \
  -- /path/to/adapter argument
```

The paths above describe inputs supplied by the SDK test invocation, not files distributed here. The
command after `--` is an executable followed by its arguments; there is no shell expansion. An
adapter needing a different working directory must handle that in its executable wrapper. It must
not leave background processes running. The runner terminates only the adapter process it started;
it does not search for other processes or manage detached descendants.

The output directory must already exist. An existing report is never overwritten. Use a location
outside either checkout, or an ignored `reports/` directory, to avoid changing Git's dirty state
while running. Report files are created with owner-only permissions on systems supporting them.

Exit codes:

| Code | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| 0    | All executed cases passed; optional omissions remain listed.          |
| 1    | A comparison failed, the adapter failed, or the run was interrupted.  |
| 2    | Invalid configuration or an inability to read inputs or write output. |

Configuration failures can leave an empty reserved output file. Only a complete JSON report that
validates against the report schema is evidence. `SIGINT` and `SIGTERM` cancel an active run and
stop its adapter; forced termination of the runner cannot guarantee a report or cleanup.

## Cases and capabilities

The [case index schema](../schemas/case-index.schema.json) describes a file containing `cases`:

```json
{
  "cases": [
    {
      "id": "tooling.echo",
      "suite": "tooling",
      "operation": "fixture.echo",
      "input": { "value": { "amount": "1000000000000000001" } },
      "expect": { "result": { "amount": "1000000000000000001" } }
    }
  ]
}
```

This is a tooling example, not a payment operation. Each case has a unique identifier, a suite, an
operation, an input object, and exactly one expected `result` or `error`. The operation defines
which public SDK call an adapter makes. Its input and result definitions belong to that operation's
suite. The envelope schemas do not invent shapes for future payment operations.

Comparisons are exact: all object members must match, array order matters, and omitted members
differ from explicit `null`. Object member order does not matter. Encode amounts or identifiers that
require exact large-integer handling as strings in the operation contract; JSON numbers pass through
JavaScript number parsing. Do not put nondeterministic values in expected results. Normalize only
fields the operation contract explicitly defines for normalization.

The [capability schema](../schemas/capabilities.schema.json) declares the selected suites and
optional features:

```json
{
  "suites": ["tooling"],
  "supported_features": [],
  "unsupported_features": []
}
```

Within a selected suite, a case without `feature` is mandatory. A case with `feature` requires that
feature to appear either in `supported_features` or in `unsupported_features` as
`{"id":"feature-name","reason":"Specific reason"}`. Unsupported features produce explicit skipped
results. Supported features execute normally; a failed case cannot become a skip. Unknown suites,
duplicate case identifiers, conflicting or missing feature declarations, and runs with no executable
cases are rejected. Feature declarations refer to the selected suites only.

Suites not selected are outside the report's scope. Selecting one role does not certify other roles;
the report includes the selection. SDK verification jobs must supply the suites required for the
packages they claim to implement.

## Adapter messages

Use UTF-8 JSON lines on standard input and output: one request, then exactly one response ending in
a newline. Requests are sequential. Diagnostics belong on standard error, never standard output. The
adapter must exit successfully after input closes.

Request, following the [request schema](../schemas/adapter-request.schema.json):

```json
{
  "adapter_version": "1",
  "sequence": 1,
  "case_id": "tooling.echo",
  "operation": "fixture.echo",
  "input": { "value": { "amount": "1000000000000000001" } }
}
```

The runner does not send the expected outcome. The adapter echoes the version, sequence, and case
identifier, with exactly one observation, following the
[response schema](../schemas/adapter-response.schema.json):

```json
{
  "adapter_version": "1",
  "sequence": 1,
  "case_id": "tooling.echo",
  "result": { "amount": "1000000000000000001" }
}
```

For an expected SDK error, return `error` instead of `result`, with required `code` and `message`
and optional integer `http_status`. A matching error observation passes a negative case. A crash,
timeout, malformed response, mismatched identifier, duplicate response, or nonzero exit fails the
run. Adapters cannot return their own pass/fail verdict or runtime skip.

`adapter_version: "1"` identifies this message format, not a release version of `inflow-specs`.
Sequence numbers follow selected case positions and can have gaps where optional cases are skipped.

## Bounds

| Resource                      | Limit                                                         |
| ----------------------------- | ------------------------------------------------------------- |
| Each input configuration file | 10 MiB                                                        |
| Cases in an index             | 10,000                                                        |
| Request or response line      | 1 MiB                                                         |
| Adapter standard output       | 16 MiB per run                                                |
| Adapter standard error        | 64 KiB per run                                                |
| Response and final exit waits | 10 seconds each by default; configurable from 1 to 300,000 ms |

The timeout applies to each response and to exit after input closes, not to the entire suite.
Oversized output fails the run. Standard error is bounded and discarded; it is not copied into
reports. Reports also omit raw input and response bodies. Use synthetic data even for local
diagnostics, and reproduce a failing case in the SDK's own test tooling when detailed traces are
needed.

## Reports and reproducibility

The [report schema](../schemas/report.schema.json) records:

- Exact Git commits and dirty-state flags for the contract checkout and SDK checkout.
- The supplied implementation name, runtime, SDK package versions, and upstream dependency versions.
- SHA-256 hashes of the JSON-serialized parsed case index, capabilities, and implementation
  metadata.
- Selected capabilities and case results: `passed`, `failed`, `skipped`, or `not_run`.
- Separate `completed` and `passed` flags and a `runner_error` for incomplete runs.

Generate [implementation metadata](../schemas/implementation.schema.json) from the SDK environment
being tested. `packages` is a nonempty map of package names to versions; `dependencies` is a map of
upstream dependency names to their actually resolved versions, not manifest ranges. `runtime` names
the language runtime or compiler and version. The runner validates the descriptor but cannot
independently discover every language's dependency graph.

Both checkout revisions are checked before and after execution. A changed commit or dirty-state flag
fails the run. A dirty checkout is useful local evidence, but its commit alone cannot reproduce the
result; edits within an already dirty tree are not fingerprinted. Release verification must run on
clean pinned checkouts and retain the input files and report together.

An assertion mismatch is a completed failed run. A runner or adapter failure is incomplete, even
when earlier cases passed. Skipped optional features remain visible in a passing report. Read the
selected suites, omissions, and dirty flags before interpreting a green result.

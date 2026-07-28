# Performance and quality harness

The harness gives each performance ticket a stable workload, JSON schema, and
Performance budget result before optimization begins. These budgets are
benchmark and CI regression evidence; they never authorize production code to
reject a user operation. Run commands from `plugin/`.

## Quality gate

```sh
pnpm check
```

This runs the formatter check for the new quality and benchmark modules,
zero-warning ESLint across the package, TypeScript, all tests, the production
bundle, and the production dependency-license allowlist. The formatter scope is
intentionally ratcheted in rather than reformatting the pre-existing codebase in
the same commit as the harness.

## Benchmarks

Build the ignored production bundle before measuring cold activation:

```sh
pnpm run build:bundle
pnpm perf -- --record --output benchmarks/results/local.json
```

Legacy absolute targets remain visible as informational migration evidence, but
they do not fail the command or control production behavior. A command fails
only for the harness self-test or a matching-baseline regression beyond the
explicit tolerance. A recorded run writes the evidence and exits successfully so
a baseline can be reviewed. Check the harness failure path independently:

```sh
pnpm perf -- --profile smoke --scenario run-log-streaming --force-budget-failure
```

Run one or more scenarios with `--scenario`:

```sh
pnpm perf -- --record --scenario cold-activation
pnpm perf -- --record --scenario page-rendering,viewer-interaction
pnpm perf -- --record --scenario notebook-opening,settled-viewing,page-navigation,page-grid,concurrent-notebooks,notebook-cleanup
pnpm perf -- --record --scenario run-log-streaming
pnpm perf -- --record --scenario writable-sync-memory
pnpm perf -- --record --scenario export-preparation
pnpm perf -- --record --scenario export-transcription-pipeline
```

The available profiles are:

- `smoke`: small functional run for harness development.
- `standard`: repeatable local baseline. It renders three native-size pages and
  samples all 500 sync files at 64 KiB each.
- `reference`: the complete 20-page and 500-file/1-GiB workload. Use it only on
  a machine with enough free memory; the current writable-sync implementation is
  expected to retain the full subtree.

Label mobile evidence explicitly:

```sh
pnpm perf -- --record --platform mobile --device iphone-15-pro
```

The Node runner labels `--platform mobile` as a `desktop-mobile-simulation`. It
is useful for checking the mobile concurrency and workload contract, but it is
not physical-device evidence. Record actual iOS or Android Obsidian measurements
separately rather than relabelling a desktop run.

The runner identifies the selected desktop/mobile contract, device label, OS,
architecture, CPU, memory, Node version, plugin/Obsidian versions, Git commit,
and dirty state. Each scenario reports workload details, timing summaries, long
tasks over 50 ms, memory deltas, counters, informational legacy target
comparisons, and a normalized evidence summary with peak, settled,
responsiveness, and cleanup values. Page rendering reports opening burst,
settled viewing, and three-visible-notebook workloads separately.

Compare a run only with a reviewed result from the same device, platform
contract, and workload profile:

```sh
pnpm perf -- --device local-reference --profile standard \
  --baseline benchmarks/baselines/reviewed-local-standard.json \
  --tolerance 0.20
```

The runner rejects mismatched baseline identities. A matching metric that
regresses beyond the explicit tolerance fails the benchmark command unless
`--record` is present. `--record` is for collecting evidence, not waiving a CI
regression.

## Fixtures and privacy

Committed workloads are generated:

- a blank Ratta-RLE page and a 20-page notebook contract;
- 1,000 generated page descriptors;
- 500 deterministic file paths and a 1-GiB writable-subtree contract;
- sanitized page labels, stream lines, and PDF text.

Never add a personal `.note` file to the repository. Put private corpora under
`benchmarks/private/` (gitignored), then use the same page runner:

```sh
pnpm perf -- --record --scenario page-rendering \
  --note benchmarks/private/local.note \
  --output benchmarks/results/private-note.json
```

The JSON records only `private-note`, byte count, and page count. It never
records the source path or notebook content. Keep private-note results in the
gitignored `benchmarks/results/` directory.

## Module boundaries

- `workloads.ts` owns deterministic workload construction and reference sizes.
- `scenarios.ts` adapts those workloads to production seams; it must not contain
  CLI or JSON-file concerns.
- `harness.ts` owns statistics, memory accounting, and budget evaluation.
- `run.ts` owns argument parsing, environment metadata, report serialization,
  and exit status.
- `startup-child.cjs` isolates production-bundle evaluation in a fresh process.

Some first baselines are deliberately conservative proxies. Startup measures
module evaluation and resolved `onload()` separately against inert Obsidian
registration boundaries; viewer interaction records the current all-card grid
model before DOM counters exist; sync and export use whole-operation durations
as long-task proxies. Their optimization tickets must replace these proxies with
narrower production instrumentation without changing the report contract.

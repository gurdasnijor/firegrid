# tf-ofbm Effect diagnostics baseline

Date: 2026-05-20

Base: `50f5482a5`

## Purpose

`pnpm run effect:diagnostics` was red on main because the Effect language service returns a nonzero exit code for pre-existing diagnostics. This blocked downstream ratchets, including the import-guardrail `--error` flip, even when a branch introduced no new Effect diagnostics.

This slice keeps the diagnostic gate active but calibrates it against a checked-in baseline. Current baseline diagnostics pass; new diagnostics above the baseline fail.

## Implementation

- `scripts/tooling.mjs effect diagnostics` now captures each package's `effect-language-service diagnostics --format text` output, re-emits the original output, parses diagnostic entries, and compares them with `.effect-diagnostics-baseline.json`.
- `scripts/tooling.mjs effect diagnostics --update-baseline` writes the current baseline.
- `pnpm run effect:diagnostics:baseline` is the explicit baseline refresh command.
- `pnpm run lint` now includes `pnpm run effect:diagnostics`, so `pnpm run verify` exercises the calibrated Effect diagnostics gate.

The baseline keys include project, file, line, column, severity, diagnostic code, and first diagnostic message line. This makes the gate fail on added diagnostics while allowing existing entries to disappear naturally as refactors clean them up.

## Baseline Snapshot

Command:

```bash
pnpm run effect:diagnostics:baseline
```

Observed current baseline:

| Project | Errors | Warnings | Messages |
|---|---:|---:|---:|
| `packages/client-sdk/tsconfig.json` | 0 | 2 | 0 |
| `packages/effect-durable-operators/tsconfig.json` | 0 | 0 | 4 |
| `packages/effect-durable-streams/tsconfig.json` | 0 | 3 | 34 |
| `packages/host-sdk/tsconfig.json` | 1 | 40 | 45 |
| `packages/protocol/tsconfig.json` | 0 | 0 | 18 |
| `packages/runtime/tsconfig.json` | 0 | 6 | 23 |
| `packages/cli/tsconfig.json` | 0 | 0 | 0 |
| `packages/tiny-firegrid/tsconfig.json` | 0 | 0 | 0 |
| **Total** | **1** | **51** | **124** |

The dispatch referenced an earlier CI summary of `0 errors + 5 warnings + 21 messages` across protocol/runtime. The fresh `origin/main` worktree for this slice produced the larger table above because the existing script scans every package tsconfig, not only protocol/runtime.

## Validation

```bash
pnpm run effect:diagnostics
```

Result:

```text
status=0
Effect diagnostics baseline OK: current=1 errors, 51 warnings and 124 messages, baseline=1 errors, 51 warnings and 124 messages
```

## Maintenance

Do not refresh `.effect-diagnostics-baseline.json` to hide new diagnostics. Refresh it only when intentional cleanup reduces or deliberately reshapes the diagnostic set. The normal path is:

1. Fix or intentionally reshape diagnostics.
2. Run `pnpm run effect:diagnostics:baseline`.
3. Review the JSON diff and this report's count table if the baseline meaning changed.
4. Confirm `pnpm run effect:diagnostics` exits zero.

# Future PR Guardrail Checklist

Source: OCA `FC-FUTURE-PR-GUARDRAIL-CHECKLIST` read-only report.

## One-Line Boundary

Flamecast owns product semantics: sessions surface, AgentSpec, providers,
capabilities, contributors, provider auth/options, sandbox lifecycle, SDK
ergonomics, webhook fanout, benchmarks, and UI. Firegrid remains the durable
operation, event-stream, event-plane, and wait substrate with no Flamecast
vocabulary.

## Stop As Blocker

- Flamecast product vocabulary added under Firegrid packages or
  `features/firegrid`.
- Reusable Firegrid adapter package for Flamecast.
- Generic Permission/Tool/Provider/Capability abstractions in `@firegrid/*`.
- Standard Webhooks, callback retry, callback URL minting, callback filtering,
  or outbound HTTP fanout primitives in Firegrid.
- Sandbox lifecycle primitives in Firegrid.
- Credential storage, BYOK, redaction, or transport credentials in Firegrid.
- Provider compatibility checks or model curation in Firegrid.
- Dynamic runtime module loading, `FIREGRID_RUNTIME_MODULE`, or `firegrid dev`
  resurrection.
- Flamecast event union as Firegrid-native row families.
- `permission.required` as a Firegrid-native row family.
- Direct durable terminal-row authorship or any canonical forbidden source
  token.
- Cross-repo edits in a single PR.
- Smoke-only or docs-only PRs touching production source, exports, or baselines
  without a scoped justification.

## Changes Requested

- Wait/wake flow races: request row emitted, then sleep, or external decision
  written before deterministic request/Pending observation.
- Runtime claimed browser-safe or edge-runnable.
- App-facing `@firegrid/substrate/kernel` imports or examples.
- Runtime composition outside `Firegrid.composeRuntime`.
- Single-channel wait proof when approve/deny or success/failure parity is
  needed.
- Firegrid SHA pin not verified as reachable from `origin/main`.
- Consumer uses `workspace:`, sibling paths, `link:`, or unpublished registry
  assumptions for `@firegrid/*`.
- Workspace-dependency checks do not cover all four dependency sections.
- Forbidden-source token guard is shorter than the canonical list.
- Smoke commits `dist/`, tarballs, or registry-publish assumptions.

## Required Package-Consumption Bars

- Pinned 40-character `FIREGRID_REF`, post-checkout SHA assertion, and
  reachability from Firegrid `origin/main`.
- Build and pack required Firegrid packages from the pinned ref.
- Temporary external consumer using `file:<absolute-tmp-path>` tarball deps.
- `pnpm.overrides` for transitive `@firegrid/substrate`.
- NodeNext module and module resolution in consumer `tsconfig`.
- Full forbidden-token source guard.
- Final consumer manifest guard against workspace or sibling paths.
- Explicit `Firegrid.composeRuntime` with handlers, subscribers, and providers.
- EventPlane + PlaneProducer + RunWait + projectionMatch wait/wake recipe.
- Deterministic public `Pending` or projection visibility gate before external
  decision/result writes.
- Typed terminalization through handler return or `Effect.fail`.
- No committed artifacts, tarballs, registry publication assumptions, or dev
  launcher resurrection.

## First-Lane Readiness Criteria

- Firegrid foundation SDD lands first and ratifies multi-turn handler reentry,
  reconnect/replay, cancellation pattern, and runtime locality.
- Flamecast spec lane lands for AgentSpec, capabilities, provider manifests,
  compatibility checks, webhooks, and provider auth/options.
- Any smoke pins a Firegrid SHA equal to or newer than the foundation-spec
  closure merge.
- PR is one repo only, scope-clean, CI green, and merge state CLEAN.
- Reviewers do not merge.


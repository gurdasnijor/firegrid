# SDD — Rebuild the Firegrid CLI launchers (`run` / `acp` / `start`) on the unified host

Status: DRAFT — for alignment before implementation.
Context: #765 (unified-subscriber-kernel cutover) **deleted** the CLI launchers
rather than migrating them. `packages/cli/src/bin/run.ts` is a tombstone that
exits 1; the README Quickstart and Zed external-agent integration are both broken.

---

## §0 — The load-bearing decision

**Rebuild the three commands on the unified `FiregridHost`, with the logic in
`packages/runtime/src/bin/{run,acp,start}.ts` as the DIRECT entry points** (root
scripts run them via `tsx`). The former `@firegrid/cli` subprocess-launcher layer
is **retired** — no spawned child process.

Two things are load-bearing and everything else follows from them:

1. **Composition tier, not a launcher.** `runtime/src/bin/**` is the blessed
   "process composition tier" that may import runtime + client-sdk (the
   dep-cruiser rules already bless it). The bins parse argv (`@effect/cli`) and
   compose the host directly; root scripts point straight at them
   (`firegrid:acp = tsx packages/runtime/src/bin/acp.ts`). So there is no
   `@firegrid/cli` indirection, no extra process layer between Zed and the ACP
   edge, and no hardcoded `../../../runtime/src/bin` source-path coupling. The old
   `cli-no-runtime` rule is moot once there is no `@firegrid/cli` execution code.

2. **Host model — self-contained ephemeral vs. client-to-daemon.**
   - `run` and `acp` are **self-contained**: they embed an in-process
     durable-streams backend (`DurableStreamTestServer`, already used by every
     sim when `DURABLE_STREAMS_BASE_URL` is unset) and compose `FiregridLive`
     (client) + `FiregridHost` (host) in one process. This preserves the
     zero-setup one-liner UX the README and Zed require.
   - `start` is the **long-lived host** — today's `firegrid:host` daemon — plus
     an optional `--mcp-port`. It binds to a real `DURABLE_STREAMS_BASE_URL`.

   We keep both models: Zed launches a fresh `firegrid acp` per session (must be
   self-contained), while a shared host for multiple clients is `start`.

The old `run.ts` (994 lines, pre-cutover) is **not** ported — it predates the
unified kernel. We rebuild the same *command surface* on the unified composition.

---

## §1 — Goals / non-goals

**Goals**
- Restore `firegrid run`, `firegrid acp`, `firegrid start`.
- Zed external-agent compatibility: `firegrid acp` over stdio, reproducing the
  tf-r1gz live proof (real ACP client → `initialize`/`session/new`/`session/prompt`,
  backing agent connects to the injected runtime-context MCP server, 11-tool
  round-trip).
- Make the README Quickstart one-liners true again.

**Non-goals**
- No new public client API; reuse `@firegrid/client-sdk`.
- No multi-tenant/production hardening of the embedded durable-streams server
  (see §9 decision 1).
- No change to the agent tool surface.

---

## §2 — Command surface (restored, mapped to the unified host)

| Command | Purpose | Key flags |
| --- | --- | --- |
| `run` | Launch an agent, optionally prompt it, stream output, exit. | `--agent`, `--agent-protocol`, `--secret-env` (repeatable), `--prompt`, `--cwd`, `--otel-file`, `-- <agent-argv>` |
| `acp` | Present Firegrid as an ACP server over stdio for an editor (Zed). | `--agent`, `--agent-protocol`, `--secret-env`, `--cwd`, `--otel-file`, `--permission` (forward/deny/allow), `-- <agent-argv>` |
| `start` | Long-lived host bound to a durable-streams backend. | `--namespace`, `--mcp-port`, `--prompt`, `-- <agent-argv>` |

Restored example invocations (the README/Zed targets):

```bash
pnpm firegrid -- run --agent codex-acp --agent-protocol acp \
  --secret-env OPENAI_API_KEY \
  --prompt "Use the Firegrid sleep tool once, then summarize." \
  -- npx -y @zed-industries/codex-acp@0.14.0

pnpm firegrid -- acp --agent codex-acp --agent-protocol acp \
  --otel-file .firegrid/acp-trace.jsonl --cwd "$PWD" \
  -- npx -y @zed-industries/codex-acp@0.14.0
```

---

## §3 — Architecture

```
root package.json scripts        @firegrid/runtime  (entry = the logic, run via tsx)
  firegrid:run  ─▶  runtime/src/bin/run.ts
  firegrid:acp  ─▶  runtime/src/bin/acp.ts
  firegrid:host ─▶  runtime/src/bin/host.ts   (exists)
```

No `@firegrid/cli` package in the path: each bin is the direct entry — it parses
argv (`@effect/cli`) and composes the host in-process. The old
`cli/src/bin/{index,host,launcher}.ts` subprocess shims are removed.

The shared composition (a single `runtime/src/bin/_compose.ts` helper):

```
embeddedOrConfiguredDurableStreams      // DurableStreamTestServer | DURABLE_STREAMS_BASE_URL
  → FiregridHost({ codec: "acp", baseUrl, namespace })
  → FiregridMcpServerLayer + FiregridRuntimeContextMcpBaseUrlLive   // tf-ll90.9.3
  → FiregridOtelLive (--otel-file / --cwd, SimpleSpanProcessor)     // tf-r1gz
  → FiregridLive (client) for run/acp drivers
```

`run`/`acp` provide the embedded backend; `start` requires the configured one.

---

## §4 — `firegrid run`

`createOrLoad({ externalKey, runtime })` → `start()` → optional `prompt(text)` →
stream agent-output observations to **stdout** until terminal → exit. Output is
human-readable text; `--otel-file` captures the durable trace separately.

---

## §5 — `firegrid acp` (the Zed edge)

Wire `process.stdin`/`process.stdout` to the existing `AcpStdioEdge`
(`runtime/src/sources/codecs/acp/stdio-edge.ts`), which already implements
`initialize` / `session/new` / `session/prompt` as an ACP server. Each
`session/new` lowers to a unified session that spawns the backing agent
(`local.jsonl({ argv })`) with `runtimeContextMcp: { enabled: true }`, so the
backing agent connects to the host's `FiregridMcpServerLayer` and sees the
11-tool toolkit. Permission policy via `--permission` (default `forward`).

**stdout is reserved for ACP JSON-RPC frames** — all diagnostics go to stderr.

---

## §6 — Agent config plumbing

`--agent NAME --agent-protocol acp --secret-env K -- <argv>` decodes to the
protocol-owned `local.jsonl({ argv, agentProtocol, ... })` launch intent.
`--secret-env NAME` authorizes passing the host env var to the spawned agent via
the runtime intent's env binding (`{ name, ref: "env:NAME" }`), not by leaking
the value into config. `runtimeContextMcp: { enabled: true }` is set so the
injected toolkit is reachable.

---

## §7 — OTel export (preserve tf-r1gz)

Carry the tf-r1gz fix forward verbatim: a **relative** `--otel-file` resolves
against `--cwd` when supplied (else `process.cwd()`), pins to an **absolute**
path, announces it on **stderr**, and uses `SimpleSpanProcessor` (immediate
per-span write) so short or abruptly-killed Zed sessions don't drop the tail.

---

## §8 — The `firegrid` dispatcher

The README uses `pnpm firegrid -- <sub>`. Today only `firegrid:host` exists.
Add a `firegrid` root entry that routes `run` / `acp` / `start` to the matching
runtime bin (decision in §9.4).

---

## §9 — Open decisions (need sign-off before build)

1. **Embedded durable-streams backend.** `DurableStreamTestServer` is a real
   server but named for tests. Ship it as the embedded backend for `run`/`acp`,
   or promote/rename a non-"test" embedded server first? (Recommend: ship it now
   behind the bin, rename later — it unblocks the one-liner today.)
2. **Scope / sequencing.** `acp` first (Zed is the stated priority), then `run`,
   then `start`? Or all three together? (Recommend: `acp` + `run` first; `start`
   is mostly `firegrid:host` already.)
3. **MCP-by-default.** Should `acp`/`run` bind `FiregridMcpServerLayer` always,
   or behind `--mcp` / `--no-mcp`? (Recommend: on by default for `acp` since the
   toolkit is the point; flag to disable.)
4. **Dispatcher shape.** A single `firegrid` bin that routes subcommands
   (restores `pnpm firegrid -- run`), vs. separate `firegrid:run` / `firegrid:acp`
   scripts. (Recommend: single dispatcher — matches the README and old UX.)
5. **`@effect/cli` vs hand-rolled parsing.** The old surface used `@effect/cli`
   (`Args`/`Command`). Reuse it, or parse argv directly? (Recommend: `@effect/cli`
   — it already modeled this exact surface.)

---

## §10 — Proof plan

- **Zed live proof (the bar):** reproduce tf-r1gz — spawn `firegrid acp` from a
  **non-repo** cwd, drive it with a real ACP client (`initialize` → `session/new`
  → `session/prompt`), assert the 7 required spans + `mcp.tool_count: 11` +
  `callOk=true` in `<repo>/.firegrid/acp-trace.jsonl`.
- **Creds-free `run`:** `firegrid run` against the `fake-acp-agent-process`
  fixture (no `OPENAI_API_KEY`) shows a real spawn + output + terminal exit.
- **Gates:** full CI set incl. `lint:host-sdk-imports` (the CLI-boundary rule)
  and a trace-seam assertion that the acp edge produced the executor spans.
```

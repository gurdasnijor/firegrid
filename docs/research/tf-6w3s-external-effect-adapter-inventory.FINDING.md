# tf-6w3s External-Effect Adapter Inventory

Date: 2026-05-20
Scope: Cycle 2 source-read 2 from `docs/research/one-substrate-primitive-validation-spike.md`

## Verdict

FOUND ADDITIONAL ADAPTERS + BOUNDARY VIOLATIONS.

The SDD's "small fixed set" claim is directionally confirmed: the production Firegrid adapter set is finite and clusters around sandbox process management, codec byte adapters, verified webhook ingest, and network clients. However, the literal boundary claim that external-effect call sites "should be in `packages/runtime/`" is not true today.

There are two kinds of outside-runtime hits:

1. Substrate-library transports in `packages/effect-durable-streams/` and `packages/effect-durable-operators/`. These are not application-layer adapters, but they are external network/storage effects and need an explicit Cycle 2 carveout if the package boundary remains runtime-only.
2. Host/CLI projection shims in `packages/host-sdk/` and `packages/cli/`. These are product call sites outside `packages/runtime/` and are boundary violations under the source-read criterion.

## Method

Static grep pass over the monorepo for:

- `await fetch(` / `fetch(` / Effect HTTP client construction
- `Effect.tryPromise(`
- `child_process`, process spawning, `CommandExecutor`, `Process` stdio
- file I/O outside test or fixture paths
- direct stream/socket APIs

Primary production-source confirmation query:

```bash
rg -n --glob 'packages/*/src/**/*.ts' --glob '!packages/tiny-firegrid/src/simulations/**' --glob '!**/*.test.ts' --glob '!**/test/**' \
  -e 'Effect\.tryPromise\s*\(' -e '\bawait\s+fetch\s*\(' -e '\bfetch\s*\(' \
  -e 'HttpClientRequest\.' -e 'FetchHttpClient|NodeHttpClient' \
  -e 'node:http|createServer|server\.listen' \
  -e 'node:child_process|Command\.make|CommandExecutor|process\.stdin|process\.stdout|process\.stderr' \
  -e 'node:fs|fs/promises|readFile\s*\(|writeFile\s*\(|createWriteStream|createReadStream|readdir\s*\(|mkdir\s*\(' \
  -e 'ReadableStream|WritableStream|TransformStream' packages
```

No `await fetch(` or raw `fetch(` production package hits were found.

## Production Inventory

| Call site | External effect | Category | Location status | Finding status |
|---|---:|---|---|---|
| `packages/runtime/src/agent-event-pipeline/sources/sandbox/local-process.ts:141` | `Command.make(...)` process command construction | sandbox | inside runtime | Known adapter |
| `packages/runtime/src/agent-event-pipeline/sources/sandbox/local-process.ts:218` | `Stream.run(process.stdin)` | sandbox process stdin | inside runtime | Known adapter |
| `packages/runtime/src/agent-event-pipeline/sources/sandbox/local-process.ts:222` | `new WritableStream(...)` for process stdin | sandbox byte stream | inside runtime | Known adapter |
| `packages/runtime/src/agent-event-pipeline/sources/sandbox/local-process.ts:252` | `Stream.toReadableStreamRuntime(... process.stdout ...)` | sandbox byte stream | inside runtime | Known adapter |
| `packages/runtime/src/agent-event-pipeline/sources/sandbox/local-process.ts:262` | `Stream.toReadableStreamRuntime(... process.stderr ...)` | sandbox byte stream | inside runtime | Known adapter |
| `packages/runtime/src/agent-event-pipeline/sources/sandbox/local-process.ts:306` | `commandExecutor.start(built)` | sandbox process start | inside runtime | Known adapter |
| `packages/runtime/src/agent-event-pipeline/sources/sandbox/local-process.ts:311` | `process.stdout.pipe(...)` | sandbox process stdout | inside runtime | Known adapter |
| `packages/runtime/src/agent-event-pipeline/sources/sandbox/local-process.ts:320` | `process.stderr.pipe(...)` | sandbox process stderr | inside runtime | Known adapter |
| `packages/runtime/src/agent-event-pipeline/sources/sandbox/local-process.ts:338` | `Stream.run(process.stdin)` | sandbox process stdin | inside runtime | Known adapter |
| `packages/runtime/src/agent-event-pipeline/sources/sandbox/local-process.ts:387` | `commandExecutor.start(built)` scoped byte-pipe launch | sandbox process start | inside runtime | Known adapter |
| `packages/runtime/src/agent-event-pipeline/sources/byte-stream.ts:14-16` | `WritableStream` / `ReadableStream` byte stream contract | sandbox/codec byte stream | inside runtime | Known adapter contract |
| `packages/runtime/src/agent-event-pipeline/codecs/stdio-jsonl/index.ts:218` | `WritableStream<Uint8Array>` stdin boundary | codec | inside runtime | Known adapter |
| `packages/runtime/src/agent-event-pipeline/codecs/stdio-jsonl/index.ts:231` | `Effect.tryPromise(... writer.write ...)` | codec | inside runtime | Known adapter |
| `packages/runtime/src/agent-event-pipeline/codecs/stdio-jsonl/index.ts:248` | `ReadableStream<Uint8Array>` stdout boundary | codec | inside runtime | Known adapter |
| `packages/runtime/src/agent-event-pipeline/codecs/stdio-jsonl/index.ts:250` | `Stream.fromReadableStream(...)` | codec | inside runtime | Known adapter |
| `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts:92` | `Effect.tryPromise(...)` ACP promise wrapper | codec/network | inside runtime | Known adapter |
| `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts:656` | `connection.cancel(...)` via ACP promise wrapper | codec/network | inside runtime | Known adapter |
| `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts:668` | `Effect.tryPromise(... writer.close ...)` | codec byte stream | inside runtime | Known adapter |
| `packages/runtime/src/verified-webhook-ingest/adapter.ts:148` | `Effect.tryPromise(...)` WebCrypto HMAC | verified webhook ingest | inside runtime | Known adapter |
| `packages/runtime/src/verified-webhook-ingest/adapter.ts:172` | `Effect.tryPromise(...)` WebCrypto SHA-256 | verified webhook ingest | inside runtime | Known adapter |
| `packages/runtime/src/agent-adapters/acp/adapter.ts:285` | `Effect.tryPromise(... connection.initialize ...)` | network/agent adapter | inside runtime | Known adapter |
| `packages/runtime/src/agent-adapters/acp/adapter.ts:302` | `Effect.tryPromise(... connection.newSession ...)` | network/agent adapter | inside runtime | Known adapter |
| `packages/runtime/src/agent-adapters/acp/adapter.ts:320` | `Effect.tryPromise(... connection.cancel ...)` | network/agent adapter | inside runtime | Known adapter |
| `packages/runtime/src/agent-adapters/acp/adapter.ts:373` | `Effect.tryPromise(... connection.prompt ...)` | network/agent adapter | inside runtime | Known adapter |
| `packages/runtime/src/agent-adapters/acp/adapter.ts:395` | `Effect.tryPromise(... connection.cancel ...)` | network/agent adapter | inside runtime | Known adapter |
| `packages/effect-durable-streams/src/protocol/Http.ts:303` | `HttpClient.HttpClient` service | durable stream HTTP transport | outside runtime | Additional substrate transport |
| `packages/effect-durable-streams/src/protocol/Http.ts:313` | `client.execute(...)` | durable stream HTTP transport | outside runtime | Additional substrate transport |
| `packages/effect-durable-streams/src/protocol/Http.ts:370` | `HttpClientRequest.get(...)` | durable stream HTTP transport | outside runtime | Additional substrate transport |
| `packages/effect-durable-streams/src/protocol/Http.ts:383` | `HttpClientRequest.head(...)` | durable stream HTTP transport | outside runtime | Additional substrate transport |
| `packages/effect-durable-streams/src/protocol/Http.ts:460` | HTTP GET execution through `executeGet` | durable stream HTTP transport | outside runtime | Additional substrate transport |
| `packages/effect-durable-streams/src/protocol/Http.ts:503` | `res.text` response body read | durable stream HTTP transport | outside runtime | Additional substrate transport |
| `packages/effect-durable-streams/src/protocol/Http.ts:549` | SSE/raw GET execution through `executeGet` | durable stream HTTP transport | outside runtime | Additional substrate transport |
| `packages/effect-durable-streams/src/protocol/Http.ts:613` | `HttpClientRequest.post(...)` | durable stream HTTP transport | outside runtime | Additional substrate transport |
| `packages/effect-durable-streams/src/protocol/Http.ts:663` | `HttpClientRequest.put(...)` | durable stream HTTP transport | outside runtime | Additional substrate transport |
| `packages/effect-durable-streams/src/protocol/Http.ts:687` | `HttpClientRequest.del(...)` | durable stream HTTP transport | outside runtime | Additional substrate transport |
| `packages/effect-durable-streams/src/internal/sse.ts:72` | `Http.getStream(...)` | durable stream SSE transport | outside runtime | Additional substrate transport |
| `packages/effect-durable-streams/src/internal/sse.ts:89` | `new TextDecoder()` | durable stream SSE decode | outside runtime | Additional substrate transport |
| `packages/effect-durable-streams/src/internal/sse.ts:92` | `createParser(...)` SSE parser | durable stream SSE decode | outside runtime | Additional substrate transport |
| `packages/effect-durable-streams/src/internal/sse.ts:101` | `res.stream.pipe(...)` | durable stream SSE transport | outside runtime | Additional substrate transport |
| `packages/effect-durable-streams/src/internal/sse.ts:106` | `decoder.decode(bytes, ...)` | durable stream SSE decode | outside runtime | Additional substrate transport |
| `packages/effect-durable-streams/src/protocol/Producer.ts:195` | send loop requires `HttpClient.HttpClient` | durable stream producer transport | outside runtime | Additional substrate transport |
| `packages/effect-durable-streams/src/protocol/Producer.ts:201` | `sendBatch(...)` HTTP append path | durable stream producer transport | outside runtime | Additional substrate transport |
| `packages/effect-durable-streams/src/protocol/Producer.ts:243` | background drain effect requires `HttpClient.HttpClient` | durable stream producer transport | outside runtime | Additional substrate transport |
| `packages/effect-durable-operators/src/DurableTable.ts:505` | `Effect.tryPromise(...)` TanStack DB action persistence | durable table substrate | outside runtime | Additional substrate transport/storage |
| `packages/effect-durable-operators/src/DurableTable.ts:602` | `Effect.provide(FetchHttpClient.layer)` | durable table HTTP transport | outside runtime | Additional substrate transport/storage |
| `packages/effect-durable-operators/src/DurableTable.ts:607` | `Layer.succeed(FetchHttpClient.Fetch, streamOptions.fetch)` | durable table HTTP transport override | outside runtime | Additional substrate transport/storage |
| `packages/effect-durable-operators/src/DurableTable.ts:851` | `Effect.tryPromise(... awaitTxId ...)` | durable table async storage wait | outside runtime | Additional substrate transport/storage |
| `packages/effect-durable-operators/src/DurableTable.ts:865` | `Effect.tryPromise(... waitForStoredRow ...)` | durable table async storage wait | outside runtime | Additional substrate transport/storage |
| `packages/effect-durable-operators/src/DurableTable.ts:1025` | `Effect.tryPromise(... db.stream.create ...)` | durable table stream creation | outside runtime | Additional substrate transport/storage |
| `packages/effect-durable-operators/src/DurableTable.ts:1052` | `Effect.tryPromise(... db.preload ...)` | durable table preload | outside runtime | Additional substrate transport/storage |
| `packages/effect-durable-operators/src/DurableTable.ts:1087` | `Effect.tryPromise(... db.utils.awaitTxId ...)` | durable table async storage wait | outside runtime | Additional substrate transport/storage |
| `packages/host-sdk/src/host/mcp-host.ts:45` | `node:http` `createServer` import | network/server | outside runtime | Boundary violation |
| `packages/host-sdk/src/host/mcp-host.ts:168` | documented `NodeHttpServer.layer(createServer, ...)` composition | network/server | outside runtime | Boundary violation |
| `packages/host-sdk/src/host/mcp-host.ts:270` | `NodeHttpServer.layer(createServer, { port, host })` | network/server | outside runtime | Boundary violation |
| `packages/host-sdk/src/host/runtime-context-session/codec-adapter.ts:71` | `ReadableStream<Uint8Array>` stderr input | codec/session stream shim | outside runtime | Boundary violation |
| `packages/host-sdk/src/host/runtime-context-session/codec-adapter.ts:73` | `Stream.fromReadableStream(...)` | codec/session stream shim | outside runtime | Boundary violation |
| `packages/host-sdk/src/host/runtime-context-session/raw-adapter.ts:47` | `WritableStreamDefaultWriter<Uint8Array>` stdin writer | raw/session stream shim | outside runtime | Boundary violation |
| `packages/host-sdk/src/host/runtime-context-session/raw-adapter.ts:175` | `ReadableStream<Uint8Array>` stdout/stderr input | raw/session stream shim | outside runtime | Boundary violation |
| `packages/host-sdk/src/host/runtime-context-session/raw-adapter.ts:177` | `Stream.fromReadableStream(...)` | raw/session stream shim | outside runtime | Boundary violation |
| `packages/host-sdk/src/host/runtime-context-session/raw-adapter.ts:303` | `Effect.tryPromise(... session.stdin.write ...)` | raw/session stream shim | outside runtime | Boundary violation |
| `packages/cli/src/bin/run.ts:316` | `Effect.tryPromise(...)` embedded Durable Stream test server start | CLI/dev server lifecycle | outside runtime | Boundary violation or explicit CLI exception needed |
| `packages/cli/src/bin/run.ts:338` | `Effect.tryPromise(...)` embedded Durable Stream test server stop | CLI/dev server lifecycle | outside runtime | Boundary violation or explicit CLI exception needed |

## Non-Product Hits Excluded From Boundary Verdict

These were still recorded because the source-read asked for a monorepo grep pass, but they are test, simulation, fixture, or repo tooling surfaces rather than product substrate adapters.

| Call site group | External effect | Status |
|---|---|---|
| `packages/tiny-firegrid/src/runner/telemetry.ts:3,12,13,120,215` | OTLP HTTP client, `execSync`, trace file writer | Simulation runner harness, excluded |
| `packages/tiny-firegrid/src/runner/runtime.ts:20,21,134,138` | run-directory mkdir/stat/write | Simulation runner harness, excluded |
| `packages/tiny-firegrid/src/runner/list.ts:1,39` | simulation directory read | Simulation runner harness, excluded |
| `packages/tiny-firegrid/src/runner/show.ts:2,118` | run directory read | Simulation runner harness, excluded |
| `packages/tiny-firegrid/src/runner/trace.ts:2,83,95,114` | trace file/directory read | Simulation runner harness, excluded |
| `packages/tiny-firegrid/src/index.ts:55,63,83,93,95,113,124` | Effect CLI `Command.make` declarations | CLI parsing only, no child process spawn |
| `packages/tiny-firegrid/src/simulations/codec-stdio-jsonl-live/driver.ts:39,47,73,74` | direct `child_process.spawn("codex", ...)` and stdio streams | Simulation driver, excluded |
| `packages/tiny-firegrid/src/simulations/codec-stdio-jsonl-live/host.ts:7,170,193` | local HTTP server in sim host | Simulation host, excluded |
| `packages/tiny-firegrid/src/simulations/inv4-channel-registry/host.ts:17,261,284` | local HTTP server in sim host | Simulation host, excluded |
| `packages/tiny-firegrid/src/simulations/inv2-waitforworkflow-layered/mcp-server.ts:46` | local MCP HTTP server in sim fixture | Simulation fixture, excluded |
| `packages/tiny-firegrid/src/simulations/inv2-waitforworkflow/mcp-server.ts:34` | local MCP HTTP server in sim fixture | Simulation fixture, excluded |
| `packages/tiny-firegrid/src/simulations/inv5-cross-agent-event-choreography/host.ts:54` | local HTTP server in sim host | Simulation host, excluded |
| `packages/tiny-firegrid/src/simulations/dark-factory/driver.ts:6,65,67,68` | artifact directory/file writes | Simulation artifact writer, excluded |
| `packages/tiny-firegrid/src/simulations/phase1-lane6-new-shape-replay/driver.ts:4` | `Effect.tryPromise` harness body | Simulation driver, excluded |
| `packages/tiny-firegrid/src/simulations/runtime-tool-use-executor-contract/driver.ts:4` | `Effect.tryPromise` harness body | Simulation driver, excluded |
| `packages/tiny-firegrid/src/simulations/phase0-wave-2b-stream-zip-restart-replay/driver.ts:4` | `Effect.tryPromise` harness body | Simulation driver, excluded |
| `packages/tiny-firegrid/src/simulations/to-be-migrated/**` | legacy spike strings using HTTP, fs, stdin/stdout, `Effect.tryPromise` | Archived/migration spike text, excluded |
| `packages/*/test/**`, `packages/**/*.test.ts`, fixtures | `fetch`, `FetchHttpClient`, file I/O, web streams, spawned fixture scripts | Tests/fixtures, excluded |
| `scripts/**` | shell/node tooling fs, process, and HTTP-adjacent commands | Repository tooling, excluded |

## Boundary Violations Worth Fixing

Under the source-read rule "external-effect call sites should be in `packages/runtime/`", these are the actionable non-runtime product call sites:

1. `packages/host-sdk/src/host/mcp-host.ts:45,270` - the MCP projection binds a loopback HTTP server directly in host-sdk through `NodeHttpServer.layer(createServer, ...)`.
2. `packages/host-sdk/src/host/runtime-context-session/codec-adapter.ts:71,73` - host-sdk consumes process stderr as a `ReadableStream` and converts it into an Effect stream.
3. `packages/host-sdk/src/host/runtime-context-session/raw-adapter.ts:47,175,177,303` - host-sdk owns raw stdin writer and stdout/stderr stream conversion/write effects.
4. `packages/cli/src/bin/run.ts:316,338` - CLI dev path starts/stops an embedded Durable Stream test server through `Effect.tryPromise`.

The substrate-library hits in `packages/effect-durable-streams/` and `packages/effect-durable-operators/` are not the same class as host/CLI violations. They are foundational durable substrate transports, but Cycle 2 should either name them as an explicit exception or move the SDD package-boundary wording away from "only `packages/runtime/`".

## Implication For tf-ycxw Cycle 2 Synthesis

Cycle 2 should not synthesize the SDD as "all external effects already enter only through `packages/runtime/`." A more accurate synthesis is: Firegrid's application-level external adapters are finite and match the SDD's small set, but substrate transport packages and host projection shims remain outside the runtime package. The synthesis should either promote `effect-durable-streams` / `effect-durable-operators` to an explicit "substrate transport" exception and schedule host-sdk MCP/session stream call sites for migration, or revise the boundary rule to describe ownership by adapter role instead of by package path.

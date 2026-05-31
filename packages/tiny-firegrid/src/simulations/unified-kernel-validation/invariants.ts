/**
 * Structural collapse-invariant checks. Pure source-text scans over
 * the simulation tree — no runtime needed. Asserted by the driver
 * alongside the runtime probes; together they prove the unified
 * shape both behaves correctly AND structurally excludes the retired
 * Shape C / DurableDeferred patterns.
 *
 * Adding a new offender (e.g. re-introducing a `runs` row family) is
 * caught by these checks at simulation-run time, BEFORE any test re-
 * driving could mask the regression.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const simRoot = fileURLToPath(new URL(".", import.meta.url))

const stripComments = (source: string): string => {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, "")
  return noBlock
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//")
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join("\n")
}

interface SimFile {
  readonly path: string
  readonly text: string
}

// Files whose own bodies contain the regex patterns the scan uses
// (this module + the driver that names the assertion messages). They
// would self-match and falsely fail the structural checks.
const SCAN_EXCLUDED_BASENAMES = new Set(["invariants.ts", "driver.ts"])

const readAllSimFiles = (): ReadonlyArray<SimFile> => {
  const acc: Array<SimFile> = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const s = statSync(full)
      if (s.isDirectory()) walk(full)
      else if (entry.endsWith(".ts") && !SCAN_EXCLUDED_BASENAMES.has(entry)) {
        acc.push({ path: full, text: stripComments(readFileSync(full, "utf8")) })
      }
    }
  }
  walk(simRoot)
  return acc
}

export interface InvariantCheck {
  readonly id: string
  readonly title: string
  readonly offenders: ReadonlyArray<string>
}

export interface StructuralCheckResult {
  readonly checks: ReadonlyArray<InvariantCheck>
  readonly passed: number
  readonly failed: number
}

type Predicate = (file: SimFile) => boolean

const offendersFor = (files: ReadonlyArray<SimFile>, pred: Predicate): ReadonlyArray<string> =>
  files.filter(pred).map((f) => f.path)

export const runStructuralChecks = (): StructuralCheckResult => {
  const files = readAllSimFiles()
  const subscribers = files.filter((f) => f.path.includes("/subscribers/"))

  const checks: ReadonlyArray<InvariantCheck> = [
    {
      id: "I1-no-shape-c-sequence-gate",
      title: "no Shape C `eventAlreadyProcessed` / `lastProcessedInputSequence` dedup",
      offenders: offendersFor(files, (f) =>
        /eventAlreadyProcessed/.test(f.text) ||
        /lastProcessedInputSequence/.test(f.text)),
    },
    {
      id: "I2-no-deferred-mailbox-in-subscribers",
      title: "no `DurableDeferred` mailbox in subscriber bodies",
      offenders: offendersFor(subscribers, (f) => /DurableDeferred/.test(f.text)),
    },
    {
      id: "I3-no-appendRuntimeInputDeferred-bridge",
      title: "no `appendRuntimeInputDeferred` / `RuntimeContextWorkflowRuntime` bridge",
      offenders: offendersFor(files, (f) =>
        /appendRuntimeInputDeferred/.test(f.text) ||
        /RuntimeContextWorkflowRuntime/.test(f.text)),
    },
    {
      id: "I4-no-parallel-connectors",
      title: "no parallel `connectors/` / `ConnectorAdapter` primitive",
      offenders: offendersFor(files, (f) =>
        /ConnectorAdapter/.test(f.text) ||
        /\/connectors\//.test(f.text)),
    },
    {
      id: "I5-bodies-park-via-sanctioned-primitive",
      title: "every subscriber body parks via `awaitSignal` / `Workflow.suspend` / `DurableClock.sleep`",
      offenders: subscribers.flatMap((f) => {
        const hasWorkflowMake = /Workflow\.make/.test(f.text)
        if (!hasWorkflowMake) return []
        const parks =
          /awaitSignal\s*[<(]/.test(f.text) ||
          /Workflow\.suspend/.test(f.text) ||
          /DurableClock\.sleep/.test(f.text)
        return parks ? [] : [f.path]
      }),
    },
    {
      id: "I6-tool-dispatch-via-idempotencyKey",
      title: "tool dispatch idempotency via `Workflow.idempotencyKey`, no separate result table",
      offenders: (() => {
        const toolFile = files.find((f) => f.path.includes("permission-and-tool.ts"))
        const offenders: Array<string> = []
        if (toolFile === undefined || !/idempotencyKey:\s*\(p\)\s*=>\s*p\.toolUseId/.test(toolFile.text)) {
          offenders.push("permission-and-tool.ts: missing idempotencyKey: (p) => p.toolUseId")
        }
        offenders.push(...offendersFor(files, (f) =>
          /RuntimeToolResultTable/.test(f.text) ||
          /runtimeToolResultAtMostOnce/.test(f.text)))
        return offenders
      })(),
    },
    {
      id: "I7-signal-is-only-wake-authority",
      title: "subscribers never call `engine.resume` / `Workflow.resume` directly",
      offenders: offendersFor(subscribers, (f) =>
        /engine\.resume/.test(f.text) || /Workflow\.resume/.test(f.text)),
    },
    {
      id: "I8-no-per-key-mutex",
      title: "no `makePerKeyMutex` / `per-key-mutex` Shape C subscriber-runtime artifact",
      offenders: offendersFor(files, (f) =>
        /makePerKeyMutex/.test(f.text) ||
        /per-key-mutex/.test(f.text)),
    },
    {
      id: "I9-no-generic-fact-wait-workflow",
      title: "no generic `WaitForFactWorkflow` / `SourceCollections` / `RuntimeObservationSourceNames`",
      offenders: offendersFor(files, (f) =>
        /WaitForFactWorkflow/.test(f.text) ||
        /SourceCollections/.test(f.text) ||
        /RuntimeObservationSourceNames/.test(f.text)),
    },
    {
      id: "I10-no-parallel-runtime-state-tables",
      title: "no parallel `runs` / `outputs` / `toolResults` row families duplicating engine state",
      offenders: offendersFor(files, (f) =>
        /\bruns:\s*RunRow/.test(f.text) ||
        /\boutputs:\s*OutputRow/.test(f.text) ||
        /\btoolResults:\s*ToolResultRow/.test(f.text) ||
        /\bRunRowSchema\b/.test(f.text) ||
        /\bOutputRowSchema\b/.test(f.text) ||
        /\bToolResultRowSchema\b/.test(f.text)),
    },
    {
      id: "I11-no-shape-c-atomic-allocator",
      title: "no `appendInputIntent` / `ensureContext` / `nextInputSequence` host-side allocator",
      offenders: offendersFor(files, (f) =>
        /\bappendInputIntent\b/.test(f.text) ||
        /\bensureContext\b/.test(f.text) ||
        /\bnextInputSequence\b/.test(f.text)),
    },
    {
      id: "I12-no-row-level-lifecycle-status",
      title: "no `permissions.status` / `schedules.status` row-level lifecycle flag",
      offenders: offendersFor(files, (f) =>
        /permissions:\s*Schema\.Struct[\s\S]*?status:/.test(f.text) ||
        /schedules:\s*Schema\.Struct[\s\S]*?status:/.test(f.text) ||
        /PermissionRequestRowSchema[\s\S]{0,400}?status:/.test(f.text) ||
        /ScheduledRowSchema[\s\S]{0,400}?status:/.test(f.text)),
    },
    {
      // SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION: input-delivery
      // channels collapse to `DurableEventChannel<P>` returning
      // `EventOffset` — no bespoke response shapes, no
      // `_tag: "Inserted" | "Duplicate" | "Rejected"` tagged unions,
      // no `inserted: boolean`, no row-id cross-references in append
      // responses.
      id: "I13-input-delivery-channels-are-durable-events",
      title: "every input-delivery channel uses `DurableEventChannel<P>` (no bespoke response shapes)",
      offenders: (() => {
        const channelsFile = files.find((f) => /\/channels\.ts$/.test(f.path))
        if (channelsFile === undefined) return ["channels.ts missing"]
        // Each input-delivery operation must be makeDurableEventChannel.
        const inputDeliveryOps = [
          "sessionSendInput",
          "permissionRespond",
          "webhookIngest",
          "peerEmit",
        ]
        return inputDeliveryOps.flatMap((op) => {
          const re = new RegExp(`${op}:\\s*makeDurableEventChannel`)
          return re.test(channelsFile.text)
            ? []
            : [`channels.ts: ${op} is not a makeDurableEventChannel`]
        })
      })(),
    },
    {
      // SDD: `inserted: boolean` and `_tag: "Inserted"|"Duplicate"|"Rejected"`
      // shapes do not exist in channel response schemas. Wire-level
      // dedup is exposed (if at all) only via `EventOffset.deduplicated`.
      id: "I14-no-application-level-insertion-status",
      title: "no `inserted: boolean` or `_tag: \"Inserted\"|\"Duplicate\"|\"Rejected\"` in channel responses",
      offenders: offendersFor(files, (f) =>
        /\binserted:\s*Schema\.Boolean/.test(f.text) ||
        /Schema\.Literal\(\s*"Inserted",\s*"Duplicate",\s*"Rejected"\s*\)/.test(f.text)),
    },
  ]

  let passed = 0
  let failed = 0
  for (const check of checks) {
    if (check.offenders.length === 0) passed += 1
    else failed += 1
  }
  return { checks, passed, failed }
}

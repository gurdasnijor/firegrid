import {
  type ChannelRouteDescriptor,
  type ChannelRouteMetadata,
  type ChannelRouteVerb,
} from "@firegrid/protocol/channels/router"
import {
  makeChannelTarget,
  type ChannelDirection,
  type ChannelTarget,
} from "@firegrid/protocol/channels"
import { Schema } from "effect"

type CompletionPlacement =
  | "call-site-flags"
  | "schema-annotations"
  | "channel-route-descriptor"
  | "return-receipt-schema"
  | "channel-route-descriptor-plus-return-receipt"

interface CompletionPlacementFinding {
  readonly placement: CompletionPlacement
  readonly routerInspectableBeforeDispatch: boolean
  readonly edgeCanMapTransportResponse: boolean
  readonly callerCanDivergeFromContract: boolean
  readonly requiresProductionApiChange: boolean
  readonly verdict: "reject" | "supporting-input" | "recommend"
  readonly rationale: string
}

export const completionPlacementFindings: ReadonlyArray<
  CompletionPlacementFinding
> = [
  {
    placement: "call-site-flags",
    routerInspectableBeforeDispatch: false,
    edgeCanMapTransportResponse: false,
    callerCanDivergeFromContract: true,
    requiresProductionApiChange: true,
    verdict: "reject",
    rationale:
      "Completion semantics supplied by the caller are not part of the channel contract and can contradict the operation.",
  },
  {
    placement: "schema-annotations",
    routerInspectableBeforeDispatch: false,
    edgeCanMapTransportResponse: false,
    callerCanDivergeFromContract: false,
    requiresProductionApiChange: true,
    verdict: "supporting-input",
    rationale:
      "Schema annotations are discoverable like DurableTable.primaryKey, but they attach to schema ASTs rather than to target + verb route semantics.",
  },
  {
    placement: "channel-route-descriptor",
    routerInspectableBeforeDispatch: true,
    edgeCanMapTransportResponse: true,
    callerCanDivergeFromContract: false,
    requiresProductionApiChange: true,
    verdict: "supporting-input",
    rationale:
      "Route metadata is the first place router and edge adapters can inspect operation completion without caller-provided flags.",
  },
  {
    placement: "return-receipt-schema",
    routerInspectableBeforeDispatch: false,
    edgeCanMapTransportResponse: true,
    callerCanDivergeFromContract: false,
    requiresProductionApiChange: true,
    verdict: "supporting-input",
    rationale:
      "Receipt schemas carry terminal evidence after invocation, but by themselves do not tell an edge which route result is terminal.",
  },
  {
    placement: "channel-route-descriptor-plus-return-receipt",
    routerInspectableBeforeDispatch: true,
    edgeCanMapTransportResponse: true,
    callerCanDivergeFromContract: false,
    requiresProductionApiChange: true,
    verdict: "recommend",
    rationale:
      "The descriptor declares the operation completion contract; the receipt schema carries the done/rejected evidence the edge maps to transport response fields.",
  },
]

export const recommendedCompletionPlacement =
  "channel-route-descriptor-plus-return-receipt" satisfies CompletionPlacement

const CompletionProbeRequestSchema = Schema.Struct({
  contextId: Schema.String.pipe(Schema.minLength(1)),
  prompt: Schema.String,
}).annotations({
  identifier: "tiny-firegrid.channelCompletion.request",
  title: "Channel completion probe request",
})

export const CompletionProbeReceiptSchema = Schema.Union(
  Schema.TaggedStruct("Done", {
    operationId: Schema.String,
    transportStopReason: Schema.Literal("end_turn", "cancelled"),
  }),
  Schema.TaggedStruct("Rejected", {
    operationId: Schema.String,
    reason: Schema.String,
    transportStopReason: Schema.Literal("refused", "error"),
  }),
).annotations({
  identifier: "tiny-firegrid.channelCompletion.receipt",
  title: "Channel completion probe receipt",
})
type CompletionProbeReceipt = Schema.Schema.Type<
  typeof CompletionProbeReceiptSchema
>

interface ChannelCompletionContract {
  readonly evidence: "operation-receipt"
  readonly terminalTags: {
    readonly done: "Done"
    readonly rejected: "Rejected"
  }
  readonly transportProjection: {
    readonly acp: {
      readonly response: "PromptResponse"
      readonly stopReasonField: "transportStopReason"
    }
    readonly mcpCli: {
      readonly doneMapsTo: "success"
      readonly rejectedMapsTo: "tool-error"
    }
  }
}

export const promptCompletionContract: ChannelCompletionContract = {
  evidence: "operation-receipt",
  terminalTags: {
    done: "Done",
    rejected: "Rejected",
  },
  transportProjection: {
    acp: {
      response: "PromptResponse",
      stopReasonField: "transportStopReason",
    },
    mcpCli: {
      doneMapsTo: "success",
      rejectedMapsTo: "tool-error",
    },
  },
}

const completionAnnotationId = Symbol.for(
  "tiny-firegrid/channel-completion-contracts/completion",
)

export const withCompletionAnnotation = <S extends Schema.Schema.Any>(
  schema: S,
  contract: ChannelCompletionContract,
): S =>
  schema.annotations({
    [completionAnnotationId]: contract,
  }) as S

export const completionAnnotation = (
  schema: Schema.Schema.Any,
): ChannelCompletionContract | undefined => {
  const value = schema.ast.annotations[completionAnnotationId]
  return isCompletionContract(value) ? value : undefined
}

interface CompletionRouteMetadata extends ChannelRouteMetadata {
  readonly completion: ChannelCompletionContract
}

interface CompletionRouteDescriptor extends ChannelRouteDescriptor {
  readonly metadata: CompletionRouteMetadata
  readonly responseSchema: typeof CompletionProbeReceiptSchema
}

const completionProbeTarget: ChannelTarget = makeChannelTarget(
  "probe.prompt.completion",
)

export const completionProbeRouteDescriptor: CompletionRouteDescriptor = {
  target: completionProbeTarget,
  direction: "call",
  verbs: ["call"],
  inputSchema: CompletionProbeRequestSchema,
  responseSchema: CompletionProbeReceiptSchema,
  metadata: {
    target: completionProbeTarget,
    direction: "call",
    verbs: ["call"],
    schema: {
      direction: "call",
      requestSchema: CompletionProbeRequestSchema,
      responseSchema: CompletionProbeReceiptSchema,
    },
    completion: promptCompletionContract,
  },
}

interface CallSiteFlagsCandidate {
  readonly expectedReject?: boolean
}

export const callSiteFlagCanDiverge = (
  flags: CallSiteFlagsCandidate,
  receipt: CompletionProbeReceipt,
): boolean => flags.expectedReject !== (receipt._tag === "Rejected")

const isCompletionContract = (
  value: unknown,
): value is ChannelCompletionContract =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly evidence?: unknown }).evidence === "operation-receipt"

export const routeCompletionContract = (
  descriptor: ChannelRouteDescriptor,
): ChannelCompletionContract | undefined => {
  const metadata = descriptor.metadata as ChannelRouteMetadata & {
    readonly completion?: unknown
  }
  return isCompletionContract(metadata.completion)
    ? metadata.completion
    : undefined
}

interface AcpPromptResponseProjection {
  readonly response: "PromptResponse"
  readonly status: "completed" | "rejected"
  readonly stopReason: string
}

interface MissingCompletionContractProjection {
  readonly response: "MissingCompletionContract"
  readonly target: string
}

export const acpProjectionFromRouteCompletion = (
  descriptor: CompletionRouteDescriptor,
  receipt: unknown,
): AcpPromptResponseProjection | MissingCompletionContractProjection => {
  const completion = routeCompletionContract(descriptor)
  if (completion === undefined) {
    return {
      response: "MissingCompletionContract",
      target: String(descriptor.target),
    }
  }
  const decoded = Schema.decodeUnknownSync(descriptor.responseSchema)(receipt)
  switch (decoded._tag) {
    case completion.terminalTags.done:
      return {
        response: completion.transportProjection.acp.response,
        status: "completed",
        stopReason: decoded.transportStopReason,
      }
    case completion.terminalTags.rejected:
      return {
        response: completion.transportProjection.acp.response,
        status: "rejected",
        stopReason: decoded.transportStopReason,
      }
  }
}

export const routeCanBeInspectedByEdge = (
  descriptor: ChannelRouteDescriptor,
  verb: ChannelRouteVerb,
): boolean =>
  descriptor.verbs.includes(verb) &&
  routeCompletionContract(descriptor) !== undefined

export const completionProbeSummary = {
  recommendation: recommendedCompletionPlacement,
  routeTarget: String(completionProbeTarget),
  direction: "call" satisfies ChannelDirection,
  acpInspectionPath:
    "router.descriptor.metadata.completion + decoded operation receipt",
  rejectedPublicControls: ["isComplete", "awaitMode", "expectedReject"],
} as const

import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  CompletionProbeReceiptSchema,
  callSiteFlagCanDiverge,
  completionAnnotation,
  completionPlacementFindings,
  completionProbeRouteDescriptor,
  completionProbeSummary,
  promptCompletionContract,
  recommendedCompletionPlacement,
  routeCanBeInspectedByEdge,
  routeCompletionContract,
  withCompletionAnnotation,
  acpProjectionFromRouteCompletion,
} from "../../src/simulations/channel-completion-contracts/probe.ts"

describe("channel completion contract probe", () => {
  it("tf-nioy rejects call-site completion flags because callers can diverge from operation evidence", () => {
    const receipt = Schema.decodeUnknownSync(CompletionProbeReceiptSchema)({
      _tag: "Done",
      operationId: "op-1",
      transportStopReason: "end_turn",
    })
    expect(callSiteFlagCanDiverge({ expectedReject: true }, receipt)).toBe(true)
    expect(
      completionPlacementFindings.find(finding =>
        finding.placement === "call-site-flags"),
    ).toMatchObject({
      routerInspectableBeforeDispatch: false,
      callerCanDivergeFromContract: true,
      verdict: "reject",
    })
  })

  it("tf-nioy treats schema annotations as discoverable but not the edge-facing contract surface", () => {
    const annotated = withCompletionAnnotation(
      CompletionProbeReceiptSchema,
      promptCompletionContract,
    )
    expect(completionAnnotation(annotated)).toEqual(promptCompletionContract)
    expect(
      completionPlacementFindings.find(finding =>
        finding.placement === "schema-annotations"),
    ).toMatchObject({
      routerInspectableBeforeDispatch: false,
      verdict: "supporting-input",
    })
  })

  it("tf-nioy recommends route descriptor metadata plus terminal receipt schema for edge inspection", () => {
    expect(recommendedCompletionPlacement).toBe(
      "channel-route-descriptor-plus-return-receipt",
    )
    expect(routeCompletionContract(completionProbeRouteDescriptor)).toEqual(
      promptCompletionContract,
    )
    expect(routeCanBeInspectedByEdge(completionProbeRouteDescriptor, "call"))
      .toBe(true)
    expect(completionProbeSummary.rejectedPublicControls).toEqual([
      "isComplete",
      "awaitMode",
      "expectedReject",
    ])
  })

  it("tf-nioy maps done and rejected receipts to ACP PromptResponse projections through route metadata", () => {
    expect(
      acpProjectionFromRouteCompletion(completionProbeRouteDescriptor, {
        _tag: "Done",
        operationId: "op-2",
        transportStopReason: "end_turn",
      }),
    ).toEqual({
      response: "PromptResponse",
      status: "completed",
      stopReason: "end_turn",
    })
    expect(
      acpProjectionFromRouteCompletion(completionProbeRouteDescriptor, {
        _tag: "Rejected",
        operationId: "op-3",
        reason: "permission denied",
        transportStopReason: "refused",
      }),
    ).toEqual({
      response: "PromptResponse",
      status: "rejected",
      stopReason: "refused",
    })
  })
})

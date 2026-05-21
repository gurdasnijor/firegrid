import { describe, expect, it } from "vitest"
import { validateLiveEvidence } from "../src/simulations/coordination-topology/driver.ts"

const participant = (
  label: string,
  toolUses: ReadonlyArray<{
    readonly name: string
    readonly channels: ReadonlyArray<string>
  }>,
  sawMarker = true,
) => ({
  label,
  sessionId: `session-${label}`,
  contextId: `context-${label}`,
  toolUses,
  toolNames: [...new Set(toolUses.map(toolUse => toolUse.name))].sort(),
  text: "",
  sawMarker,
})

const tool = (
  name: string,
  ...channels: ReadonlyArray<string>
) => ({
  name,
  channels,
})

const greenArms = () => [
  {
    arm: "single" as const,
    mode: "live-frontier" as const,
    participants: [
      participant("single-agent", [
        tool("call", "coordination.worker_action"),
        tool("send", "coordination.artifacts"),
        tool("send", "coordination.scores"),
      ]),
    ],
    toolUseCount: 3,
    markerCount: 1,
  },
  {
    arm: "developer-authored-orchestration" as const,
    mode: "live-frontier" as const,
    participants: [
      participant("investigator", [
        tool("send", "coordination.artifacts"),
      ]),
      participant("builder", [
        tool("wait_for", "coordination.artifacts"),
        tool("send", "coordination.artifacts"),
      ]),
      participant("reviewer", [
        tool("wait_for", "coordination.artifacts"),
        tool("send", "coordination.artifacts"),
        tool("send", "coordination.scores"),
      ]),
    ],
    toolUseCount: 6,
    markerCount: 3,
  },
  {
    arm: "choreography" as const,
    mode: "live-frontier" as const,
    participants: [
      participant("planner-peer", [
        tool("send", "coordination.claims"),
        tool("wait_for_any", "coordination.claims", "coordination.artifacts"),
        tool("send", "coordination.artifacts"),
      ]),
      participant("builder-peer", [
        tool("send", "coordination.claims"),
        tool("wait_for_any", "coordination.claims", "coordination.artifacts"),
        tool("send", "coordination.artifacts"),
      ]),
      participant("reviewer-peer", [
        tool("send", "coordination.claims"),
        tool("wait_for_any", "coordination.claims", "coordination.artifacts"),
        tool("send", "coordination.artifacts"),
      ]),
    ],
    toolUseCount: 9,
    markerCount: 3,
  },
]

describe("coordination topology evidence validation", () => {
  it("agentic-patterns-coordination-topology.OBSERVABILITY.5 accepts the minimum live arm evidence contract", () => {
    expect(validateLiveEvidence(greenArms())).toEqual([])
  })

  it("agentic-patterns-coordination-topology.OBSERVABILITY.5 rejects missing marker and required channel evidence", () => {
    const arms = greenArms()
    arms[0] = {
      ...arms[0],
      participants: [
        participant("single-agent", [
          tool("call", "coordination.worker_action"),
          tool("send", "coordination.artifacts"),
        ], false),
      ],
    }

    expect(validateLiveEvidence(arms)).toEqual([
      "single/single-agent:missing-marker",
      "single/single-agent:missing-send-coordination.scores",
    ])
  })
})

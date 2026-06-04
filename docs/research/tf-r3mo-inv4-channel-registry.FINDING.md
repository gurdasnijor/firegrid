# tf-r3mo / INV-4 Finding: Channel Registry + Opaque ChannelTarget

## Conclusion

PASS for the WAVE-1 channel-addressing question: a host-composed channel registry can expose an agent-facing `wait_for` surface whose target is only an opaque string token, while the host privately resolves that token to substrate addressing.

The accepted live run is:

- run id: `2026-05-20T07-22-00-666Z__inv4-channel-registry`
- trace: `docs/research/tf-r3mo-inv4-channel-registry.trace.jsonl`

## Acceptance Evidence

1. Agent called `wait_for(channel: "factory.events")` and matched.

   Trace line 913 records the ACP `tool_call_update` raw input:

   ```json
   {"channel":"factory.events","timeoutMs":30000}
   ```

   Trace line 1705 records the tool response:

   ```json
   {"matched":true,"channel":"factory.events","event":{"factId":"darkFactory.facts:inv4-channel-registry:factory.run.approved", ...}}
   ```

   Trace line 3376 records the driver verdict:

   ```json
   {
     "firegrid.inv4.verdict.saw_wait_for_call": true,
     "firegrid.inv4.verdict.agent_input_channel_only": true,
     "firegrid.inv4.verdict.saw_result_marker": true
   }
   ```

2. The agent schema/input did not expose `source._tag` or `stream`.

   The prompt wire chunk at trace line 158 only asks for:

   ```json
   {"channel":"factory.events","timeoutMs":30000}
   ```

   The observed raw tool input at trace line 913 contains `channel` and `timeoutMs` only. The hidden host source appears only after the host-side tool response at trace line 1705, where the matched event payload includes `source: "darkFactory.facts"`.

3. Host composition remained substrate-neutral at the agent boundary.

   Trace line 1 shows the host-owned MCP endpoint for tool `wait_for`; trace line 9 shows the host seeding the private backing fact source `darkFactory.facts`; trace line 122 shows the ACP session receives one direct MCP declaration named `channel-registry`.

   The agent never receives the backing source token in its request surface. The host retains the substrate mapping:

   ```text
   factory.events -> CallerFact stream darkFactory.facts
   ```

## Implementation Note

The final sim keeps INV-4 self-contained and host-composed under `packages/firelab/src/simulations/inv4-channel-registry/`. The minimal MCP server is scoped in the host layer and advertises only the channel-level schema. During iteration, composing an additional simulation-local `Workflow.make`/`DurableToolsWaitForLive` sidecar in the same host layer blocked normal runtime-host acquisition; this is a capability gap for future deeper validation, not a blocker for the channel-registry API shape. The accepted probe validates the API boundary and substrate-neutrality claim empirically with a live `claude-agent-acp` planner.

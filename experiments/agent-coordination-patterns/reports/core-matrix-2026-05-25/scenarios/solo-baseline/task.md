# Agent Coordination Patterns Task Packet

This packet is self-contained. Do not inspect the repository, shell, or filesystem.
Use only the Firegrid session and coordination-channel tools exposed to you.

Scenario: Solo Baseline

Provided materials:

Experiment goal:
Firegrid should act as the workbench for comparing three coordination patterns: one participant, a central orchestrator, and peer choreography.

Current harness shape:
- The driver composes a real Firegrid host in-process.
- Participants are launched through the public Firegrid client/session surface.
- The shared board is exposed as channels: coordination.work, coordination.claims, coordination.findings, coordination.questions, coordination.reviews, and coordination.final.
- The driver injects inbound events through Firegrid.channels.send and waits for the final artifact through Firegrid.channels.waitFor.
- A run is incomplete unless a coordination.final row is published.

Known measurement risks:
- If the task packet asks for repository or shell access, agents may burn time on unavailable tools instead of exercising Firegrid coordination.
- If final artifacts are optional prose instead of channel rows, the scorer cannot reliably compare arms.
- Choreography should be judged by durable board behavior, not by hidden driver state.

Task:
- Identify one small documentation or workflow improvement using only the provided materials.
- Return the exact change you would make and why it is enough.

Output contract:
- Produce one concise final artifact with body under 1,200 characters.
- State which evidence you inspected.
- State the implementation or design recommendation.
- State open questions.
- Do not claim coordination helped unless the artifacts show why.

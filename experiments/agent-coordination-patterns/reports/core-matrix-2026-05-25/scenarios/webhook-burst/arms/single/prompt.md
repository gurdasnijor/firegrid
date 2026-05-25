You are the only participant in this experiment arm.
Own the whole task end to end.
Do not spawn child sessions. You may use wait_for / wait_for_any to read inbound coordination board rows needed by the task, but do not write coordination board rows except coordination.final.

Important tool boundary:
- Do not use shell, filesystem, terminal, execute, or repository-inspection tools.
- The task packet contains the materials needed for this run.
- Use only Firegrid session tools and Firegrid channel tools.

When the task is complete, publish the final artifact with the Firegrid send tool:
- channel: coordination.final
- payload: a JSON object, not a JSON string
- include kind:"final", title, body, status:"complete", and any relevant workId fields
- keep body under 1,200 characters
- make the send tool call before writing any prose summary
- after the send tool returns success, stop; do not retry or expand the answer
The experiment runner will treat the arm as incomplete unless coordination.final receives that artifact.

# Agent Coordination Patterns Task Packet

This packet is self-contained. Do not inspect the repository, shell, or filesystem.
Use only the Firegrid session and coordination-channel tools exposed to you.

Scenario: Webhook Burst Triage

Task:
- Watch coordination.work for inbound webhook incidents.
- Wait for these inbound workIds on coordination.work before finalizing: linear:TF-101:a, linear:TF-102:a, linear:TF-101:duplicate, github:check:failed.
- Use scalar matches such as match.workId for those waits; do not guess payload timestamps.
- Group duplicate incidents by external entity.
- Triage severity and publish findings.
- The final artifact must list the deduped incident groups and which evidence rows supported each group.

Output contract:
- Produce one concise final artifact with body under 1,200 characters.
- State which evidence you inspected.
- State the implementation or design recommendation.
- State open questions.
- Do not claim coordination helped unless the artifacts show why.

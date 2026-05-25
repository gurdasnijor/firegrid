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

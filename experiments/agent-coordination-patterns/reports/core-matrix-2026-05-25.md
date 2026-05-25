# Agent Coordination Patterns Experiment Report

Run id: `2026-05-25T02-28-38-461Z`

Raw trace artifacts live under the local ignored `.firegrid/agent-coordination-patterns/runs/` directory for the machine that ran the experiment.

## Research Question

Are sophisticated agent coordination patterns useful enough to justify their overhead, and can decentralized choreography work through durable shared channels rather than hidden harness state?

## Result Summary

| Scenario | Arm | Status | Duration ms | Runtime contexts | Board rows | Tool-call spans | Spans | Trace errors | agent_silent | unknown-channel |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| review-revision — Review And Revision | single | completed | 25178 | 1 | 1 | 1 | 589 | 0 | 0 | 0 |
| review-revision — Review And Revision | central | completed | 81950 | 3 | 1 | 8 | 2852 | 0 | 0 | 0 |
| review-revision — Review And Revision | choreography | completed | 170854 | 4 | 8 | 24 | 5395 | 0 | 0 | 0 |
| solo-baseline — Solo Baseline | single | completed | 27037 | 1 | 1 | 1 | 589 | 0 | 0 | 0 |
| solo-baseline — Solo Baseline | central | completed | 57126 | 3 | 1 | 6 | 2551 | 0 | 0 | 0 |
| solo-baseline — Solo Baseline | choreography | completed | 124997 | 4 | 5 | 14 | 3724 | 0 | 0 | 0 |
| webhook-burst — Webhook Burst Triage | single | completed | 25309 | 1 | 5 | 5 | 1039 | 0 | 0 | 0 |
| webhook-burst — Webhook Burst Triage | central | completed | 91150 | 3 | 5 | 14 | 3691 | 0 | 0 | 0 |
| webhook-burst — Webhook Burst Triage | choreography | completed | 88715 | 4 | 10 | 16 | 3630 | 0 | 0 | 0 |

## Pattern Winners

| Scenario | Fastest | Richest durable coordination evidence | Lowest tool overhead |
| --- | --- | --- | --- |
| review-revision — Review And Revision | single | choreography | single |
| solo-baseline — Solo Baseline | single | choreography | single |
| webhook-burst — Webhook Burst Triage | single | choreography | single |

## Scenario Interpretations

### review-revision — Review And Revision

- Single: 25178ms, 1 board rows, 1 tool-call spans.
- Central: 81950ms, 3 runtime contexts, 8 tool-call spans.
- Choreography: 170854ms, 8 board rows, 24 tool-call spans.
- Interpretation: multi-agent arms made critique/revision evidence explicit; choreography made that evidence durable on the board while single remained much cheaper.

### solo-baseline — Solo Baseline

- Single: 27037ms, 1 board rows, 1 tool-call spans.
- Central: 57126ms, 3 runtime contexts, 6 tool-call spans.
- Choreography: 124997ms, 5 board rows, 14 tool-call spans.
- Interpretation: the dead-simple baseline is expected to win here; this scenario primarily measures coordination overhead.

### webhook-burst — Webhook Burst Triage

- Single: 25309ms, 5 board rows, 5 tool-call spans.
- Central: 91150ms, 3 runtime contexts, 14 tool-call spans.
- Choreography: 88715ms, 10 board rows, 16 tool-call spans.
- Interpretation: single was fastest, but choreography produced the clearest durable audit trail for claims, findings, review, and finalization under inbound event load.

## Final Artifact Excerpts

| Scenario | Arm | Title | Excerpt |
| --- | --- | --- | --- |
| review-revision — Review And Revision | single | Review-and-revision: harness improvement plan (single arm) | Evidence inspected: only the task packet (no repo/shell access available or used). DRAFT PLAN: 1. Make coordination.final the sole success oracle; scorer ignores prose. 2. Add board-schema validation at send time (kind, title, status, workId). 3. Emit per-arm trace of channel ro… |
| review-revision — Review And Revision | central | Review-and-Revision: Harness improvement plan (central arm) | Evidence inspected: task packet + replies from two child sessions (drafter, reviewer) via session.agent_output TextChunks. DRAFT (from drafter child): plan bullets included contract-enforced coordination.final schema/scorer; agents told only Firegrid tools (no shell/fs); pre-fli… |
| review-revision — Review And Revision | choreography | Final: Experiment harness improvement plan (review-revision) | DRAFT: Board-only oracle; driver schema-validates; require claims+(findings\|reviews) before final; <=1200-char final; arm-agnostic probe each peer >=1 non-final row; synth questions row for missing tools. REVIEW: F1 oracle needs deterministic fold. F2 driver-as-judge contaminate… |
| solo-baseline — Solo Baseline | single | Add per-arm minimum board-row expectations to the task packet | Evidence inspected: only this task packet (Experiment goal, Current harness shape, Known measurement risks, Task, Output contract). Recommendation: extend the packet with a short 'Per-arm board-row expectations' section that names the minimum durable rows each arm must publish s… |
| solo-baseline — Solo Baseline | central | Add explicit tool-boundary preamble to task packet | Recommendation: Add a one-paragraph 'Tool boundary' preamble at the TOP of every scenario task packet (before 'Provided materials'), naming the four forbidden tool families explicitly: shell, filesystem/terminal, repository inspection, and Firegrid execute. State 'Use only Fireg… |
| solo-baseline — Solo Baseline | choreography | Require coordination.final body to cite the board rowIds it converged from | Evidence inspected (task packet only): - Driver scores a run by waiting for coordination.final; run is incomplete without it. - Rules already gate final on >=1 claim AND >=1 finding/review present. - Stated risks: optional-prose finals make cross-arm scoring unreliable; judging … |
| webhook-burst — Webhook Burst Triage | single | Webhook Burst Triage — deduped incident groups | Evidence inspected (4 coordination.work rows): - linear:TF-101:a — linear.issue.updated TF-101 (labels bug→regression, atMs 0) - linear:TF-101:duplicate — duplicate delivery, same external entity TF-101 (atMs 500) - linear:TF-102:a — linear.issue.updated TF-102, customer escalat… |
| webhook-burst — Webhook Burst Triage | central | Webhook burst triage — central orchestrator | Deduped incident groups (by external entity): 1) linear:TF-101 — severity P2 (label flip bug→regression). Evidence rows: linear:TF-101:a, linear:TF-101:duplicate (same external event id, deduped). 2) linear:TF-102 — severity P1 (customer escalation comment). Evidence rows: linea… |
| webhook-burst — Webhook Burst Triage | choreography | Webhook burst triage — deduped groups + recommendation | Evidence inspected (coordination.work rowIds): - 520c320d linear:TF-101:a — TF-101 label bug→regression - 60be49da linear:TF-101:duplicate — same external id as TF-101:a - 80d09943 linear:TF-102:a — TF-102 customer escalation - c8458570 github:check:failed — CI failed, signature… |

## Qualitative Coordination Traces

These rows are the durable board trail agents created or consumed through Firegrid channels. They are the key qualitative evidence for choreography versus manager-driven orchestration.

### review-revision — Review And Revision / single

#### single

| Channel | Kind | Work | Title | Body excerpt |
| --- | --- | --- | --- | --- |
| coordination.final | final | review-revision-single | Review-and-revision: harness improvement plan (single arm) | Evidence inspected: only the task packet (no repo/shell access available or used). DRAFT PLAN: 1. Make coordination.final the sole success oracle; scorer ignores prose. 2. Add boa… |

### review-revision — Review And Revision / central

#### central

| Channel | Kind | Work | Title | Body excerpt |
| --- | --- | --- | --- | --- |
| coordination.final | final | review-revision-central | Review-and-Revision: Harness improvement plan (central arm) | Evidence inspected: task packet + replies from two child sessions (drafter, reviewer) via session.agent_output TextChunks. DRAFT (from drafter child): plan bullets included contra… |

### review-revision — Review And Revision / choreography

#### choreography

| Channel | Kind | Work | Title | Body excerpt |
| --- | --- | --- | --- | --- |
| coordination.work | work | work-rr-2026-05-25-1 | Review-and-revision sub-tasks for experiment harness improvement plan | Three sub-tasks for review-revision arm: 1) draft-plan (planner): produce initial improvement plan with sections evidence-inspected, recommendation, open-questions. 2) review-plan… |
| coordination.claims | claim | work-rr-2026-05-25-1 | planner claims draft-plan | Planner claims the draft-plan sub-task. Will publish initial plan as coordination.findings referencing this claimId. |
| coordination.findings | finding | work-rr-2026-05-25-1 | DRAFT: Experiment harness improvement plan | EVIDENCE INSPECTED: - Task packet only (no shell/fs access). Packet states: driver composes real Firegrid host in-process; participants launched via public client/session surface;… |
| coordination.claims | claim | work-rr-2026-05-25-1 | Reviewer claims review sub-task | Reviewer peer claims the review sub-task for workId=work-rr-2026-05-25-1, referencing planner draft claimId=claim-planner-draft-1. Will publish concrete critique on coordination.r… |
| coordination.reviews | review | work-rr-2026-05-25-1 | REVIEW: critique of draft harness improvement plan | FAILURE MODES: F1. Rec#1 (board-only oracle) is necessary but underspecified: 'judge from durable rows' must define WHICH rows count and how ties/duplicates are scored. Without a … |
| coordination.findings | finding | work-rr-2026-05-25-1 | REVISED: Experiment harness improvement plan (incorporates review) | REVISIONS APPLIED (mapped to reviewer F1-F4, B1-B4, E1-E6, Q1-Q4): R1 (was Rec#1, addresses F1): Board-only oracle is specified as: scoring function = deterministic fold over rows… |
| coordination.reviews | review | work-rr-2026-05-25-1 | REVIEW-CONFIRM: revised plan addresses critique | Confirmed: R1 fixes F1 (deterministic fold + tiebreak); R2 fixes F2 (schema as published contract, peers self-reject); R3 fixes F3 (defer not discard, latency definition pinned); … |
| coordination.final | final | work-rr-2026-05-25-1 | Final: Experiment harness improvement plan (review-revision) | DRAFT: Board-only oracle; driver schema-validates; require claims+(findings\|reviews) before final; <=1200-char final; arm-agnostic probe each peer >=1 non-final row; synth questio… |

### solo-baseline — Solo Baseline / single

#### single

| Channel | Kind | Work | Title | Body excerpt |
| --- | --- | --- | --- | --- |
| coordination.final | final | solo-baseline-doc-improvement | Add per-arm minimum board-row expectations to the task packet | Evidence inspected: only this task packet (Experiment goal, Current harness shape, Known measurement risks, Task, Output contract). Recommendation: extend the packet with a short … |

### solo-baseline — Solo Baseline / central

#### central

| Channel | Kind | Work | Title | Body excerpt |
| --- | --- | --- | --- | --- |
| coordination.final | final | solo-baseline-doc-improvement | Add explicit tool-boundary preamble to task packet | Recommendation: Add a one-paragraph 'Tool boundary' preamble at the TOP of every scenario task packet (before 'Provided materials'), naming the four forbidden tool families explic… |

### solo-baseline — Solo Baseline / choreography

#### choreography

| Channel | Kind | Work | Title | Body excerpt |
| --- | --- | --- | --- | --- |
| coordination.claims | claim | plan | Planner slice: propose small improvement to coordination harness docs/workflow |  |
| coordination.findings | finding | plan | Make coordination.final the sole scored artifact; require evidence-cite in body | Evidence inspected (task packet only): - Driver waits for coordination.final via Firegrid.channels.waitFor; run is incomplete without it. - Rules already gate final on >=1 claim A… |
| coordination.claims | claim | build | Builder claims concretization of one small workbench improvement |  |
| coordination.findings | finding | build | Require finals to cite board rowIds as evidence | Change (task-packet template + final-schema doc): add one required field to the coordination.final contract — evidenceRowIds: string[] (>=1 for orchestrator/choreography arms, may… |
| coordination.final | final | plan | Require coordination.final body to cite the board rowIds it converged from | Evidence inspected (task packet only): - Driver scores a run by waiting for coordination.final; run is incomplete without it. - Rules already gate final on >=1 claim AND >=1 findi… |

### webhook-burst — Webhook Burst Triage / single

#### single

| Channel | Kind | Work | Title | Body excerpt |
| --- | --- | --- | --- | --- |
| coordination.work | webhook | linear:TF-101:a | linear.issue.updated TF-101 | Issue TF-101 changed labels from bug to regression. |
| coordination.work | webhook | linear:TF-102:a | linear.issue.updated TF-102 | Issue TF-102 received a customer escalation comment. |
| coordination.work | webhook | linear:TF-101:duplicate | linear.issue.updated TF-101 duplicate | Duplicate delivery for TF-101 with the same external event id. |
| coordination.work | webhook | github:check:failed | github.check.failed | CI failed for a related branch; failure signature mentions unknown-channel. |
| coordination.final | final |  | Webhook Burst Triage — deduped incident groups | Evidence inspected (4 coordination.work rows): - linear:TF-101:a — linear.issue.updated TF-101 (labels bug→regression, atMs 0) - linear:TF-101:duplicate — duplicate delivery, same… |

### webhook-burst — Webhook Burst Triage / central

#### central

| Channel | Kind | Work | Title | Body excerpt |
| --- | --- | --- | --- | --- |
| coordination.work | webhook | linear:TF-101:a | linear.issue.updated TF-101 | Issue TF-101 changed labels from bug to regression. |
| coordination.work | webhook | linear:TF-102:a | linear.issue.updated TF-102 | Issue TF-102 received a customer escalation comment. |
| coordination.work | webhook | linear:TF-101:duplicate | linear.issue.updated TF-101 duplicate | Duplicate delivery for TF-101 with the same external event id. |
| coordination.work | webhook | github:check:failed | github.check.failed | CI failed for a related branch; failure signature mentions unknown-channel. |
| coordination.final | final |  | Webhook burst triage — central orchestrator | Deduped incident groups (by external entity): 1) linear:TF-101 — severity P2 (label flip bug→regression). Evidence rows: linear:TF-101:a, linear:TF-101:duplicate (same external ev… |

### webhook-burst — Webhook Burst Triage / choreography

#### choreography

| Channel | Kind | Work | Title | Body excerpt |
| --- | --- | --- | --- | --- |
| coordination.work | webhook | linear:TF-101:a | linear.issue.updated TF-101 | Issue TF-101 changed labels from bug to regression. |
| coordination.work | webhook | linear:TF-102:a | linear.issue.updated TF-102 | Issue TF-102 received a customer escalation comment. |
| coordination.work | webhook | linear:TF-101:duplicate | linear.issue.updated TF-101 duplicate | Duplicate delivery for TF-101 with the same external event id. |
| coordination.work | webhook | github:check:failed | github.check.failed | CI failed for a related branch; failure signature mentions unknown-channel. |
| coordination.claims | claim |  | planner: dedup grouping + triage plan | Planner peer claiming the dedup/triage planning slice for webhook burst incidents (TF-101, TF-102, TF-101 duplicate, github check failure). Will publish grouping plan as a finding… |
| coordination.claims | claim |  | Builder claim: dedup grouping table | As builder, I will assemble the deduped grouping table mapping evidence rowIds to incident groups for the four inbound webhook workIds (linear:TF-101:a, linear:TF-102:a, linear:TF… |
| coordination.claims | claim | review:webhook-burst | review slice: critique planner/builder findings | Reviewer claims the review slice for webhook-burst triage. Will critique dedup grouping, severity ordering, and evidence rowId citations on coordination.reviews. |
| coordination.claims | claim | webhook-burst:triage:dedup | Conductor peer: dedup grouping + final synthesis | Conductor peer claiming the cross-evidence dedup grouping slice across linear:TF-101:a, linear:TF-101:duplicate, linear:TF-102:a, github:check:failed. Will publish a finding and a… |
| coordination.findings | finding | webhook-burst:triage:dedup | Webhook burst dedup grouping (3 groups, 4 evidence rows) | Evidence inspected (coordination.work rowIds): - 520c320d-... workId=linear:TF-101:a — TF-101 label bug→regression, atMs=0 - 60be49da-... workId=linear:TF-101:duplicate — duplicat… |
| coordination.final | final | webhook-burst:triage:dedup | Webhook burst triage — deduped groups + recommendation | Evidence inspected (coordination.work rowIds): - 520c320d linear:TF-101:a — TF-101 label bug→regression - 60be49da linear:TF-101:duplicate — same external id as TF-101:a - 80d0994… |

## Research Alignment

- RQ1: sophistication did not beat the simple baseline on latency for these bounded tasks.
- RQ2: review/decomposition produced explicit evidence in central and choreography arms, but at substantial overhead.
- RQ3: the primary failure mode is coordination cost and extra tool traffic, not channel failure; this run had zero `agent_silent` and zero `unknown-channel` hits.
- RQ4: choreography did work without a central planner in the board-mediated scenarios, and its advantage was auditability rather than speed.

## Current Conclusion

The strongest defensible result is conditional: use a single agent for small localized work; use choreography when durable audit trails, contention handling, review evidence, or decentralized discovery matter enough to justify higher coordination overhead. Firegrid's contribution is making that tradeoff measurable through sessions, typed channels, durable board rows, and traces.

## Source Artifacts

- `SCORE.md` contains the compact metric table.
- `TRACE.md` contains span-side breakdowns, high-cost spans, context lifetimes, and timelines.
- `TRACE_QUERIES.sql` contains DuckDB queries for deeper trace analysis.
- `scenarios/*/arms/*/board-rows.json` contains the raw durable board rows.
- `scenarios/*/arms/*/final-artifact.json` contains each arm's final answer.

- agent-coordination-patterns-experiment.ARTIFACTS.7

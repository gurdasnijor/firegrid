# subscribers/projections/

SHAPE: B

Read-only projection consumers. `R` channel names typed observation source
tags only. Must not own state, must not declare write authority, must not
import `WorkflowEngine` or `WorkflowInstance`.

Wave 2 lands the first Shape B subscribers here (e.g. UI projection adapters
that observe `RuntimeOutputTable.events` through `RuntimeAgentOutputAfterEvents`).

# Agent Coordination Pattern Scores

| Scenario | Arm | Status | Duration ms | Captured sessions | Outputs | Runtime contexts | Board rows | Spans | Errors | Client closed | Tool Calls | agent_silent | unknown-channel |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| review-revision | central | completed | 81950 | 1 | 75 | 3 | 1 | 2852 | 0 | 0 | 8 | 0 | 0 |
| review-revision | choreography | completed | 170854 | 1 | 72 | 4 | 8 | 5395 | 0 | 3 | 24 | 0 | 0 |
| review-revision | single | completed | 25178 | 1 | 10 | 1 | 1 | 589 | 0 | 0 | 1 | 0 | 0 |
| solo-baseline | central | completed | 57126 | 1 | 55 | 3 | 1 | 2551 | 0 | 0 | 6 | 0 | 0 |
| solo-baseline | choreography | completed | 124997 | 1 | 45 | 4 | 5 | 3724 | 0 | 3 | 14 | 0 | 0 |
| solo-baseline | single | completed | 27037 | 1 | 10 | 1 | 1 | 589 | 0 | 0 | 1 | 0 | 0 |
| webhook-burst | central | completed | 91150 | 1 | 111 | 3 | 5 | 3691 | 0 | 0 | 14 | 0 | 0 |
| webhook-burst | choreography | completed | 88715 | 1 | 74 | 4 | 10 | 3630 | 0 | 0 | 16 | 0 | 0 |
| webhook-burst | single | completed | 25309 | 1 | 35 | 1 | 5 | 1039 | 0 | 0 | 5 | 0 | 0 |

## Board Rows By Channel

| Scenario | Arm | Channels |
| --- | --- | --- |
| review-revision | central | coordination.final:1 |
| review-revision | choreography | coordination.work:1, coordination.claims:2, coordination.findings:2, coordination.reviews:2, coordination.final:1 |
| review-revision | single | coordination.final:1 |
| solo-baseline | central | coordination.final:1 |
| solo-baseline | choreography | coordination.claims:2, coordination.findings:2, coordination.final:1 |
| solo-baseline | single | coordination.final:1 |
| webhook-burst | central | coordination.work:4, coordination.final:1 |
| webhook-burst | choreography | coordination.work:4, coordination.claims:4, coordination.findings:1, coordination.final:1 |
| webhook-burst | single | coordination.work:4, coordination.final:1 |

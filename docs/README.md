# Firegrid Docs

This directory separates canonical design documents from review and execution
artifacts.

## Canonical Design Docs

These documents describe intended durable-substrate behavior and are the main
human-readable design source behind the Acai specs in
`features/firegrid/` and the runtime-validation specs in
`features/durable-agent-runtime-lab/`.

| Area | SDD | Feature Spec |
| --- | --- | --- |
| Core durable substrate, phases 1-8 | `docs/SDD_DURABLE_AGENT_SUBSTRATE.md` | `features/firegrid/{durable-records-and-projections,awakeables-and-runs,effect-native-api,semantic-producer,ready-work-projection,claim-and-operator-authority,durable-waits-and-scheduling,implementation-sequencing}.feature.yaml` |
| Client event planes and state producers, phase 11 | `docs/SDD_CLIENT_EVENT_PLANES_AND_STATE_PRODUCERS.md` | `features/firegrid/client-event-plane-registration.feature.yaml` |
| Choreography facade, phase 12 | `docs/SDD_CHOREOGRAPHY_FACADE.md` | `features/firegrid/choreography-facade.feature.yaml` |
| Launchable client, host, Host Program Graph, and lab, phase 13+ | `docs/SDD_LAUNCHABLE_SUBSTRATE_HOST_AND_LAB.md` | `features/firegrid/launchable-substrate-host.feature.yaml` |
| Firegrid architecture and operation messaging boundary, draft | `docs/SDD_FIREGRID_ARCHITECTURE_AND_INVOCATION_BOUNDARY.md` | `features/firegrid/*.feature.yaml` |
| Runtime integration lab and adapter validation | `docs/SDD_DURABLE_AGENT_RUNTIME_LAB.md` | `features/durable-agent-runtime-lab/*.feature.yaml` |

## Planning Docs

`docs/SDD_NEXT_LAYER_REVIEW_SEQUENCE.md` is a historical planning document for
the next-layer SDD review order. Treat it as execution planning, not as a newer
canonical replacement for the SDDs above.

## Review Artifacts

Review packets and architecture audits should be treated as execution artifacts.
They can inform SDD/spec changes, but they are not canonical until the relevant
decision is folded into an SDD and Acai feature file.

Current local review artifact:

- `docs/REVIEW_DURABLE_AGENT_SUBSTRATE_PHASES_1_13.md`

## How To Read The Current State

1. Start with the relevant SDD in the canonical table.
2. Check the matching Acai feature file for stable ACIDs.
3. Search package code and tests for full ACID references.
4. Treat unreferenced review notes as pending review input, not accepted design.

The launchable-host work is currently moving from host boot/subscriber
composition toward the Host Program Graph contract. That slice should happen
before a broad lab UI because the lab needs to exercise the same runtime path
that a Firepixel-like consuming runtime would use.

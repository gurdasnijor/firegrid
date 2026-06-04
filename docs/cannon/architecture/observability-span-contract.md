# Observability Span Contract

This is the private-beta baseline for Firegrid span names and stable
attributes. It classifies the span surface currently emitted by package source
and gives tests, docs, dashboards, and beta users a narrow set of names they can
rely on.

Evidence base for this inventory:

```bash
rg "Effect.withSpan\(" packages/
rg "Stream.withSpan|Layer.withSpan|withSpanNameGenerator|tracer\.spanForRequest\(" packages/
rg "firegrid\." packages/
rg "durableTools|durable-tools|durable_tools" packages docs .
```

The registry is doc-only for this gate. New emitted spans default to INTERNAL
until this document promotes them.

## Stability Classes

| Class | Contract |
| --- | --- |
| STABLE | Beta users, docs, dashboards, and non-internal tests may assert this exact name or key. Renames are breaking changes and need an alias or deprecation period. |
| INTERNAL | Maintainer diagnostic surface. These names may change between minor versions and must not be used by external assertions. |
| DEPRECATED | Historical or transition surface. Do not add new assertions or new emitters for these names. |

## Stable Span Names

| Span name | Owner | Rationale |
| --- | --- | --- |
| `firegrid.agent_event_pipeline.acp.prompt` | `@firegrid/runtime` | ACP prompt ingress is a beta-visible agent lifecycle boundary. |
| `firegrid.agent_event_pipeline.acp.permission_request` | `@firegrid/runtime` | Permission request emission is part of the agent permission workflow trace. |
| `firegrid.agent_event_pipeline.acp.permission_response` | `@firegrid/runtime` | Permission response emission is part of the agent permission workflow trace. |
| `firegrid.channel.session_permission.call` | `@firegrid/runtime` | Session permission callable-channel invocation is the session-scoped permission boundary. |
| `firegrid.client.session.create_or_load` | `@firegrid/client-sdk` | Public session lifecycle client operation. |
| `firegrid.client.session.prompt` | `@firegrid/client-sdk` | Public session prompt client operation. |
| `firegrid.client.session.start` | `@firegrid/client-sdk` | Public session start client operation. |
| `firegrid.client.session.when_ready` | `@firegrid/client-sdk` | Public readiness wait client operation. |
| `firegrid.client.session.wait.for_agent_output` | `@firegrid/client-sdk` | Public projection wait client operation. |
| `firegrid.client.session.wait.for_permission_request` | `@firegrid/client-sdk` | Public permission wait client operation. |
| `firegrid.client.channel.session_agent_output` | `@firegrid/client-sdk` | Client projection channel wait used by session output waits. |
| `firegrid.client.channel.wait_for` | `@firegrid/client-sdk` | Client channel wait primitive used by public wait helpers. |
| `firegrid.durable_table.layer.acquire` | `effect-durable-operators` | Durable table binding acquisition is a stable substrate lifecycle marker. |
| `firegrid.durable_table.rows` | `effect-durable-operators` | Perf docs and traces use this to distinguish durable row stream waits. Its duration is wall-clock subscription wait time, not active storage or CPU time. |
| `firegrid.runtime_context.workflow.native.run` | `@firegrid/runtime` | Native runtime-context workflow body boundary used by workflow simulations. |
| `firegrid.runtime_context.workflow.permission_response.send` | `@firegrid/runtime` | Stable permission response path inside runtime-context workflow execution. |
| `firegrid.runtime_context.workflow.tool_use.activity` | `@firegrid/runtime` | Stable tool-use activity boundary inside runtime-context workflow execution. |
| `firegrid.runtime_control_plane.run.upsert_event` | `@firegrid/runtime` | Stable runtime run event write used by control-plane and simulation evidence. |
| `firegrid.workflow_engine.activity.execute` | `@firegrid/runtime` | Workflow activity execution boundary. |
| `firegrid.workflow_engine.clock.schedule` | `@firegrid/runtime` | Workflow timer scheduling boundary. |
| `firegrid.workflow_engine.deferred.done` | `@firegrid/runtime` | Workflow deferred completion boundary. |
| `firegrid.workflow_engine.execution.execute` | `@firegrid/runtime` | Workflow execution boundary. |
| `firegrid.simulation.run` | `@firegrid/firelab` | Stable envelope for Firegrid-maintained simulation artifacts. This is stable for Firegrid validation tooling, not a product API for beta applications. |

## Internal Span Families

Every currently observed emitted span name not listed as STABLE or DEPRECATED is
classified by one of these INTERNAL rows. Family rows classify the exact names
matched by the prefix or generated pattern.

| Internal family or exact name | Owner | Notes |
| --- | --- | --- |
| `firegrid.agent_event_pipeline.acp.*` except stable names above | `@firegrid/runtime` | ACP driver lifecycle details such as initialize, cancel, output queue, session update, tool result, terminate, and exit. |
| `firegrid.agent_event_pipeline.codec.*` | `@firegrid/host-sdk` | Host codec adapter projection. |
| `firegrid.agent_event_pipeline.source.local_process.*` | `@firegrid/runtime` | Sandbox/local process byte stream and process lifecycle details. |
| `firegrid.agent_event_pipeline.stdio_jsonl.*` except stable names above | `@firegrid/runtime` | Stdio JSONL codec send/decode/output implementation details. |
| `firegrid.agent_event_pipeline.subscriber.runtime_output` | `@firegrid/runtime` | Runtime-output subscriber driver detail. |
| `firegrid.agent_tools.wait_for.workflow.*` | `@firegrid/runtime` | Agent wait-for workflow implementation detail. |
| `firegrid.client.*` except stable names above | `@firegrid/client-sdk` | Client SDK helper internals and append primitives. |
| `firegrid.codec.*` | `@firegrid/runtime` | Codec SDK call internals. |
| `firegrid.durable_streams.*` | `effect-durable-streams` | HTTP transport and durable-stream plumbing. |
| `firegrid.durable_table.*` except stable names above | `effect-durable-operators` | Durable table query, get, producer append, action, await-tx, and subscribe details. |
| `firegrid.host.*` except deprecated names below | `@firegrid/host-sdk` | Host control request, runtime context, agent tool, codec, and channel implementation details. |
| `firegrid.mcp.*` | `@firegrid/host-sdk` | MCP projection and generated HTTP route spans, including `firegrid.mcp.http METHOD` and `firegrid.mcp.http METHOD /runtime-context/:contextId`. |
| `firegrid.runtime_context.*` except stable names above | `@firegrid/runtime` | Runtime-context workflow internals, event/input/output handling, session send/start, and state transitions. |
| `firegrid.runtime_control_plane.*` except stable names above | `@firegrid/runtime` | Control-plane row reads, writes, lifecycle queries, and run allocation details. |
| `firegrid.runtime_observation_streams.*` | `@firegrid/runtime` | Runtime observation stream read models. |
| `firegrid.runtime_output.*` | `@firegrid/runtime` | Runtime output journal and per-context read models. |
| `firegrid.workflow_engine.*` except stable names above | `@firegrid/runtime` | Workflow engine polling, resume, interrupt, clock fire, activity claim, and workflow registration details. |
| `firegrid.acp_sdk_example_agent.*` | `@firegrid/firelab` | Simulation driver details. |
| `firegrid.codec_stdio_jsonl_live.*` | `@firegrid/firelab` | Simulation probe details. |
| `firegrid.inv1.*`, `firegrid.inv4.*`, `firegrid.phase0.*`, `firegrid.phase1.*`, `firegrid.sim.*`, `firegrid.simulation.sim1.*`, `firegrid.sim3.*`, `firegrid.tf_i724.*`, `firegrid.wait_pre_attach.*`, `firegrid.wave2b.*`, `firegrid.workflow_core_paths.*` | `@firegrid/firelab` | Simulation-local spans. They are allowed only for simulation-specific assertions. |
| `firegrid.host.control_request.start.dispatch`, `firegrid.host.control_request.lifecycle.dispatch` | `@firegrid/runtime` | Generated dispatch spans from the control-request reconciler. |
| `firegrid.mcp.http METHOD`, `firegrid.mcp.http METHOD /runtime-context/:contextId` | `@firegrid/host-sdk` | Generated HTTP middleware names; method is part of the generated value. |

## Deprecated Span Names

| Deprecated name or family | Current status |
| --- | --- |
| `firegrid.host.runtime_substrate.*` | Transition surface from the host runtime-substrate knot. Do not add new assertions; runtime carveout work is moving these below the binding line. |
| `firegrid.durable_tools.wait_for.match` | Historical Phase 1 gate name. Current production source does not emit this as a span, but the simulation gate still recognizes it as legacy trace evidence. |
| `firegrid.durable_tools.wait_router.complete_match` | Historical Phase 1 gate name. Current production source does not emit this as a span, but the simulation gate still recognizes it as legacy trace evidence. |
| `firegrid.runtime_context.workflow.output.wait` | Historical Phase 1 gate name retained only by the gate detector. |
| `inv5.*` | Simulation-local prefix that predates the `firegrid.*` convention. Future simulation spans should use `firegrid.sim.*` or a documented `firegrid.<simulation-id>.*` prefix. |

## Prefix Ownership

| Prefix | Owner | Policy |
| --- | --- | --- |
| `firegrid.runtime.*` | `@firegrid/runtime` | Runtime-owned product spans. New spans should prefer this prefix for runtime service boundaries unless a more specific owned prefix below applies. |
| `firegrid.runtime_context.*` | `@firegrid/runtime` | Runtime-context workflow spans. Stable names are exact-name opt-ins only. |
| `firegrid.runtime_control_plane.*` | `@firegrid/runtime` | Runtime control-plane spans. Stable names are exact-name opt-ins only. |
| `firegrid.runtime_output.*` | `@firegrid/runtime` | Runtime output journal and read-model spans. Internal by default. |
| `firegrid.runtime_observation_streams.*` | `@firegrid/runtime` | Runtime observation stream spans. Internal by default. |
| `firegrid.workflow_engine.*` | `@firegrid/runtime` | Workflow engine spans. Stable names are exact-name opt-ins only. |
| `firegrid.agent_event_pipeline.*` | `@firegrid/runtime` | Agent event pipeline spans. Host codec slices may emit under this prefix during transition; ownership remains the runtime pipeline surface. |
| `firegrid.agent_tools.*` | `@firegrid/runtime` | Runtime-owned agent tool execution spans. Internal by default. |
| `firegrid.host.*` | `@firegrid/host-sdk` | Host binding, codec, MCP, and projection composition spans. Internal by default. |
| `firegrid.mcp.*` | `@firegrid/host-sdk` | Host MCP projection spans. Internal by default. |
| `firegrid.session.*` | `@firegrid/client-sdk` | Preferred future prefix for public session operations. Existing public client session spans currently use `firegrid.client.session.*`. |
| `firegrid.client.*` | `@firegrid/client-sdk` | Client SDK spans. Stable names are exact-name opt-ins only. |
| `firegrid.channel.*` | Contract owner by channel; live binding owner emits | Channel call/wait spans. Session permission call is stable; other channel spans are internal unless promoted. |
| `firegrid.durable_table.*` | `effect-durable-operators` | Durable table substrate spans. Stable names are exact-name opt-ins only. |
| `firegrid.durable_streams.*` | `effect-durable-streams` | Durable stream transport spans. Internal by default. |
| `firegrid.simulation.*`, `firegrid.sim.*`, and named simulation prefixes | `@firegrid/firelab` | Simulation validation surface. Stable only where explicitly listed. |

## Stable Attribute Keys

Stable keys have stable spelling and semantic type. A stable key is not
guaranteed to appear on every stable span.

| Attribute key | Meaning |
| --- | --- |
| `firegrid.context.id` | Runtime context or session-context identifier. |
| `firegrid.session.id` | Session identifier exposed through session/client flows. |
| `firegrid.host.id` | Host identity where present. |
| `firegrid.run.id` | Runtime or simulation run identifier. |
| `firegrid.namespace` | Durable namespace or Firegrid namespace. |
| `firegrid.runtime.agent` | Requested runtime agent name. |
| `firegrid.runtime.agent_protocol` | Requested runtime agent protocol. |
| `firegrid.runtime.activity_attempt` | Runtime workflow activity attempt number. |
| `firegrid.runtime.output.sequence` | Runtime output sequence number. |
| `firegrid.runtime.output.after_sequence` | Runtime output lower-bound sequence for waits. |
| `firegrid.runtime_context_mcp.enabled` | Whether runtime-context MCP was enabled for a launch/session. |
| `firegrid.input.id` | Runtime input identifier. |
| `firegrid.input.kind` | Runtime input kind. |
| `firegrid.input.idempotency_key` | Client/runtime idempotency key for an input. |
| `firegrid.control.request_id` | Control-plane request identifier. |
| `firegrid.control.lifecycle` | Control-plane lifecycle state. |
| `firegrid.channel.target` | Channel target string. |
| `firegrid.channel.direction` | Channel direction. |
| `firegrid.wait.bucket` | Wait/read-model bucket name. |
| `firegrid.workflow.execution_id` | Workflow execution identifier. |
| `firegrid.workflow.activity.name` | Workflow activity name. |
| `firegrid.workflow.activity.claim_owned` | Whether the activity claim is owned by the worker. |
| `firegrid.workflow.worker_id` | Workflow worker identifier. |
| `firegrid.workflow.deferred.name` | Workflow deferred name. |
| `firegrid.agent.kind` | Agent implementation kind. |
| `firegrid.agent_tool.name` | Agent tool name. |
| `firegrid.agent_tool.tool_use_id` | Agent tool-use identifier. |
| `firegrid.agent_input.tag` | Agent input variant tag. |
| `firegrid.agent_output.tag` | Agent output variant tag. |
| `firegrid.agent_output.tool_name` | Agent output tool name. |
| `firegrid.agent_output.tool_result_failure` | Whether a tool result represented a failure. |
| `firegrid.permission.request_id` | Permission request identifier. |
| `firegrid.permission.response.origin` | Origin of a permission response. |
| `firegrid.durable_table.namespace` | Durable table namespace. |
| `firegrid.durable_table.name` | Durable table name. |
| `firegrid.durable_table.collection` | Durable table collection. |
| `firegrid.durable_table.durable_type` | Durable table durable type. |
| `firegrid.durable_table.primary_key` | Durable table primary key. |
| `firegrid.simulation.id` | Tiny-firegrid simulation identifier. |
| `firegrid.durable_streams.base_url` | Durable streams base URL in simulation artifacts. |
| `firegrid.process.role` | Process role in simulation artifacts. |
| `firegrid.git.commit` | Git commit recorded in simulation artifacts. |
| `firegrid.git.branch` | Git branch recorded in simulation artifacts. |
| `firegrid.firelab.version` | Tiny-firegrid version recorded in simulation artifacts. |

All other observed attribute keys are INTERNAL unless a later registry revision
promotes them. In particular, payload-bearing or raw-wire keys such as
`firegrid.wire.raw` are not stable beta assertion keys.

## durableTools Historical Label

The current source grep still finds `durableTools` as a host stream segment in
`packages/protocol/src/launch/authority.ts` and as the stream URL segment used
by `packages/host-sdk/src/host/layers.ts`. This is a historical stream
namespace label, not a current `firegrid.durable_tools.*` production span
emitter.

The Phase 1 gate detector in
`packages/firelab/src/runner/phase1-gate.ts` still recognizes historical
`firegrid.durable_tools.*` span names so old traces remain explainable. New
spans must not use `firegrid.durable_tools.*`; future cleanup can migrate the
host stream segment once compatibility and trace history requirements are
settled.

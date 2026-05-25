# Agent Coordination Trace Report

Generated from Firegrid OTel JSONL span artifacts.

## review-revision / central

Spans: 2852; errors: 0; tool-call spans: 8; permission spans: 3; session.agent_output spans: 25.

### Span Sides

| Side | Spans | Total ms | Avg ms | Share |
| --- | ---: | ---: | ---: | --- |
| host | 2371 | 4256145.2 | 1795.1 | ████████████████████ |
| codec | 110 | 219813 | 1998.3 | █ |
| unknown | 76 | 78696.5 | 1035.5 | █ |
| agent-tools | 163 | 485.6 | 3 | █ |
| sdk | 21 | 74 | 3.5 | █ |
| subprocess | 111 | 15.5 | 0.1 | █ |

### Highest-Cost Span Families

| Span | Count | Total ms | Avg ms | Max ms |
| --- | ---: | ---: | ---: | ---: |
| firegrid.durable_table.rows | 24 | 1032685.4 | 43028.6 | 78847.6 |
| firegrid.agent_event_pipeline.codec.layer | 3 | 213058 | 71019.3 | 78873.9 |
| firegrid.runtime_context.input_facts.for_context | 3 | 213037.5 | 71012.5 | 78838.1 |
| firegrid.runtime_output.per_context.agent_output.for_context | 3 | 213036.4 | 71012.1 | 78837.8 |
| firegrid.host.control_request.start.side_effect | 5 | 212982.1 | 42596.4 | 78822.4 |
| firegrid.host.runtime_context.side_effect.start | 3 | 212973.4 | 70991.1 | 78820 |
| firegrid.runtime_control_plane.run.wait_terminal | 3 | 212969.9 | 70990 | 78819.4 |
| firegrid.rcsw.session-workflow.execute | 3 | 212968.8 | 70989.6 | 78819 |
| firegrid.agent_event_pipeline.codec.outputs | 3 | 209683.7 | 69894.6 | 77777.3 |
| firegrid.agent_event_pipeline.codec.stderr_journal | 3 | 209682 | 69894 | 77776.7 |
| firegrid.agent_event_pipeline.acp.output_queue | 3 | 209657.8 | 69885.9 | 77767.4 |
| firegrid.agent_event_pipeline.acp.exit | 3 | 209657.1 | 69885.7 | 77767.2 |

### Context Lifetimes

| Context | Spans | First ms | Last ms | Lifetime ms | Sides |
| --- | ---: | ---: | ---: | ---: | --- |
| ctx_ext_WyJhZ2V... | 692 | 3.1 | 78918.4 | 78915.3 | agent-tools, codec, host, sdk, subprocess |
| ctx_ctx_ext_WyJ... | 171 | 10111.6 | 78891.9 | 68780.3 | agent-tools, codec, host, subprocess |
| ctx_ctx_ext_WyJ... | 186 | 13407.1 | 78865.1 | 65458 | agent-tools, codec, host, subprocess |

### Representative Event Timeline

| At ms | Side | Context | Span | Duration ms | Status |
| ---: | --- | --- | --- | ---: | --- |
| 3.1 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.create_or_load | 2.5 | ok |
| 3.2 | sdk |  | firegrid.channel.host.sessions.create_or_load.call | 2.4 | ok |
| 5.6 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.prompt | 23.2 | ok |
| 10.5 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 11 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 11 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 12.9 | host |  | firegrid.host.control_request.workflow_engine.layer | 1.8 | ok |
| 13.1 | host |  | firegrid.runtime_context.subscriber.dispatch | 78848.4 | ok |
| 13.3 | host |  | firegrid.runtime_context.subscriber.source | 78848.1 | ok |
| 14.6 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 14.6 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 14.7 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 15.2 | host |  | firegrid.workflow_engine.execution.execute | 15.8 | ok |
| 18.6 | unknown |  | firegrid.mcp.publish_runtime_context_base | 0 | ok |
| 19.7 | host |  | firegrid.workflow_engine.execution.resume | 0.2 | ok |
| 19.7 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 19.9 | host |  | firegrid.workflow_engine.activity.execute | 7.8 | ok |
| 20 | host |  | firegrid.workflow_engine.activity.claim | 0.9 | ok |
| 21.1 | host | ctx_ext_WyJhZ2V... | firegrid.host.control_request.context.workflow | 3.8 | ok |
| 22.8 | host | ctx_ext_WyJhZ2V... | firegrid.runtime_context.input_facts.for_context | 78838.1 | ok |
| 23.5 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.channel.session_prompt.append | 5.3 | ok |
| 28.8 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.start | 1.7 | ok |
| 29.3 | sdk | ctx_ext_WyJhZ2V... | firegrid.channel.host.sessions.start.call | 1.3 | ok |
| 31.4 | host |  | firegrid.workflow_engine.execution.execute | 3.9 | ok |
| 31.8 | host |  | firegrid.workflow_engine.execution.execute | 0.3 | ok |
| 32.8 | host |  | firegrid.workflow_engine.execution.execute | 3.3 | ok |
| 32.8 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 32.9 | host |  | firegrid.workflow_engine.execution.execute | 2.8 | ok |
| 32.9 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 33 | host |  | firegrid.workflow_engine.execution.resume | 0 | ok |
| 33.1 | host | ctx_ext_WyJhZ2V... | firegrid.host.control_request.claim.workflow | 0.1 | ok |
| 34.8 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 37.6 | host | ctx_ext_WyJhZ2V... | firegrid.host.runtime_context.side_effect.start | 78820 | ok |
| 38.3 | host |  | firegrid.rcsw.session-workflow.execute | 78819 | ok |
| 38.7 | host |  | firegrid.workflow_engine.execution.execute | 1127.3 | ok |
| 39.1 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 39.2 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 39.4 | host |  | firegrid.workflow_engine.activity.execute | 1103.9 | ok |
| 39.5 | host |  | firegrid.workflow_engine.activity.claim | 0.6 | ok |
| 40.2 | codec | ctx_ext_WyJhZ2V... | firegrid.host.codec.start_session | 1100.2 | ok |

## review-revision / choreography

Spans: 5395; errors: 0; tool-call spans: 24; permission spans: 7; session.agent_output spans: 1.

### Span Sides

| Side | Spans | Total ms | Avg ms | Share |
| --- | ---: | ---: | ---: | --- |
| host | 4329 | 11147901.3 | 2575.2 | ████████████████████ |
| agent-tools | 466 | 2319289.8 | 4977 | ████ |
| unknown | 134 | 1052895.9 | 7857.4 | ██ |
| codec | 221 | 585991.5 | 2651.5 | █ |
| sdk | 21 | 73.1 | 3.5 | █ |
| subprocess | 224 | 27.1 | 0.1 | █ |

### Highest-Cost Span Families

| Span | Count | Total ms | Avg ms | Max ms |
| --- | ---: | ---: | ---: | ---: |
| firegrid.durable_table.rows | 34 | 2798265.4 | 82301.9 | 167748.4 |
| firegrid.agent_event_pipeline.codec.layer | 4 | 575414.8 | 143853.7 | 167782.7 |
| firegrid.runtime_context.input_facts.for_context | 4 | 575366.7 | 143841.7 | 167735.6 |
| firegrid.runtime_output.per_context.agent_output.for_context | 4 | 575365 | 143841.3 | 167735 |
| firegrid.host.control_request.start.side_effect | 6 | 575297.4 | 95882.9 | 167720.6 |
| firegrid.host.runtime_context.side_effect.start | 4 | 575284.8 | 143821.2 | 167717.8 |
| firegrid.runtime_control_plane.run.wait_terminal | 4 | 575280.7 | 143820.2 | 167717 |
| firegrid.rcsw.session-workflow.execute | 4 | 575279.5 | 143819.9 | 167716.7 |
| firegrid.agent_event_pipeline.codec.outputs | 4 | 570131.7 | 142532.9 | 166396.8 |
| firegrid.agent_event_pipeline.codec.stderr_journal | 4 | 570129.5 | 142532.4 | 166396.3 |
| firegrid.agent_event_pipeline.acp.output_queue | 4 | 570096 | 142524 | 166386.1 |
| firegrid.agent_event_pipeline.acp.exit | 4 | 570095 | 142523.7 | 166385.7 |

### Context Lifetimes

| Context | Spans | First ms | Last ms | Lifetime ms | Sides |
| --- | ---: | ---: | ---: | ---: | --- |
| ctx_ext_WyJhZ2V... | 678 | 3.6 | 167829 | 167825.4 | agent-tools, codec, host, sdk, subprocess |
| ctx_ctx_ext_WyJ... | 644 | 19799.8 | 167809.7 | 148009.9 | agent-tools, codec, host, subprocess |
| ctx_ctx_ext_WyJ... | 235 | 31929.8 | 167790 | 135860.2 | agent-tools, codec, host, subprocess |
| ctx_ctx_ext_WyJ... | 537 | 43920.5 | 167767.3 | 123846.8 | agent-tools, codec, host, subprocess |

### Representative Event Timeline

| At ms | Side | Context | Span | Duration ms | Status |
| ---: | --- | --- | --- | ---: | --- |
| 3.6 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.create_or_load | 3.7 | ok |
| 3.7 | sdk |  | firegrid.channel.host.sessions.create_or_load.call | 3.5 | ok |
| 7.3 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.prompt | 22.6 | ok |
| 11.4 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 12 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 12 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 14 | host |  | firegrid.host.control_request.workflow_engine.layer | 1.9 | ok |
| 14.3 | host |  | firegrid.runtime_context.subscriber.dispatch | 167749.2 | ok |
| 14.5 | host |  | firegrid.runtime_context.subscriber.source | 167748.8 | ok |
| 15.9 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 15.9 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 15.9 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 16.5 | host |  | firegrid.workflow_engine.execution.execute | 18.5 | ok |
| 19.6 | unknown |  | firegrid.mcp.publish_runtime_context_base | 0 | ok |
| 20.7 | host |  | firegrid.workflow_engine.execution.resume | 0.2 | ok |
| 20.8 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 21 | host |  | firegrid.workflow_engine.activity.execute | 12.3 | ok |
| 21.1 | host |  | firegrid.workflow_engine.activity.claim | 4 | ok |
| 25.2 | host | ctx_ext_WyJhZ2V... | firegrid.host.control_request.context.workflow | 4 | ok |
| 27.3 | host | ctx_ext_WyJhZ2V... | firegrid.runtime_context.input_facts.for_context | 167735.6 | ok |
| 28 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.channel.session_prompt.append | 1.9 | ok |
| 30 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.start | 1.8 | ok |
| 30.4 | sdk | ctx_ext_WyJhZ2V... | firegrid.channel.host.sessions.start.call | 1.4 | ok |
| 35.4 | host |  | firegrid.workflow_engine.execution.execute | 2.9 | ok |
| 35.8 | host |  | firegrid.workflow_engine.execution.execute | 0.3 | ok |
| 36.6 | host |  | firegrid.workflow_engine.execution.execute | 2.4 | ok |
| 36.7 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 36.7 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 36.8 | host |  | firegrid.workflow_engine.execution.execute | 1.9 | ok |
| 36.8 | host |  | firegrid.workflow_engine.execution.resume | 0 | ok |
| 37 | host | ctx_ext_WyJhZ2V... | firegrid.host.control_request.claim.workflow | 0.1 | ok |
| 38 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 41 | host | ctx_ext_WyJhZ2V... | firegrid.host.runtime_context.side_effect.start | 167717.8 | ok |
| 41.8 | host |  | firegrid.rcsw.session-workflow.execute | 167716.7 | ok |
| 42.2 | host |  | firegrid.workflow_engine.execution.execute | 1415.9 | ok |
| 42.7 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 42.8 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 43.1 | host |  | firegrid.workflow_engine.activity.execute | 1390.6 | ok |
| 43.2 | host |  | firegrid.workflow_engine.activity.claim | 0.9 | ok |
| 44.2 | codec | ctx_ext_WyJhZ2V... | firegrid.host.codec.start_session | 1387.3 | ok |

## review-revision / single

Spans: 589; errors: 0; tool-call spans: 1; permission spans: 1; session.agent_output spans: 0.

### Span Sides

| Side | Spans | Total ms | Avg ms | Share |
| --- | ---: | ---: | ---: | --- |
| host | 486 | 632742 | 1301.9 | ████████████████████ |
| codec | 14 | 23819.5 | 1701.4 | █ |
| unknown | 35 | 20657.5 | 590.2 | █ |
| sdk | 21 | 77.5 | 3.7 | █ |
| agent-tools | 16 | 52.5 | 3.3 | █ |
| subprocess | 17 | 3.1 | 0.2 | █ |

### Highest-Cost Span Families

| Span | Count | Total ms | Avg ms | Max ms |
| --- | ---: | ---: | ---: | ---: |
| firegrid.durable_table.rows | 11 | 168427.5 | 15311.6 | 21135.6 |
| firegrid.runtime.tool_dispatch.host_install.layer | 1 | 21140.7 | 21140.7 | 21140.7 |
| firegrid.host.runtime_substrate.observation_streams.layer | 1 | 21140 | 21140 | 21140 |
| firegrid.host.runtime_substrate.observation.layer | 1 | 21139.8 | 21139.8 | 21139.8 |
| firegrid.runtime.agent_tool_execution.layer | 1 | 21138.3 | 21138.3 | 21138.3 |
| firegrid.host.agent_tools.tool_use_executor.layer | 1 | 21138.1 | 21138.1 | 21138.1 |
| firegrid.runtime_context.subscriber.dispatch | 1 | 21136.8 | 21136.8 | 21136.8 |
| firegrid.runtime_context.subscriber.source | 1 | 21136.2 | 21136.2 | 21136.2 |
| firegrid.runtime_control_plane.context.rows | 1 | 21135.7 | 21135.7 | 21135.7 |
| firegrid.runtime_context.input_facts.for_context | 1 | 21120.5 | 21120.5 | 21120.5 |
| firegrid.runtime_output.per_context.agent_output.for_context | 1 | 21120.1 | 21120.1 | 21120.1 |
| firegrid.host.control_request.start.side_effect | 3 | 21109.4 | 7036.5 | 21105.9 |

### Context Lifetimes

| Context | Spans | First ms | Last ms | Lifetime ms | Sides |
| --- | ---: | ---: | ---: | ---: | --- |
| ctx_ext_WyJhZ2V... | 152 | 4.2 | 21154 | 21149.8 | agent-tools, codec, host, sdk, subprocess |

### Representative Event Timeline

| At ms | Side | Context | Span | Duration ms | Status |
| ---: | --- | --- | --- | ---: | --- |
| 4.2 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.create_or_load | 3.2 | ok |
| 4.4 | sdk |  | firegrid.channel.host.sessions.create_or_load.call | 2.9 | ok |
| 7.4 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.prompt | 26.3 | ok |
| 11.6 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 12.1 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 12.2 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 14.6 | host |  | firegrid.host.control_request.workflow_engine.layer | 5.6 | ok |
| 14.9 | host |  | firegrid.runtime_context.subscriber.dispatch | 21136.8 | ok |
| 15.3 | host |  | firegrid.runtime_context.subscriber.source | 21136.2 | ok |
| 20.1 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 20.1 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 20.2 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 20.9 | host |  | firegrid.workflow_engine.execution.execute | 18.1 | ok |
| 25.2 | unknown |  | firegrid.mcp.publish_runtime_context_base | 0.1 | ok |
| 26.8 | host |  | firegrid.workflow_engine.execution.resume | 0.2 | ok |
| 26.9 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 27.2 | host |  | firegrid.workflow_engine.activity.execute | 10 | ok |
| 27.3 | host |  | firegrid.workflow_engine.activity.claim | 1.1 | ok |
| 28.5 | host | ctx_ext_WyJhZ2V... | firegrid.host.control_request.context.workflow | 4.4 | ok |
| 30.7 | host | ctx_ext_WyJhZ2V... | firegrid.runtime_context.input_facts.for_context | 21120.5 | ok |
| 31.5 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.channel.session_prompt.append | 2.2 | ok |
| 33.8 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.start | 1.8 | ok |
| 34.2 | sdk | ctx_ext_WyJhZ2V... | firegrid.channel.host.sessions.start.call | 1.3 | ok |
| 39.4 | host |  | firegrid.workflow_engine.execution.execute | 4.4 | ok |
| 39.8 | host |  | firegrid.workflow_engine.execution.execute | 0.5 | ok |
| 41.1 | host |  | firegrid.workflow_engine.execution.execute | 3.6 | ok |
| 41.1 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 41.2 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 41.3 | host |  | firegrid.workflow_engine.execution.execute | 3 | ok |
| 41.3 | host |  | firegrid.workflow_engine.execution.resume | 0 | ok |
| 41.5 | host | ctx_ext_WyJhZ2V... | firegrid.host.control_request.claim.workflow | 0.3 | ok |
| 43.5 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 46.3 | host | ctx_ext_WyJhZ2V... | firegrid.host.runtime_context.side_effect.start | 21103.4 | ok |
| 47.1 | host |  | firegrid.rcsw.session-workflow.execute | 21102.4 | ok |
| 47.4 | host |  | firegrid.workflow_engine.execution.execute | 1388.3 | ok |
| 47.8 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 47.8 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 48.1 | host |  | firegrid.workflow_engine.activity.execute | 1363.4 | ok |
| 48.1 | host |  | firegrid.workflow_engine.activity.claim | 0.6 | ok |
| 48.9 | codec | ctx_ext_WyJhZ2V... | firegrid.host.codec.start_session | 1359.2 | ok |

## solo-baseline / central

Spans: 2551; errors: 0; tool-call spans: 6; permission spans: 3; session.agent_output spans: 14.

### Span Sides

| Side | Spans | Total ms | Avg ms | Share |
| --- | ---: | ---: | ---: | --- |
| host | 2128 | 2755711.7 | 1295 | ████████████████████ |
| codec | 97 | 140674.4 | 1450.3 | █ |
| unknown | 70 | 53820.5 | 768.9 | █ |
| agent-tools | 129 | 473.4 | 3.7 | █ |
| sdk | 21 | 120.8 | 5.8 | █ |
| subprocess | 106 | 14.1 | 0.1 | █ |

### Highest-Cost Span Families

| Span | Count | Total ms | Avg ms | Max ms |
| --- | ---: | ---: | ---: | ---: |
| firegrid.durable_table.rows | 22 | 671238.8 | 30510.9 | 54032.6 |
| firegrid.runtime_context.input_facts.for_context | 3 | 133963.7 | 44654.6 | 54003.3 |
| firegrid.runtime_output.per_context.agent_output.for_context | 3 | 133961.8 | 44653.9 | 54002.8 |
| firegrid.agent_event_pipeline.codec.layer | 3 | 133924.8 | 44641.6 | 54025 |
| firegrid.host.control_request.start.side_effect | 5 | 133867.4 | 26773.5 | 53980.5 |
| firegrid.host.runtime_context.side_effect.start | 3 | 133848.3 | 44616.1 | 53976.4 |
| firegrid.runtime_control_plane.run.wait_terminal | 3 | 133840.5 | 44613.5 | 53975.3 |
| firegrid.rcsw.session-workflow.execute | 3 | 133839.4 | 44613.1 | 53974.9 |
| firegrid.agent_event_pipeline.codec.outputs | 3 | 130550.2 | 43516.7 | 52843.7 |
| firegrid.agent_event_pipeline.codec.stderr_journal | 3 | 130548.2 | 43516.1 | 52843.2 |
| firegrid.agent_event_pipeline.acp.output_queue | 3 | 130520.7 | 43506.9 | 52835.8 |
| firegrid.agent_event_pipeline.acp.exit | 3 | 130519.9 | 43506.6 | 52835.6 |

### Context Lifetimes

| Context | Spans | First ms | Last ms | Lifetime ms | Sides |
| --- | ---: | ---: | ---: | ---: | --- |
| ctx_ext_WyJhZ2V... | 533 | 4.9 | 54098.6 | 54093.6 | agent-tools, codec, host, sdk, subprocess |
| ctx_ctx_ext_WyJ... | 194 | 11763.5 | 54077.9 | 42314.4 | agent-tools, codec, host, subprocess |
| ctx_ctx_ext_WyJ... | 198 | 16371.5 | 54056.5 | 37685 | agent-tools, codec, host, subprocess |

### Representative Event Timeline

| At ms | Side | Context | Span | Duration ms | Status |
| ---: | --- | --- | --- | ---: | --- |
| 4.9 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.create_or_load | 3.2 | ok |
| 5.1 | sdk |  | firegrid.channel.host.sessions.create_or_load.call | 3.1 | ok |
| 8.2 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.prompt | 43.3 | ok |
| 14.4 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 15 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 15.1 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 17.9 | host |  | firegrid.host.control_request.workflow_engine.layer | 4.7 | ok |
| 18.2 | host |  | firegrid.runtime_context.subscriber.dispatch | 54033.6 | ok |
| 18.5 | host |  | firegrid.runtime_context.subscriber.source | 54033.1 | ok |
| 22.3 | host |  | firegrid.workflow_engine.workflow.register | 0.1 | ok |
| 22.4 | host |  | firegrid.workflow_engine.workflow.register | 0.1 | ok |
| 22.5 | host |  | firegrid.workflow_engine.workflow.register | 0.1 | ok |
| 25.4 | host |  | firegrid.workflow_engine.execution.execute | 33.8 | ok |
| 35.2 | unknown |  | firegrid.mcp.publish_runtime_context_base | 0.1 | ok |
| 42 | host |  | firegrid.workflow_engine.execution.resume | 0.3 | ok |
| 42.2 | host |  | firegrid.workflow_engine.execution.resume.body | 0.1 | ok |
| 42.5 | host |  | firegrid.workflow_engine.activity.execute | 13.3 | ok |
| 42.6 | host |  | firegrid.workflow_engine.activity.claim | 1.9 | ok |
| 44.6 | host | ctx_ext_WyJhZ2V... | firegrid.host.control_request.context.workflow | 5.9 | ok |
| 47.8 | host | ctx_ext_WyJhZ2V... | firegrid.runtime_context.input_facts.for_context | 54003.3 | ok |
| 48.8 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.channel.session_prompt.append | 2.7 | ok |
| 51.6 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.start | 3.7 | ok |
| 52.1 | sdk | ctx_ext_WyJhZ2V... | firegrid.channel.host.sessions.start.call | 3.2 | ok |
| 59.8 | host |  | firegrid.workflow_engine.execution.execute | 4.3 | ok |
| 60.3 | host |  | firegrid.workflow_engine.execution.execute | 0.4 | ok |
| 61.5 | host |  | firegrid.workflow_engine.execution.execute | 3.5 | ok |
| 61.5 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 61.6 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 61.7 | host |  | firegrid.workflow_engine.execution.execute | 2.9 | ok |
| 61.7 | host |  | firegrid.workflow_engine.execution.resume | 0 | ok |
| 61.9 | host | ctx_ext_WyJhZ2V... | firegrid.host.control_request.claim.workflow | 0.1 | ok |
| 63.7 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 68.1 | host | ctx_ext_WyJhZ2V... | firegrid.host.runtime_context.side_effect.start | 53976.4 | ok |
| 69.2 | host |  | firegrid.rcsw.session-workflow.execute | 53974.9 | ok |
| 69.8 | host |  | firegrid.workflow_engine.execution.execute | 1210.2 | ok |
| 70.4 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 70.5 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 70.8 | host |  | firegrid.workflow_engine.activity.execute | 1185.9 | ok |
| 70.9 | host |  | firegrid.workflow_engine.activity.claim | 0.9 | ok |
| 71.9 | codec | ctx_ext_WyJhZ2V... | firegrid.host.codec.start_session | 1182.1 | ok |

## solo-baseline / choreography

Spans: 3724; errors: 0; tool-call spans: 14; permission spans: 8; session.agent_output spans: 1.

### Span Sides

| Side | Spans | Total ms | Avg ms | Share |
| --- | ---: | ---: | ---: | --- |
| host | 2989 | 7456272.8 | 2494.6 | ████████████████████ |
| agent-tools | 328 | 1829289.4 | 5577.1 | █████ |
| unknown | 104 | 833121.4 | 8010.8 | ██ |
| codec | 137 | 385251.9 | 2812.1 | █ |
| sdk | 21 | 111.7 | 5.3 | █ |
| subprocess | 145 | 20.6 | 0.1 | █ |

### Highest-Cost Span Families

| Span | Count | Total ms | Avg ms | Max ms |
| --- | ---: | ---: | ---: | ---: |
| firegrid.durable_table.rows | 26 | 1812632.7 | 69716.6 | 121869.2 |
| firegrid.workflow_engine.execution.execute | 81 | 413689.7 | 5107.3 | 66097.9 |
| firegrid.agent_event_pipeline.codec.layer | 4 | 375290.4 | 93822.6 | 121893.7 |
| firegrid.runtime_context.input_facts.for_context | 4 | 375263.4 | 93815.8 | 121841.5 |
| firegrid.runtime_output.per_context.agent_output.for_context | 4 | 375261.3 | 93815.3 | 121841 |
| firegrid.host.control_request.start.side_effect | 6 | 375168.4 | 62528.1 | 121820 |
| firegrid.host.runtime_context.side_effect.start | 4 | 375148 | 93787 | 121816.3 |
| firegrid.runtime_control_plane.run.wait_terminal | 4 | 375135.4 | 93783.8 | 121815.3 |
| firegrid.rcsw.session-workflow.execute | 4 | 375133.8 | 93783.4 | 121814.9 |
| firegrid.agent_event_pipeline.codec.outputs | 4 | 370310.3 | 92577.6 | 120632.6 |
| firegrid.agent_event_pipeline.codec.stderr_journal | 4 | 370308.3 | 92577.1 | 120632.5 |
| firegrid.agent_event_pipeline.acp.output_queue | 4 | 370269.6 | 92567.4 | 120623.3 |

### Context Lifetimes

| Context | Spans | First ms | Last ms | Lifetime ms | Sides |
| --- | ---: | ---: | ---: | ---: | --- |
| ctx_ext_WyJhZ2V... | 454 | 5.5 | 121966.4 | 121961 | agent-tools, codec, host, sdk, subprocess |
| ctx_ctx_ext_WyJ... | 386 | 25057.1 | 121941.2 | 96884.1 | agent-tools, codec, host, subprocess |
| ctx_ctx_ext_WyJ... | 330 | 37492 | 121919.7 | 84427.7 | agent-tools, codec, host, subprocess |
| ctx_ctx_ext_WyJ... | 133 | 49687 | 121897.6 | 72210.6 | agent-tools, codec, host, subprocess |

### Representative Event Timeline

| At ms | Side | Context | Span | Duration ms | Status |
| ---: | --- | --- | --- | ---: | --- |
| 5.5 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.create_or_load | 3.6 | ok |
| 5.7 | sdk |  | firegrid.channel.host.sessions.create_or_load.call | 3.3 | ok |
| 9.2 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.prompt | 42 | ok |
| 14.9 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 15.5 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 15.6 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 18.2 | host |  | firegrid.host.control_request.workflow_engine.layer | 3.7 | ok |
| 18.5 | host |  | firegrid.runtime_context.subscriber.dispatch | 121871.3 | ok |
| 19.7 | host |  | firegrid.runtime_context.subscriber.source | 121869.9 | ok |
| 21.8 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 21.8 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 21.9 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 23.6 | host |  | firegrid.workflow_engine.execution.execute | 33.1 | ok |
| 31.3 | unknown |  | firegrid.mcp.publish_runtime_context_base | 0.1 | ok |
| 34.8 | host |  | firegrid.workflow_engine.execution.resume | 0.3 | ok |
| 35 | host |  | firegrid.workflow_engine.execution.resume.body | 0.1 | ok |
| 35.5 | host |  | firegrid.workflow_engine.activity.execute | 19.3 | ok |
| 35.6 | host |  | firegrid.workflow_engine.activity.claim | 1.8 | ok |
| 37.7 | host | ctx_ext_WyJhZ2V... | firegrid.host.control_request.context.workflow | 12.6 | ok |
| 47.6 | host | ctx_ext_WyJhZ2V... | firegrid.runtime_context.input_facts.for_context | 121841.5 | ok |
| 48.7 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.channel.session_prompt.append | 2.5 | ok |
| 51.2 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.start | 1.8 | ok |
| 51.7 | sdk | ctx_ext_WyJhZ2V... | firegrid.channel.host.sessions.start.call | 1.3 | ok |
| 57.2 | host |  | firegrid.workflow_engine.execution.execute | 5 | ok |
| 57.6 | host |  | firegrid.workflow_engine.execution.execute | 0.6 | ok |
| 59.4 | host |  | firegrid.workflow_engine.execution.execute | 4 | ok |
| 59.4 | host |  | firegrid.workflow_engine.execution.resume | 0.2 | ok |
| 59.5 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 59.6 | host |  | firegrid.workflow_engine.execution.execute | 3.3 | ok |
| 59.7 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 59.9 | host | ctx_ext_WyJhZ2V... | firegrid.host.control_request.claim.workflow | 0.2 | ok |
| 61.8 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 66 | host | ctx_ext_WyJhZ2V... | firegrid.host.runtime_context.side_effect.start | 121816.3 | ok |
| 67 | host |  | firegrid.rcsw.session-workflow.execute | 121814.9 | ok |
| 67.3 | host |  | firegrid.workflow_engine.execution.execute | 1291.6 | ok |
| 67.8 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 67.9 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 68.1 | host |  | firegrid.workflow_engine.activity.execute | 1268.5 | ok |
| 68.2 | host |  | firegrid.workflow_engine.activity.claim | 0.9 | ok |
| 69.2 | codec | ctx_ext_WyJhZ2V... | firegrid.host.codec.start_session | 1263 | ok |

## solo-baseline / single

Spans: 589; errors: 0; tool-call spans: 1; permission spans: 1; session.agent_output spans: 0.

### Span Sides

| Side | Spans | Total ms | Avg ms | Share |
| --- | ---: | ---: | ---: | --- |
| host | 486 | 716674.4 | 1474.6 | ████████████████████ |
| codec | 14 | 26930.8 | 1923.6 | █ |
| unknown | 35 | 23468.7 | 670.5 | █ |
| sdk | 21 | 199.2 | 9.5 | █ |
| agent-tools | 16 | 73.8 | 4.6 | █ |
| subprocess | 17 | 5.3 | 0.3 | █ |

### Highest-Cost Span Families

| Span | Count | Total ms | Avg ms | Max ms |
| --- | ---: | ---: | ---: | ---: |
| firegrid.durable_table.rows | 11 | 190644.9 | 17331.4 | 23932.1 |
| firegrid.runtime.tool_dispatch.host_install.layer | 1 | 23941.2 | 23941.2 | 23941.2 |
| firegrid.host.runtime_substrate.observation_streams.layer | 1 | 23939.8 | 23939.8 | 23939.8 |
| firegrid.host.runtime_substrate.observation.layer | 1 | 23939.5 | 23939.5 | 23939.5 |
| firegrid.runtime.agent_tool_execution.layer | 1 | 23936.5 | 23936.5 | 23936.5 |
| firegrid.host.agent_tools.tool_use_executor.layer | 1 | 23936.1 | 23936.1 | 23936.1 |
| firegrid.runtime_context.subscriber.dispatch | 1 | 23933.9 | 23933.9 | 23933.9 |
| firegrid.runtime_context.subscriber.source | 1 | 23933 | 23933 | 23933 |
| firegrid.runtime_control_plane.context.rows | 1 | 23932.2 | 23932.2 | 23932.2 |
| firegrid.runtime_context.input_facts.for_context | 1 | 23907.8 | 23907.8 | 23907.8 |
| firegrid.runtime_output.per_context.agent_output.for_context | 1 | 23907.1 | 23907.1 | 23907.1 |
| firegrid.host.control_request.start.side_effect | 3 | 23881.1 | 7960.4 | 23876.3 |

### Context Lifetimes

| Context | Spans | First ms | Last ms | Lifetime ms | Sides |
| --- | ---: | ---: | ---: | ---: | --- |
| ctx_ext_WyJhZ2V... | 152 | 23.5 | 23990.1 | 23966.7 | agent-tools, codec, host, sdk, subprocess |

### Representative Event Timeline

| At ms | Side | Context | Span | Duration ms | Status |
| ---: | --- | --- | --- | ---: | --- |
| 23.5 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.create_or_load | 13 | ok |
| 23.8 | sdk |  | firegrid.channel.host.sessions.create_or_load.call | 12.5 | ok |
| 36.6 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.prompt | 44.9 | ok |
| 45.2 | host |  | firegrid.workflow_engine.workflow.register | 0.1 | ok |
| 46.1 | host |  | firegrid.workflow_engine.workflow.register | 0.1 | ok |
| 46.2 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 49.7 | host |  | firegrid.host.control_request.workflow_engine.layer | 3.2 | ok |
| 50.2 | host |  | firegrid.runtime_context.subscriber.dispatch | 23933.9 | ok |
| 50.8 | host |  | firegrid.runtime_context.subscriber.source | 23933 | ok |
| 52.7 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 52.8 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 52.8 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 53.9 | host |  | firegrid.workflow_engine.execution.execute | 42.6 | ok |
| 64 | unknown |  | firegrid.mcp.publish_runtime_context_base | 0 | ok |
| 66.3 | host |  | firegrid.workflow_engine.execution.resume | 0.5 | ok |
| 66.7 | host |  | firegrid.workflow_engine.execution.resume.body | 0.1 | ok |
| 67.4 | host |  | firegrid.workflow_engine.activity.execute | 23.9 | ok |
| 67.6 | host |  | firegrid.workflow_engine.activity.claim | 2 | ok |
| 69.9 | host | ctx_ext_WyJhZ2V... | firegrid.host.control_request.context.workflow | 10 | ok |
| 75.4 | host | ctx_ext_WyJhZ2V... | firegrid.runtime_context.input_facts.for_context | 23907.8 | ok |
| 77.8 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.channel.session_prompt.append | 3.7 | ok |
| 81.6 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.start | 8.9 | ok |
| 82.7 | sdk | ctx_ext_WyJhZ2V... | firegrid.channel.host.sessions.start.call | 7.8 | ok |
| 97.5 | host |  | firegrid.workflow_engine.execution.execute | 5.9 | ok |
| 98.3 | host |  | firegrid.workflow_engine.execution.execute | 0.5 | ok |
| 100 | host |  | firegrid.workflow_engine.execution.execute | 4.7 | ok |
| 100 | host |  | firegrid.workflow_engine.execution.resume | 0.2 | ok |
| 100.1 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 100.2 | host |  | firegrid.workflow_engine.execution.execute | 3.9 | ok |
| 100.3 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 100.5 | host | ctx_ext_WyJhZ2V... | firegrid.host.control_request.claim.workflow | 0.2 | ok |
| 102.9 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 107.1 | host | ctx_ext_WyJhZ2V... | firegrid.host.runtime_context.side_effect.start | 23872.2 | ok |
| 108.2 | host |  | firegrid.rcsw.session-workflow.execute | 23870.5 | ok |
| 109.6 | host |  | firegrid.workflow_engine.execution.execute | 1600.7 | ok |
| 110.3 | host |  | firegrid.workflow_engine.execution.resume | 0.2 | ok |
| 110.4 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 110.9 | host |  | firegrid.workflow_engine.activity.execute | 1542.3 | ok |
| 111 | host |  | firegrid.workflow_engine.activity.claim | 1 | ok |
| 112.2 | codec | ctx_ext_WyJhZ2V... | firegrid.host.codec.start_session | 1530.8 | ok |

## webhook-burst / central

Spans: 3691; errors: 0; tool-call spans: 14; permission spans: 6; session.agent_output spans: 22.

### Span Sides

| Side | Spans | Total ms | Avg ms | Share |
| --- | ---: | ---: | ---: | --- |
| host | 3011 | 4768830.7 | 1583.8 | ████████████████████ |
| codec | 147 | 245555.4 | 1670.4 | █ |
| unknown | 102 | 88049.7 | 863.2 | █ |
| agent-tools | 265 | 623.6 | 2.4 | █ |
| sdk | 21 | 76 | 3.6 | █ |
| subprocess | 145 | 18.3 | 0.1 | █ |

### Highest-Cost Span Families

| Span | Count | Total ms | Avg ms | Max ms |
| --- | ---: | ---: | ---: | ---: |
| firegrid.durable_table.rows | 30 | 1156102.6 | 38536.8 | 88059.8 |
| firegrid.agent_event_pipeline.codec.layer | 3 | 238838.4 | 79612.8 | 88074.7 |
| firegrid.runtime_context.input_facts.for_context | 3 | 238825.8 | 79608.6 | 88049.6 |
| firegrid.runtime_output.per_context.agent_output.for_context | 3 | 238822.6 | 79607.5 | 88047.1 |
| firegrid.host.control_request.start.side_effect | 5 | 238778.5 | 47755.7 | 88029.9 |
| firegrid.host.runtime_context.side_effect.start | 3 | 238768.2 | 79589.4 | 88027.3 |
| firegrid.runtime_control_plane.run.wait_terminal | 3 | 238764.7 | 79588.2 | 88026.5 |
| firegrid.rcsw.session-workflow.execute | 3 | 238763.7 | 79587.9 | 88026.2 |
| firegrid.agent_event_pipeline.codec.outputs | 3 | 235483.6 | 78494.5 | 87004.8 |
| firegrid.agent_event_pipeline.codec.stderr_journal | 3 | 235481.9 | 78494 | 87004.2 |
| firegrid.agent_event_pipeline.acp.output_queue | 3 | 235454.8 | 78484.9 | 86997.7 |
| firegrid.agent_event_pipeline.acp.exit | 3 | 235454.2 | 78484.7 | 86997.5 |

### Context Lifetimes

| Context | Spans | First ms | Last ms | Lifetime ms | Sides |
| --- | ---: | ---: | ---: | ---: | --- |
| ctx_ext_WyJhZ2V... | 993 | 3 | 88120.4 | 88117.3 | agent-tools, codec, host, sdk, subprocess |
| ctx_ctx_ext_WyJ... | 196 | 11855.8 | 88098.8 | 76243 | agent-tools, codec, host, subprocess |
| ctx_ctx_ext_WyJ... | 226 | 13507.9 | 88077.6 | 74569.7 | agent-tools, codec, host, subprocess |

### Representative Event Timeline

| At ms | Side | Context | Span | Duration ms | Status |
| ---: | --- | --- | --- | ---: | --- |
| 3 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.create_or_load | 2.6 | ok |
| 3.1 | sdk |  | firegrid.channel.host.sessions.create_or_load.call | 2.5 | ok |
| 5.7 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.prompt | 21.8 | ok |
| 11.4 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 11.9 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 12 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 13.8 | host |  | firegrid.host.control_request.workflow_engine.layer | 1.4 | ok |
| 14 | host |  | firegrid.runtime_context.subscriber.dispatch | 88060.5 | ok |
| 14.2 | host |  | firegrid.runtime_context.subscriber.source | 88060.2 | ok |
| 15.1 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 15.1 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 15.2 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 15.7 | host |  | firegrid.workflow_engine.execution.execute | 18.3 | ok |
| 18.8 | unknown |  | firegrid.mcp.publish_runtime_context_base | 0 | ok |
| 20.1 | host |  | firegrid.workflow_engine.execution.resume | 0.2 | ok |
| 20.2 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 20.4 | host |  | firegrid.workflow_engine.activity.execute | 11.4 | ok |
| 20.5 | host |  | firegrid.workflow_engine.activity.claim | 1 | ok |
| 21.6 | host | ctx_ext_WyJhZ2V... | firegrid.host.control_request.context.workflow | 4.9 | ok |
| 24.2 | host | ctx_ext_WyJhZ2V... | firegrid.runtime_context.input_facts.for_context | 88049.6 | ok |
| 25 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.channel.session_prompt.append | 2.4 | ok |
| 27.5 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.start | 3.7 | ok |
| 28.1 | sdk | ctx_ext_WyJhZ2V... | firegrid.channel.host.sessions.start.call | 3.2 | ok |
| 34.4 | host |  | firegrid.workflow_engine.execution.execute | 4.4 | ok |
| 34.8 | host |  | firegrid.workflow_engine.execution.execute | 0.3 | ok |
| 36.2 | host |  | firegrid.workflow_engine.execution.execute | 3.4 | ok |
| 36.3 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 36.4 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 36.5 | host |  | firegrid.workflow_engine.execution.execute | 2.8 | ok |
| 36.5 | host |  | firegrid.workflow_engine.execution.resume | 0 | ok |
| 36.6 | host | ctx_ext_WyJhZ2V... | firegrid.host.control_request.claim.workflow | 0.2 | ok |
| 38.4 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 41.4 | host | ctx_ext_WyJhZ2V... | firegrid.host.runtime_context.side_effect.start | 88027.3 | ok |
| 42.2 | host |  | firegrid.rcsw.session-workflow.execute | 88026.2 | ok |
| 42.8 | host |  | firegrid.workflow_engine.execution.execute | 1091.9 | ok |
| 43.2 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 43.3 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 43.5 | host |  | firegrid.workflow_engine.activity.execute | 1073.4 | ok |
| 43.6 | host |  | firegrid.workflow_engine.activity.claim | 0.7 | ok |
| 44.3 | codec | ctx_ext_WyJhZ2V... | firegrid.host.codec.start_session | 1070.5 | ok |

## webhook-burst / choreography

Spans: 3630; errors: 0; tool-call spans: 16; permission spans: 9; session.agent_output spans: 1.

### Span Sides

| Side | Spans | Total ms | Avg ms | Share |
| --- | ---: | ---: | ---: | --- |
| host | 2864 | 4954648.8 | 1730 | ████████████████████ |
| agent-tools | 351 | 1183884 | 3372.9 | █████ |
| unknown | 118 | 479817.1 | 4066.2 | ██ |
| codec | 133 | 255232.1 | 1919 | █ |
| sdk | 21 | 196.8 | 9.4 | █ |
| subprocess | 143 | 19.4 | 0.1 | █ |

### Highest-Cost Span Families

| Span | Count | Total ms | Avg ms | Max ms |
| --- | ---: | ---: | ---: | ---: |
| firegrid.durable_table.rows | 27 | 1161370.4 | 43013.7 | 85555.2 |
| firegrid.workflow_engine.execution.execute | 79 | 268425.5 | 3397.8 | 52621.8 |
| firegrid.agent_event_pipeline.codec.layer | 4 | 244974.7 | 61243.7 | 85616.4 |
| firegrid.runtime_context.input_facts.for_context | 4 | 244828.3 | 61207.1 | 85545.5 |
| firegrid.runtime_output.per_context.agent_output.for_context | 4 | 244824.7 | 61206.2 | 85544.5 |
| firegrid.host.control_request.start.side_effect | 6 | 244715.5 | 40785.9 | 85501.2 |
| firegrid.host.runtime_context.side_effect.start | 4 | 244700.7 | 61175.2 | 85498.8 |
| firegrid.runtime_control_plane.run.wait_terminal | 4 | 244691.8 | 61173 | 85498.2 |
| firegrid.rcsw.session-workflow.execute | 4 | 244690.6 | 61172.6 | 85497.9 |
| firegrid.agent_event_pipeline.codec.outputs | 4 | 239849.4 | 59962.4 | 83938.5 |
| firegrid.agent_event_pipeline.codec.stderr_journal | 4 | 239846.6 | 59961.6 | 83938 |
| firegrid.agent_event_pipeline.acp.output_queue | 4 | 239818.4 | 59954.6 | 83930.9 |

### Context Lifetimes

| Context | Spans | First ms | Last ms | Lifetime ms | Sides |
| --- | ---: | ---: | ---: | ---: | --- |
| ctx_ext_WyJhZ2V... | 692 | 5.5 | 85683.4 | 85677.8 | agent-tools, codec, host, sdk, subprocess |
| ctx_ctx_ext_WyJ... | 195 | 23604.4 | 85655.3 | 62050.9 | agent-tools, codec, host, subprocess |
| ctx_ctx_ext_WyJ... | 187 | 32398.9 | 85628.7 | 53229.9 | agent-tools, codec, host, subprocess |
| ctx_ctx_ext_WyJ... | 192 | 41406.3 | 85590.4 | 44184.1 | agent-tools, codec, host, subprocess |

### Representative Event Timeline

| At ms | Side | Context | Span | Duration ms | Status |
| ---: | --- | --- | --- | ---: | --- |
| 5.5 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.create_or_load | 4.1 | ok |
| 5.7 | sdk |  | firegrid.channel.host.sessions.create_or_load.call | 3.9 | ok |
| 9.8 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.prompt | 42.6 | ok |
| 14.5 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 14.8 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 14.9 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 16.8 | host |  | firegrid.host.control_request.workflow_engine.layer | 1.6 | ok |
| 17.1 | host |  | firegrid.runtime_context.subscriber.dispatch | 85556.2 | ok |
| 17.3 | host |  | firegrid.runtime_context.subscriber.source | 85555.7 | ok |
| 18.3 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 18.3 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 18.4 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 18.9 | host |  | firegrid.workflow_engine.execution.execute | 35.7 | ok |
| 22.4 | unknown |  | firegrid.mcp.publish_runtime_context_base | 0 | ok |
| 23.2 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 23.3 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 23.5 | host |  | firegrid.workflow_engine.activity.execute | 28 | ok |
| 23.6 | host |  | firegrid.workflow_engine.activity.claim | 0.8 | ok |
| 24.5 | host | ctx_ext_WyJhZ2V... | firegrid.host.control_request.context.workflow | 23.2 | ok |
| 26.2 | host | ctx_ext_WyJhZ2V... | firegrid.runtime_context.input_facts.for_context | 85545.5 | ok |
| 26.9 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.channel.session_prompt.append | 25.5 | ok |
| 52.4 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.start | 1.7 | ok |
| 53 | sdk | ctx_ext_WyJhZ2V... | firegrid.channel.host.sessions.start.call | 1.2 | ok |
| 55.1 | host |  | firegrid.workflow_engine.execution.execute | 4.1 | ok |
| 55.5 | host |  | firegrid.workflow_engine.execution.execute | 0.4 | ok |
| 56.5 | host |  | firegrid.workflow_engine.execution.execute | 3.4 | ok |
| 56.6 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 56.7 | host |  | firegrid.workflow_engine.execution.execute | 2.9 | ok |
| 56.7 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 56.8 | host |  | firegrid.workflow_engine.execution.resume | 0 | ok |
| 56.9 | host | ctx_ext_WyJhZ2V... | firegrid.host.control_request.claim.workflow | 0.1 | ok |
| 58.7 | host |  | firegrid.workflow_engine.execution.resume | 0 | ok |
| 61.6 | host | ctx_ext_WyJhZ2V... | firegrid.host.runtime_context.side_effect.start | 85498.8 | ok |
| 62.2 | host |  | firegrid.rcsw.session-workflow.execute | 85497.9 | ok |
| 62.5 | host |  | firegrid.workflow_engine.execution.execute | 1701.4 | ok |
| 63 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 63.1 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 63.3 | host |  | firegrid.workflow_engine.activity.execute | 1683.3 | ok |
| 63.4 | host |  | firegrid.workflow_engine.activity.claim | 0.8 | ok |
| 64.3 | codec | ctx_ext_WyJhZ2V... | firegrid.host.codec.start_session | 1679.9 | ok |

## webhook-burst / single

Spans: 1039; errors: 0; tool-call spans: 5; permission spans: 2; session.agent_output spans: 0.

### Span Sides

| Side | Spans | Total ms | Avg ms | Share |
| --- | ---: | ---: | ---: | --- |
| host | 811 | 637101.2 | 785.6 | ████████████████████ |
| codec | 36 | 24151.6 | 670.9 | █ |
| unknown | 55 | 20925.5 | 380.5 | █ |
| agent-tools | 76 | 169.4 | 2.2 | █ |
| sdk | 21 | 83.9 | 4 | █ |
| subprocess | 40 | 4.9 | 0.1 | █ |

### Highest-Cost Span Families

| Span | Count | Total ms | Avg ms | Max ms |
| --- | ---: | ---: | ---: | ---: |
| firegrid.durable_table.rows | 15 | 169464.6 | 11297.6 | 21264.2 |
| firegrid.runtime.tool_dispatch.host_install.layer | 1 | 21268.9 | 21268.9 | 21268.9 |
| firegrid.host.runtime_substrate.observation_streams.layer | 1 | 21268.3 | 21268.3 | 21268.3 |
| firegrid.host.runtime_substrate.observation.layer | 1 | 21268.1 | 21268.1 | 21268.1 |
| firegrid.runtime.agent_tool_execution.layer | 1 | 21266.7 | 21266.7 | 21266.7 |
| firegrid.host.agent_tools.tool_use_executor.layer | 1 | 21266.6 | 21266.6 | 21266.6 |
| firegrid.runtime_context.subscriber.dispatch | 1 | 21265.2 | 21265.2 | 21265.2 |
| firegrid.runtime_context.subscriber.source | 1 | 21264.7 | 21264.7 | 21264.7 |
| firegrid.runtime_control_plane.context.rows | 1 | 21264.3 | 21264.3 | 21264.3 |
| firegrid.runtime_context.input_facts.for_context | 1 | 21249.9 | 21249.9 | 21249.9 |
| firegrid.runtime_output.per_context.agent_output.for_context | 1 | 21249.5 | 21249.5 | 21249.5 |
| firegrid.host.control_request.start.side_effect | 3 | 21238.9 | 7079.6 | 21235.9 |

### Context Lifetimes

| Context | Spans | First ms | Last ms | Lifetime ms | Sides |
| --- | ---: | ---: | ---: | ---: | --- |
| ctx_ext_WyJhZ2V... | 362 | 4.7 | 21284.7 | 21280 | agent-tools, codec, host, sdk, subprocess |

### Representative Event Timeline

| At ms | Side | Context | Span | Duration ms | Status |
| ---: | --- | --- | --- | ---: | --- |
| 4.7 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.create_or_load | 3.5 | ok |
| 4.8 | sdk |  | firegrid.channel.host.sessions.create_or_load.call | 3.2 | ok |
| 8.2 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.prompt | 26.6 | ok |
| 14 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 14.5 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 14.6 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 16.8 | host |  | firegrid.host.control_request.workflow_engine.layer | 4.8 | ok |
| 17.2 | host |  | firegrid.runtime_context.subscriber.dispatch | 21265.2 | ok |
| 17.6 | host |  | firegrid.runtime_context.subscriber.source | 21264.7 | ok |
| 21.5 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 21.5 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 21.6 | host |  | firegrid.workflow_engine.workflow.register | 0 | ok |
| 22.2 | host |  | firegrid.workflow_engine.execution.execute | 18.3 | ok |
| 26.3 | unknown |  | firegrid.mcp.publish_runtime_context_base | 0 | ok |
| 27.5 | host |  | firegrid.workflow_engine.execution.resume | 0.2 | ok |
| 27.6 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 27.9 | host |  | firegrid.workflow_engine.activity.execute | 10.7 | ok |
| 28 | host |  | firegrid.workflow_engine.activity.claim | 1.6 | ok |
| 29.7 | host | ctx_ext_WyJhZ2V... | firegrid.host.control_request.context.workflow | 4.3 | ok |
| 32 | host | ctx_ext_WyJhZ2V... | firegrid.runtime_context.input_facts.for_context | 21249.9 | ok |
| 32.8 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.channel.session_prompt.append | 2.1 | ok |
| 34.9 | sdk | ctx_ext_WyJhZ2V... | firegrid.client.session.start | 3.2 | ok |
| 35.5 | sdk | ctx_ext_WyJhZ2V... | firegrid.channel.host.sessions.start.call | 2.5 | ok |
| 41.2 | host |  | firegrid.workflow_engine.execution.execute | 3.4 | ok |
| 41.6 | host |  | firegrid.workflow_engine.execution.execute | 0.4 | ok |
| 42.6 | host |  | firegrid.workflow_engine.execution.execute | 2.7 | ok |
| 42.6 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 42.7 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 42.8 | host |  | firegrid.workflow_engine.execution.execute | 2.2 | ok |
| 42.8 | host |  | firegrid.workflow_engine.execution.resume | 0 | ok |
| 42.9 | host | ctx_ext_WyJhZ2V... | firegrid.host.control_request.claim.workflow | 0.1 | ok |
| 44.3 | host |  | firegrid.workflow_engine.execution.resume | 0 | ok |
| 46.7 | host | ctx_ext_WyJhZ2V... | firegrid.host.runtime_context.side_effect.start | 21233.7 | ok |
| 47.3 | host |  | firegrid.rcsw.session-workflow.execute | 21232.8 | ok |
| 47.6 | host |  | firegrid.workflow_engine.execution.execute | 1485.1 | ok |
| 48 | host |  | firegrid.workflow_engine.execution.resume | 0.1 | ok |
| 48.1 | host |  | firegrid.workflow_engine.execution.resume.body | 0 | ok |
| 48.3 | host |  | firegrid.workflow_engine.activity.execute | 1463.7 | ok |
| 48.3 | host |  | firegrid.workflow_engine.activity.claim | 0.7 | ok |
| 49.1 | codec | ctx_ext_WyJhZ2V... | firegrid.host.codec.start_session | 1459.1 | ok |

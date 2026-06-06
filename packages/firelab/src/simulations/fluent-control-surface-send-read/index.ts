import { defineSimulation } from "../../types.ts"
import { driver } from "./driver.ts"
import { host } from "./host.ts"

export default defineSimulation({
  id: "fluent-control-surface-send-read",
  description:
    "First fluent control-plane vertical slice: production-shaped control surface appends addressed input to a durable entity stream and read/head projections derive from DS state.",
  host,
  driver,
  coverage: {
    gates: [
      {
        id: "fluent_control_surface.external_send_ingress",
        description: "an external HTTP send request entered the host-served control surface",
        claim:
          "spans.exists(http, named(http, \"fluent_runtime.control_http.request\") && attr(http, \"fluent_runtime.control_http.method\") == \"POST\" && attr(http, \"fluent_runtime.control_http.path\") == \"/entities/session-1/inputs\" && hasDescendant(http, \"fluent_runtime.control_surface.send\"))",
      },
      {
        id: "fluent_control_surface.send_accepted",
        description: "send accepted addressed input for entity session-1 at the control boundary",
        claim:
          "spans.exists(s, named(s, \"fluent_runtime.control_surface.send\") && attr(s, \"firegrid.entity.id\") == \"session-1\" && attr(s, \"fluent_runtime.control.input_id\") == \"control-input-1\" && attr(s, \"fluent_runtime.control.event_name\") == \"fluent.control.input.addressed\" && attr(s, \"fluent_runtime.control.append_result\") == \"Appended\")",
      },
      {
        id: "fluent_control_surface.send_appended_to_ds",
        description: "send persisted through FluentStore and Durable Streams HTTP",
        claim:
          "spans.exists(http, named(http, \"fluent_runtime.control_http.request\") && attr(http, \"fluent_runtime.control_http.method\") == \"POST\" && attr(http, \"fluent_runtime.control_http.path\") == \"/entities/session-1/inputs\" && hasDescendant(http, \"fluent_runtime.store.session.append_event_fenced\") && hasDescendant(http, \"firegrid.durable_streams.http.request\"))",
      },
      {
        id: "fluent_control_surface.duplicate_input_idempotent",
        description: "re-sending the same input id is idempotent under the per-input producer key",
        claim:
          "spans.exists(first, named(first, \"fluent_runtime.control_surface.send\") && attr(first, \"fluent_runtime.control.input_id\") == \"control-input-1\" && attr(first, \"fluent_runtime.control.append_result\") == \"Appended\") && spans.exists(dup, named(dup, \"fluent_runtime.control_surface.send\") && attr(dup, \"fluent_runtime.control.input_id\") == \"control-input-1\" && attr(dup, \"fluent_runtime.control.append_result\") == \"Duplicate\")",
      },
      {
        id: "fluent_control_surface.post_append_boundary",
        description: "send acceptance stops at the explicit post-append boundary; wake/redrive is not wired in this slice",
        claim:
          "spans.exists(s, named(s, \"fluent_runtime.control_surface.send\") && attr(s, \"fluent_runtime.control.delivery\") == \"post_append_boundary\" && attr(s, \"fluent_runtime.control.handler_invoked\") == \"false\")",
      },
      {
        id: "fluent_control_surface.read_projection_from_ds",
        description: "external read projection is derived from durable stream collect + head",
        claim:
          "spans.exists(http, named(http, \"fluent_runtime.control_http.request\") && attr(http, \"fluent_runtime.control_http.method\") == \"GET\" && attr(http, \"fluent_runtime.control_http.path\") == \"/entities/session-1\" && hasDescendant(http, \"fluent_runtime.control_surface.read\") && hasDescendant(http, \"fluent_runtime.store.session.collect\") && hasDescendant(http, \"fluent_runtime.store.session.head\") && spans.exists(r, named(r, \"fluent_runtime.control_surface.read\") && attr(r, \"firegrid.entity.id\") == \"session-1\" && attr(r, \"fluent_runtime.control.projection.addressed_inputs\") == \"2\"))",
      },
      {
        id: "fluent_control_surface.head_projection_from_ds",
        description: "external head projection is derived from durable stream head state and matches the read head offset",
        claim:
          "spans.exists(http, named(http, \"fluent_runtime.control_http.request\") && attr(http, \"fluent_runtime.control_http.method\") == \"HEAD\" && attr(http, \"fluent_runtime.control_http.path\") == \"/entities/session-1\" && hasDescendant(http, \"fluent_runtime.control_surface.head\") && hasDescendant(http, \"fluent_runtime.store.session.head\") && spans.exists(h, named(h, \"fluent_runtime.control_surface.head\") && attr(h, \"firegrid.entity.id\") == \"session-1\" && spans.exists(r, named(r, \"fluent_runtime.control_surface.read\") && attr(r, \"fluent_runtime.control.projection.offset\") == attr(h, \"fluent_runtime.control.head.offset\"))))",
      },
    ],
    corroborations: [
      {
        id: "fluent_control_surface.driver_observed_entity_stream",
        description: "driver independently observed the addressed input in the entity stream",
        claim:
          "spans.exists(s, named(s, \"firelab.fluent_control_surface_send_read.driver\") && attr(s, \"fluent_control_surface.addressed_inputs\") == \"2\" && attr(s, \"fluent_control_surface.duplicate_result\") == \"Duplicate\")",
      },
    ],
  },
})

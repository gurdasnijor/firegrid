# channels/observation-streams/

Runtime observation-source capability tags used by channel wait and routing
surfaces.

This folder owns the typed observation source vocabulary for runtime waits:
agent output, agent output after a cursor, and caller-owned fact streams. It
does not own durable workflow execution and does not dispatch subscribers; it
adapts table-backed observation capabilities into a channel-tier service that
Shape D subscribers can consume.

Public subpath: `@firegrid/runtime/channels/observation-streams`.

Compatibility alias: `@firegrid/runtime/streams` points here until remaining
external consumers retarget.

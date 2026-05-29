# connectors/

Logical pipeline position: **3c** (peer with `sources/`, `producers/`,
`transforms/`, `channels/`). Each subfolder is one **external adapter**:
the cognitive unit is the integration, not the role.

Source: `docs/sdds/SDD_FIREGRID_RUNTIME_SOURCE_PRODUCER_ROLES.md` —
"`connectors/` for external adapters" revision.

## Owns

Self-contained external ingress adapters. Each connector lives as
`connectors/<name>/` with its own emitter half (HTTP request → typed
events), writer half (event → fact row through the
`ExternalIngressAppender` capability tag), and schemas. Concrete examples:

- `connectors/linear/` — Linear webhooks (PR-M3.5 spike → production).
- `connectors/github/` — GitHub webhooks (future).
- `connectors/slack/` — Slack events (future).
- `connectors/webhook/` — generalized verified-webhook base that concrete
  connectors parameterize (PR-M4 reshape of the existing
  `verified-webhook-ingest/`).

## The unit

Each connector folder exports one `ConnectorAdapter<Event, Fact>` value
(see `events/connector-adapter.ts`). The connector is the unit of
review, of deployment, of test, and of mental model. An implementer
building a new adapter touches **one folder**, not five tier folders.

Recommended internal layout (convention, not required):

```text
connectors/<name>/
├── README.md
├── index.ts        # exports <Name>Connector: ConnectorAdapter<E, F>
├── schema.ts       # event union + fact row schemas
└── signature.ts    # signature verification helper (if applicable)
```

Small connectors can collapse to a single `index.ts`. Large connectors can
fan out as needed — the only enforced boundary is the folder.

## May import

- `events/` (for `ConnectorAdapter` and shared event types)
- `capabilities/` (for `ExternalIngressAppender` and other Tags)
- `tables/` (for row type references in the fact schema — but NOT for
  direct writes; those go through the appender Tag)
- `transforms/` (for shared pure helpers)
- `channels/` (for HTTP route registration types only)

## Must not import

- **other `connectors/<other-name>/`** — connectors are closed units. If
  two adapters need to share code, that code goes into a tier folder
  (`transforms/`, `capabilities/`) or into `connectors/webhook/` (the
  generalized base). One connector never reaches into another.
- `sources/`, `producers/` — connectors *are* the source+writer pair for
  their feature; they don't depend on the runtime-internal source/writer
  tiers.
- `subscribers/`, `composition/` — same reasoning as every other
  middle-tier folder.
- `_archive/`.

## Composition

`composition/compose-connector.ts:composeConnector(adapter)` produces a
`Layer` that mounts the adapter's `route` onto the host `HttpRouter` and
runs `source(req) |> Stream.mapEffect(adapter.journal)` for each inbound
request. `composition/host-live.ts` merges any number of connector
adapters into the runtime layer graph; adding an adapter to the host is
one line in composition, not a tier-by-tier edit.

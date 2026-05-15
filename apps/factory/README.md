# Firegrid Factory

`@firegrid/factory` is the first dark-factory app slice. It composes one
Firegrid runtime host and app-owned durable facts/runs for hosted
Electric/Durable Streams evidence.

## Hosted Smoke

Required environment:

- `DURABLE_STREAMS_BASE_URL`
  - generic Durable Streams root, for example `http://127.0.0.1:4437`
  - or Electric Cloud service root, for example
    `https://api.electric-sql.cloud/v1/stream/<service>`

Optional:

- `FIREGRID_DURABLE_STREAMS_TOKEN`
- `FIREGRID_RUNTIME_NAMESPACE`, defaults to `firegrid-factory`

Planner launch configuration is data, not ambient process config. Put it in a
JSON file:

```json
{
  "planner": {
    "argv": ["node", "path/to/planner.js"],
    "agentProtocol": "acp",
    "cwd": "/path/to/workspace",
    "envBindings": [
      { "name": "ANTHROPIC_API_KEY", "ref": "env:ANTHROPIC_API_KEY" }
    ]
  },
  "providerCapabilities": []
}
```

The referenced secret values stay in the host environment. They are resolved at
runtime through the existing runtime env-binding policy; literal secret values
are never accepted in the config.

Put the provider-shaped trigger in a JSON file:

```json
{
  "source": "linear.oauth",
  "externalEventKey": "evt-1",
  "externalEntityKey": "issue-1",
  "eventType": "linear.issue.accepted",
  "repoHint": "gurdasnijor/firegrid",
  "payload": {
    "delivery": "manual-smoke"
  }
}
```

Run:

```sh
pnpm --filter @firegrid/factory smoke:hosted \
  --config ./factory.config.json \
  --trigger ./trigger.json
```

The smoke writes a hosted `darkFactory.facts` accepted trigger, creates/loads
one durable factory-run row and planner Firegrid session, starts the planner,
observes a durable ACP `PermissionRequest`, writes a `PermissionResponse`
through the scoped session facade, and waits for the next planner output. The
reported `sessionId` is the app-facing id; existing durable rows still carry
the same encoded value as `plannerContextId` or `contextId`.

The smoke composes Firegrid host/runtime/table layers directly. It does not
start an app-specific `/factory/*` HTTP API; product/provider routes belong at
the product adapter edge and should write the same durable facts.

Provider side effects through `execute` are intentionally not advertised in the
P0 smoke unless real capabilities are configured in a later slice.

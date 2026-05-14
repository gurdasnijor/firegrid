# Firegrid Runbooks

Runbooks are operational recipes for proving or exercising current Firegrid
paths. They are not design proposals; prefer them when you need an exact command
to run.

| Runbook | Use When |
| --- | --- |
| [Firegrid Run - Synchronous MVP](./firegrid-run-sync-mvp.md) | Smoke `pnpm firegrid:run --cwd --prompt --secret-env -- <agent>` locally or against Electric Cloud. |
| [Electric Cloud Runtime Host](./electric-cloud-runtime-host.md) | Smoke the long-running `pnpm firegrid:host` process against Electric Cloud Durable Streams. |
| [Fireline Scenario Testing](./FIRELINE_SCENARIO_TESTING_RUNBOOK.md) | Run Fireline scenario tests and compare behavior across the Fireline reference path. |

Common smoke commands:

```sh
pnpm smoke:firegrid-run
pnpm run check:docs
pnpm run check:specs
```

For manual `firegrid:run` or `firegrid:host` commands,
`DURABLE_STREAMS_BASE_URL` must point at a running Durable Streams endpoint. The
`smoke:firegrid-run` scenario starts an in-process local test server by itself.

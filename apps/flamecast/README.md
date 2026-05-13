# Flamecast Toy

A minimal local Flamecast toy for launching one-shot stdio agents through
Firegrid.

## Run

Against the environment in `.env`:

```bash
pnpm flamecast:run
```

Required:

```bash
DURABLE_STREAMS_BASE_URL=https://...
FIREGRID_RUNTIME_NAMESPACE=flamecast-test
FIREGRID_DURABLE_STREAMS_TOKEN=...
```

For a throwaway local server:

```bash
pnpm --filter @firegrid/flamecast dev:local
```

Then open the URL printed in the terminal.

Both commands start:

- the Flamecast runtime host
- the Vite UI

They wire the matching stream URL and namespace into both the runtime and
browser process. Press `Ctrl-C` to stop everything.

## Manual Mode

Use this only when you want to point Flamecast at an already-running Durable
Streams server:

```bash
cp apps/flamecast/.env.example apps/flamecast/.env
pnpm --filter @firegrid/flamecast runtime:env
pnpm --filter @firegrid/flamecast dev
```

The toy is local-only for now and does not need an Electric Cloud token.

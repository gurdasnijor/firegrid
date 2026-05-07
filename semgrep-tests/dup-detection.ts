// ruleid: firegrid-no-process-env-outside-bin
const url = process.env.DURABLE_STREAMS_URL

// ruleid: firegrid-no-process-env-outside-bin
const port = process.env.PORT ?? "3000"

// ok: firegrid-no-process-env-outside-bin
declare const cfg: { readonly streamUrl: string }
const ok1 = cfg.streamUrl

// ok: firegrid-no-process-env-outside-bin
declare const env: Record<string, string>
const ok2 = env.SOME_VAR

void url
void port
void ok1
void ok2

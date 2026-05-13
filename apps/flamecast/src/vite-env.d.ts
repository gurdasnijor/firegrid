/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DURABLE_STREAMS_BASE_URL?: string
  readonly VITE_FIREGRID_RUNTIME_NAMESPACE?: string
  readonly VITE_FIREGRID_DURABLE_STREAMS_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DURABLE_STREAMS_BASE_URL?: string
  readonly VITE_FIREGRID_RUNTIME_NAMESPACE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

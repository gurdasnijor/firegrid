import { Option } from "effect"
import { exampleJsonlSessionMaterializer } from "./example-jsonl-session.ts"
import type { RuntimeOutputMaterializer } from "./types.ts"

export const builtinMaterializers = {
  "example-jsonl-session": exampleJsonlSessionMaterializer,
} as const

export const lookupMaterializer = (
  name: string,
): Option.Option<RuntimeOutputMaterializer> =>
  name in builtinMaterializers
    ? Option.some(builtinMaterializers[name as keyof typeof builtinMaterializers])
    : Option.none()

import { Context } from "effect"
import type { DurableTableHeaders } from "effect-durable-operators"

interface RuntimeHostConfigValue {
  readonly inputEnabled: boolean
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
  readonly headers?: DurableTableHeaders
}

export class RuntimeHostConfig extends Context.Tag("firegrid/runtime/RuntimeHostConfig")<
  RuntimeHostConfig,
  RuntimeHostConfigValue
>() {}

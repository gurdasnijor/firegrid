import { Context } from "effect"
import type { DurableTableHeaders } from "effect-durable-operators"

// `RuntimeHostConfigValue` was previously exported alongside the Tag but
// had zero consumers — body+kernel deletion wave rev 3 dropped the
// re-export from `kernel/index.ts` (per OLA #726 directive) and inlined
// the shape into the Tag declaration here. Retirement bead: tf-z8wq.
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

import { Context } from "effect"
import type { RuntimeHostConfigValue } from "./types.ts"

export class RuntimeHostConfig extends Context.Tag("firegrid/runtime/RuntimeHostConfig")<
  RuntimeHostConfig,
  RuntimeHostConfigValue
>() {}

import {
  type RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import { Context, type Stream } from "effect"

export class RuntimeIngressInputStream extends Context.Tag(
  "@firegrid/runtime/RuntimeIngressInputStream",
)<RuntimeIngressInputStream, Stream.Stream<RuntimeIngressInputRow, unknown>>() {}

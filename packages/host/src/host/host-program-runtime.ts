import { Context } from "effect"
import type { SubstrateHostStreamIdentity } from "./service.ts"

// launchable-substrate-host.RUNTIME_COMPOSITION.1
// launchable-substrate-host.RUNTIME_COMPOSITION.3
// launchable-substrate-host.SERVER_RUNTIME_API.3
//
// HostProgramRuntime is a narrow host-owned service supplied to a
// HostProgramGraph layer at launch time. It carries only the runtime
// context HostPrograms helpers need to bind to the substrate stream:
// streamUrl, contentType, processId, and the resolved streamIdentity.
//
// It is intentionally narrower than SubstrateHost — boot plan and
// any future auth/diagnostic state are deliberately not part of this
// Tag. Programs should not reach into host configuration; they
// should compose adapter / provider / event-plane layers and let the
// substrate stream identity drive them.

export interface HostProgramRuntimeService {
  readonly streamUrl: string
  readonly contentType: string
  readonly processId: string
  readonly streamIdentity: SubstrateHostStreamIdentity
}

export class HostProgramRuntime extends Context.Tag(
  "substrate/host/HostProgramRuntime",
)<HostProgramRuntime, HostProgramRuntimeService>() {}

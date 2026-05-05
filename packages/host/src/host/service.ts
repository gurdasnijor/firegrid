import { Context } from "effect"
import type { BootMode, SubstrateHostBootPlan } from "../boot/plan.ts"

// launchable-substrate-host.HOST_PROCESS.1
// launchable-substrate-host.PACKAGING.4
// launchable-substrate-host.PACKAGING.8
//
// SubstrateHost is the launchable-host capability. It exposes
// resolved boot identity. Host lifecycle status and host diagnostics
// surfaces are deferred and are not part of this Tag — do not add
// fields here for them.
export interface SubstrateHostStreamIdentity {
  readonly streamUrl: string
  readonly streamName?: string
  readonly host?: string
  readonly port?: number
}

export interface SubstrateHostService {
  readonly processId: string
  readonly bootMode: BootMode
  readonly programName?: string
  readonly streamIdentity: SubstrateHostStreamIdentity
  readonly bootPlan: SubstrateHostBootPlan
}

export class SubstrateHost extends Context.Tag(
  "substrate/SubstrateHost",
)<SubstrateHost, SubstrateHostService>() {}

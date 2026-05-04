import { Context } from "effect"
import type { BootMode, SubstrateHostBootPlan } from "../boot/plan.js"
import type { SubstrateHostProfile } from "./profile.js"

// launchable-substrate-host.HOST_PROCESS.1
// launchable-substrate-host.HOST_PROCESS.6
// launchable-substrate-host.HOST_DIAGNOSTICS.1
// launchable-substrate-host.PACKAGING.4
// launchable-substrate-host.PACKAGING.8
//
// SubstrateHost is the launchable-host capability. v1 (Slice 4)
// exposes only resolved boot identity + read-only access to the
// active profile snapshot. Subscriber/operator loop status, last scan
// times, uptime, process metrics, and HTTP diagnostics ship in
// Slice 5/6.
export interface SubstrateHostStreamIdentity {
  readonly streamUrl: string
  readonly streamName?: string
  readonly host?: string
  readonly port?: number
}

export interface SubstrateHostService {
  readonly processId: string
  readonly bootMode: BootMode
  readonly streamIdentity: SubstrateHostStreamIdentity
  readonly headers: Readonly<Record<string, string>>
  readonly profile: SubstrateHostProfile
  readonly bootPlan: SubstrateHostBootPlan
}

export class SubstrateHost extends Context.Tag(
  "substrate/SubstrateHost",
)<SubstrateHost, SubstrateHostService>() {}

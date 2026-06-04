import { incidentReview } from "./01-basics.ts"

export const services = [incidentReview] as const

// fluent-firegrid-keystone.EXAMPLES.2
export const tutorialTiers = [
  { tier: "01-basics", status: "implemented" },
  { tier: "02-spawn", status: "deferred: spawn primitive unavailable" },
  { tier: "03-timeout", status: "deferred: sleep/select primitives unavailable" },
  { tier: "04-retry", status: "deferred: retry policy unavailable" },
  { tier: "05-saga", status: "deferred: failure delivery/compensation unavailable" },
  { tier: "06-cancel", status: "deferred: cancellation primitive unavailable" },
  { tier: "07-state", status: "deferred: state primitive unavailable" },
  { tier: "08-clients", status: "deferred: client descriptors unavailable" },
  { tier: "09-workflows", status: "deferred: workflow descriptors unavailable" },
  { tier: "10-ifaces", status: "deferred: typed interfaces unavailable" },
  { tier: "11-serdes", status: "deferred: typed serdes unavailable" },
] as const

// firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.4
// firegrid-remediation-hardening.CODE_REUSE.2
//
// Compatibility module only. The canonical Effect-returning state-machine
// builders live in protocol; this file intentionally contains no synchronous
// throwing wrappers.
export * from "./protocol/state-machine.ts"

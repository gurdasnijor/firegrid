# Handoff — Stabilize the unified kernel (SUPERSEDED ✅)

**This effort is COMPLETE.** The unified-kernel stabilization epic (`tf-ll90`) is done:
`#765` merged to `main`, the kernel starts/executes/spawns sessions (proven
env-robust), `createOrLoad` materializes, cancel/close + MCP-host + marker
auto-provision all landed. `main` is canonical; the `sim/unified-kernel-validation`
trunk is retired.

➡️ **Current handoff:** [`2026-06-02-bindings-cli-handoff.md`](2026-06-02-bindings-cli-handoff.md)
— the schema-projection + CLI-rebuild epic (`tf-0awo`), with the evergreen
operating lessons folded in.

The historical stabilization detail (the gap ledger, the draft-PR stack, the
sim-honesty gate, the `tf-ll90` backlog) has been removed as no-longer-relevant
cruft; it lives in git history (`git log -- docs/handoffs/2026-06-01-stabilize-unified-handoff.md`)
and the merged PRs `#770`/`#792`–`#806` if ever needed.

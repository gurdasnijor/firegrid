# _archive/

This folder is a time-boxed holding pen for wrong-shape code while the
greenfield Shape C cutover deletes it. Source:
`docs/architecture/2026-05-22-runtime-physical-target-tree.md` (Archive Rule).

## Rules

Files placed here:

- are NOT imported by target code (`events/`, `tables/`, `producers/`,
  `transforms/`, `channels/`, `subscribers/`, `composition/`);
- carry an inline `DEPRECATED` comment naming the deletion bead or wave;
- are NOT elaborated with new behavior;
- are removed mechanically once the replacing target path lands.

If a target file imports `_archive/`, the clean-room cutover has failed and
the topology check will flag it.

## Empty until populated

This folder is intentionally empty in the scaffold PR. No files are archived
yet. As Wave 2 lands the moves named in the target-tree doc's "Wave 1
Application" section, any code that cannot be deleted immediately is moved
under `_archive/<original-path>/` together with a per-file `DEPRECATED.md`
naming the bead that will delete it.

Candidates (per the target-tree doc):

- `workflow-engine/RuntimeContextWorkflowNative` / Layer
- `workflow-engine/runtime-input-deferred`
- body-driver helpers under `workflow-engine/`

The preferred greenfield endpoint is deletion, not indefinite archival.
`_archive/` is a staging area for deletion, not a compatibility layer.

# Core Matrix 2026-05-25 Data Snapshot

This folder is the checked-in analysis snapshot for run
`2026-05-25T02-28-38-461Z`.

It includes the summarized run outputs needed to review and reproduce the
experiment:

- `SCORE.md`, `FINDING.md`, and `TRACE.md` for human-readable analysis.
- `scores.json`, `run-summary.json`, and per-arm `score.json` /
  `summary.json` files for structured analysis.
- Per-arm `board-rows.json`, `final-artifact.json`, `sessions.json`, and
  `prompt.md` for qualitative inspection of the coordination traces.
- `TRACE_QUERIES.sql` as a DuckDB template for raw OTel JSONL traces from a
  fresh run.

Raw `trace.jsonl`, stdout, and stderr files are intentionally not checked in:
they are larger, local-path-heavy runtime artifacts. Re-run the experiment to
produce fresh raw traces under `.firegrid/agent-coordination-patterns/runs/`.

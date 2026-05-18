#!/usr/bin/env bash
#
# signoff-queue.sh — the decisioner's drain queue. Shows every bead awaiting
# a human decision, ranked so the load-bearing one is first, each with its
# one-line decision and where to read it, plus the exact sign-off command.
#
# This is the answer to "summarise the decision + where to read it" without a
# round-trip: it reads what the owning lane already encoded in the bead.
#
# Read-only. It never mutates beads — it prints the command for you to run.
#
# Ranking (NOT raw bv order — bv's marginal gain under-weights the keystone's
# transitive cascade):
#   1. `keystone` label   (the load-bearing gate)
#   2. in bv blockers_to_clear  (unblocks downstream)
#   3. priority            (P0 → P4)
#   4. age                 (oldest waiting first)
#
# Convention the owning lane must follow when it queues a decision:
#   br update <id> --add-label signoff:pending --add-label pr-<NNN>
#   # and append to the bead description:
#   #   === SIGNOFF ===
#   #   DECISION: <one line: what you are being asked to decide>
#   #   READ: PR#<n> <doc path> §<section>
#
# Usage:
#   bash scripts/signoff-queue.sh            # ranked digest
#   bash scripts/signoff-queue.sh --json     # structured
#   bash scripts/signoff-queue.sh show tf-qy4    # full context for one item:
#       decision + PR state + the actual SDD section(s) it references,
#       pulled verbatim from the PR head. Accepts tf-id, TFIND-NNN, or #PR.
#
set -u

for b in jq git; do command -v "$b" >/dev/null 2>&1 || { echo "signoff-queue: $b not on PATH" >&2; exit 1; }; done
RR="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "signoff-queue: not in a git repo" >&2; exit 1; }
JSONL="$RR/.beads/issues.jsonl"
[ -f "$JSONL" ] || { echo "signoff-queue: $JSONL not found" >&2; exit 1; }

FORMAT=text
MODE=digest
SEL=""
case "${1:-}" in
  --json) FORMAT=json ;;
  show)   MODE=show; SEL="${2:-}"; [ -n "$SEL" ] || { echo "usage: signoff-queue.sh show <tf-id|TFIND-NNN|#PR>" >&2; exit 1; } ;;
esac

# Print the SDD section(s) named in a READ: line, verbatim, pulled from the
# PR head (the SDD lives in the open PR, not main). Tolerant of heading shape:
# matches `## §0.1 —`, `### 7.`, etc., and bounds each at the next heading of
# same-or-higher level. Best-effort: never aborts; falls back doc→tree→diff.
show_read() { # $1 = the READ: string
  local read="$1" prn doc toks branch tmp src
  prn="$(printf '%s' "$read" | grep -oE 'PR#[0-9]+' | head -1 | tr -dc 0-9)"
  doc="$(printf '%s' "$read" | grep -oE '[A-Za-z0-9_./-]+\.md' | head -1)"
  # Section refs are §-prefixed and space/start-bounded ("… §0.1 (decision) /
  # §7 (…) / §8 (…)"). The boundary skips incidental ones like the §0 inside
  # "no-§0-reopen" (preceded by '-'). Dedupe, preserve order.
  toks="$(printf '%s' "$read" | grep -oE '(^|[ ])§[0-9]+(\.[0-9]+)*' | tr -d ' §' | awk 'NF && !seen[$0]++')"
  [ -n "$doc" ] || { echo "  (no doc path in READ: — nothing to render)"; return; }
  tmp="$(mktemp)"; src=""
  if [ -n "$prn" ] && branch="$(gh pr view "$prn" --json headRefName -q .headRefName 2>/dev/null)" \
     && [ -n "$branch" ] && git fetch -q origin "$branch" 2>/dev/null \
     && git show "FETCH_HEAD:$doc" >"$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    src="PR #$prn head ($branch)"
  elif [ -f "$RR/$doc" ]; then cp "$RR/$doc" "$tmp"; src="working tree (may differ from PR)"
  elif [ -n "$prn" ] && gh pr diff "$prn" 2>/dev/null | sed -n 's/^+//p' >"$tmp" && [ -s "$tmp" ]; then
    src="gh pr diff #$prn (+added lines only)"
  else echo "  (could not fetch $doc — read it at PR #$prn directly)"; rm -f "$tmp"; return; fi
  echo "  ── $doc · sections [$(echo "$toks" | tr '\n' ' ')] · source: $src ──"
  [ -z "$toks" ] && toks="$(printf '0\n0.1\n0.2')"
  for t in $toks; do
    awk -v tok="$t" '
      function hlvl(s,  n){ n=0; while(substr(s,n+1,1)=="#") n++; return n }
      function hid(s,  x){ x=s; sub(/^#+[ \t]*/,"",x); sub(/^§/,"",x);
        if (match(x,/^[0-9]+(\.[0-9]+)*/)) return substr(x,RSTART,RLENGTH); return "" }
      /^#{1,6}[ \t]/ {
        lvl=hlvl($0); id=hid($0)
        if (p && lvl<=sl) p=0
        if (!p && id==tok) { p=1; sl=lvl }
      }
      p { print "  | " $0 }
      END { if (!seen) {} }
    ' "$tmp" || true
    echo
  done
  rm -f "$tmp"
}

# bv blockers_to_clear membership (best-effort; empty if bv unavailable).
BLOCKERS='[]'
if command -v bv >/dev/null 2>&1; then
  BLOCKERS="$(BEADS_DIR="$RR/.beads" bv --robot-triage 2>/dev/null \
    | jq -c '[.triage.blockers_to_clear[]?.id] // []' 2>/dev/null)" || BLOCKERS='[]'
  [ -z "$BLOCKERS" ] && BLOCKERS='[]'
fi

read -r -d '' QUERY <<'JQ' || true
def field($k): (.description // "")
  | ([ split("\n")[] | select(startswith($k + ": ")) ][0] // "")
  | sub("^[A-Z]+: *"; "");
[ .[]
  | select(any(.labels[]?; . == "signoff:pending"))
  | { id, status, priority,
      pr:       ([.labels[]? | select(startswith("pr-"))][0] // null),
      tfind:    ([.labels[]? | select(startswith("tfind:"))][0] // null),
      keystone: (any(.labels[]?; . == "keystone")),
      blocking: ((.id) as $i | ($blockers | index($i)) != null),
      decision: (field("DECISION")),
      read:     (field("READ")),
      title, updated_at } ]
| sort_by([ (if .keystone then 0 else 1 end),
            (if .blocking then 0 else 1 end),
            .priority, .updated_at ])
JQ

RANKED="$(jq -s --argjson blockers "$BLOCKERS" "$QUERY" "$JSONL" 2>/dev/null)"
[ -z "$RANKED" ] && RANKED='[]'

if [ "$MODE" = show ]; then
  digits="$(printf '%s' "$SEL" | tr -dc 0-9)"
  pr=""; tf=""
  if [ -n "$digits" ]; then
    pr="pr-$digits"
    tf="tfind:$(printf '%03d' "$((10#$digits))")"
  fi
  ITEM="$(printf '%s' "$RANKED" | jq -c --arg id "$SEL" --arg pr "$pr" --arg tf "$tf" \
    'first(.[] | select(.id==$id or (.pr!=null and .pr==$pr) or (.tfind!=null and .tfind==$tf))) // empty')"
  [ -z "$ITEM" ] && { echo "signoff-queue: '$SEL' is not in the signoff queue (try: bash scripts/signoff-queue.sh)"; exit 1; }
  id="$(printf '%s' "$ITEM" | jq -r .id)"
  prl="$(printf '%s' "$ITEM" | jq -r '.pr // "no-PR"')"
  prn="$(printf '%s' "$prl" | tr -dc 0-9)"
  printf '════ %s  %s  %s  P%s%s ════\n' \
    "$id" "$prl" "$(printf '%s' "$ITEM" | jq -r '.tfind // "no-tfind"')" \
    "$(printf '%s' "$ITEM" | jq -r .priority)" \
    "$(printf '%s' "$ITEM" | jq -r 'if .keystone then "  ⟨KEYSTONE⟩" elif .blocking then "  ⟨unblocks⟩" else "" end')"
  printf '\nDECISION:\n  %s\n' "$(printf '%s' "$ITEM" | jq -r 'if (.decision|length)>0 then .decision else "⚠ NONE RECORDED — bounce back: owning lane must encode DECISION: in the bead description" end')"
  if [ -n "$prn" ]; then
    printf '\nPR #%s state (verbatim — mergeable is eventually-consistent):\n' "$prn"
    gh pr view "$prn" --json number,isDraft,state,mergeStateStatus,statusCheckRollup 2>/dev/null \
      | jq -r '"  draft=\(.isDraft) state=\(.state) mergeable=\(.mergeStateStatus) ci=\(((.statusCheckRollup//[])|map(.conclusion//.state//.status//"?")|group_by(.)|map("\(.[0]):\(length)")|join(" "))|if .==""then"none"else . end)"' 2>/dev/null \
      || echo "  (gh unavailable — read PR #$prn directly)"
  fi
  read="$(printf '%s' "$ITEM" | jq -r '.read // ""')"
  if [ -n "$read" ]; then
    printf '\nREAD: %s\n\n' "$read"
    show_read "$read"
  else
    printf '\nREAD: ⚠ none recorded — bounce back: owning lane must add READ: PR#/doc/§\n'
  fi
  printf '\nWHEN DECIDED:\n  gh pr review %s --approve --body "DECIDED: <verdict>"   # or --request-changes\n' "${prn:-<pr>}"
  printf '  br label remove %s -l signoff:pending && br label add %s -l signoff:done\n' "$id" "$id"
  printf '  # then tell the coordinator to dispatch what %s unblocked\n' "$id"
  exit 0
fi

if [ "$FORMAT" = json ]; then
  printf '%s\n' "$RANKED" | jq -c '{generated_at:(now|todate), queue:.}'
  exit 0
fi

n="$(printf '%s' "$RANKED" | jq 'length')"
printf '════ signoff queue · %s pending · %s ════\n' "$n" "$(date '+%H:%M:%S')"
[ "$n" = 0 ] && { echo "(nothing awaiting signoff)"; exit 0; }

printf '%s\n' "$RANKED" | jq -r '
  to_entries[]
  | .key as $i | .value as $v
  | "\n#\($i+1)  \($v.pr // "no-PR")  \($v.id)  \($v.tfind)  P\($v.priority)"
    + (if $v.keystone then "  ⟨KEYSTONE⟩" elif $v.blocking then "  ⟨unblocks⟩" else "" end)
    + "\n  decision: " + (if ($v.decision|length)>0 then $v.decision else "⚠ NONE RECORDED — owning lane must encode DECISION: in the bead" end)
    + "\n  read:     " + (if ($v.read|length)>0 then $v.read else "⚠ none — add READ: PR#/doc/§ to the bead" end)
    + "\n  sign off: br label remove \($v.id) -l signoff:pending   # then advance/close per the decision"
'
printf '\n════ drain top-down · keystone first ════\n'

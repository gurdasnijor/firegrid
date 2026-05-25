-- Agent Coordination trace analysis queries.
-- Usage: duckdb < TRACE_QUERIES.sql
-- Source format: Firegrid's flat OTel JSONL spans, one JSON object per line.

CREATE OR REPLACE VIEW spans AS
SELECT
  regexp_extract(filename, '.*scenarios/([^/]+)/arms/([^/]+)/trace\.jsonl$', 1) AS scenario_id,
  regexp_extract(filename, '.*scenarios/([^/]+)/arms/([^/]+)/trace\.jsonl$', 2) AS arm,
  json->>'name' AS name,
  json->>'traceId' AS trace_id,
  json->>'spanId' AS span_id,
  json->>'parentSpanId' AS parent_span_id,
  (json->'startTime'->>0)::DOUBLE * 1000 + (json->'startTime'->>1)::DOUBLE / 1e6 AS start_ms,
  (json->'duration'->>0)::DOUBLE * 1000 + (json->'duration'->>1)::DOUBLE / 1e6 AS dur_ms,
  (json->'status'->>'code')::INT AS status_code,
  json->'status'->>'message' AS status_msg,
  COALESCE(json->'attributes'->>'firegrid.side', json->'resource'->>'firegrid.process.role', 'unknown') AS side,
  json->'attributes'->>'firegrid.context.id' AS context_id,
  json->'attributes' AS attributes,
  filename
FROM read_json_objects('scenarios/*/arms/*/trace.jsonl', filename=true);

-- Arm-level health and overhead.
SELECT scenario_id, arm, count(*) AS spans,
       count(*) FILTER (WHERE status_code=2) AS errors,
       count(*) FILTER (WHERE name LIKE '%tools/call%') AS tools_call_spans,
       round(sum(dur_ms), 1) AS total_span_ms
FROM spans GROUP BY scenario_id, arm ORDER BY scenario_id, arm;

-- Span-side breakdown.
SELECT scenario_id, arm, side, count(*) AS spans, round(sum(dur_ms), 1) AS total_ms
FROM spans GROUP BY scenario_id, arm, side ORDER BY scenario_id, arm, total_ms DESC;

-- Highest-cost span families.
SELECT scenario_id, arm, name, count(*) AS spans, round(sum(dur_ms), 1) AS total_ms, round(max(dur_ms), 1) AS max_ms
FROM spans GROUP BY scenario_id, arm, name ORDER BY scenario_id, arm, total_ms DESC LIMIT 80;

-- Context lifetimes.
SELECT scenario_id, arm, context_id, count(*) AS spans,
       round(max(start_ms + dur_ms) - min(start_ms), 1) AS lifetime_ms,
       string_agg(DISTINCT side, ', ' ORDER BY side) AS sides
FROM spans WHERE context_id IS NOT NULL
GROUP BY scenario_id, arm, context_id
ORDER BY scenario_id, arm, lifetime_ms DESC;

-- Agent wire bytes; this is the agent subprocess view.
SELECT scenario_id, arm, start_ms, side,
       attributes->>'firegrid.wire.direction' AS direction,
       substr(attributes->>'firegrid.wire.raw', 1, 240) AS raw
FROM spans WHERE name LIKE '%local_process.stdout_bytes%' OR name LIKE '%local_process.stderr_bytes%'
ORDER BY start_ms;

-- Permission round-trip health.
SELECT scenario_id, arm,
  count(*) FILTER (WHERE name='firegrid.agent_event_pipeline.acp.permission_request') AS permission_requests,
  count(*) FILTER (WHERE name='firegrid.channel.host.permissions.respond.call') AS permission_respond_calls,
  count(*) FILTER (WHERE name='firegrid.agent_event_pipeline.acp.permission_response') AS permission_responses
FROM spans GROUP BY scenario_id, arm ORDER BY scenario_id, arm;

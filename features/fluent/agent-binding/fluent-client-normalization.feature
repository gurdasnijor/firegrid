@fluent @agent-binding @projection
Feature: Fluent client normalization
  Client read models are deterministic projections over immutable raw agent
  traffic. Raw protocol events remain the durable source of truth.

  Background:
    Given a durable stream containing raw events captured from a real agent

  Scenario: Raw events project into normalized events
    When the stream is normalized with the matching protocol codec
    Then the projection contains normalized assistant messages, stream deltas, tool calls, tool results, permission requests, turn completions, tool progress, session init, status changes, or unknown events as appropriate

  Scenario: Read models can be rebuilt from raw history
    When the raw stream is replayed into the session read models
    Then sessions, participants, messages, turns, tool calls, permission requests, and approval responses are materialized deterministically
    When the projection is run again over the same raw stream
    Then the read models are unchanged

  Scenario: Projection changes do not rewrite raw history
    Given an updated normalizer implementation
    When read models are re-derived
    Then no raw envelope is rewritten or deleted
    And the new projection is derived from the original raw stream

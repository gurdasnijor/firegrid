@fluent @agent-binding @projection
Feature: Fluent client normalization
  Client read models are pure projections over immutable raw agent events. Codec
  and projection changes can evolve without rewriting the durable raw stream.

  Background:
    Given a durable stream containing raw agent envelopes

  Scenario: Raw assistant messages project into normalized events
    When the client reads raw assistant output
    Then it projects assistant message events for display
    And the raw envelope remains unchanged

  Scenario: Raw tool traffic projects into tool read models
    Given raw tool call and tool update messages exist
    When projections are rebuilt
    Then tool call read models are materialized from the raw messages
    And permission request read models are materialized from the raw messages

  Scenario: Projection changes do not rewrite history
    Given a projection codec changes
    When the projection is rebuilt from the same raw stream
    Then the derived read model may change
    But the raw stream history is byte-for-byte the same durable input

  Scenario: Unknown raw events remain observable
    When the client encounters an unrecognized raw event
    Then it projects an unknown event or diagnostic view
    And it does not drop the raw event from the durable source of truth

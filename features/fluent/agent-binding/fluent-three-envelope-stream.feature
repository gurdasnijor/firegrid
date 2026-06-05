@fluent @agent-binding @stream-truth
Feature: Fluent three-envelope stream
  A fluent agent session stores user intent, raw agent output, and bridge
  lifecycle as separate durable envelope families. Raw stream history is the
  source of truth; projections are derived later.

  Background:
    Given a durable stream for one fluent session

  Scenario: User intent is durable input
    When user "alice@example.com" submits prompt "review this patch"
    Then the stream records a user envelope
    And the envelope contains the user identity
    And the envelope contains the prompt intent rather than rendered UI state

  Scenario: Agent output is recorded raw
    Given a real harness emits a native protocol message
    When the bridge observes the message
    Then the stream records an agent envelope with the raw payload
    And the raw payload is preserved before any normalized projection is written

  Scenario: Bridge lifecycle is explicit
    When the bridge starts, resumes, or ends a session
    Then the stream records a bridge lifecycle envelope
    And lifecycle state is not inferred solely from process liveness

  Scenario: Projections do not rewrite raw truth
    Given raw user, agent, and bridge envelopes already exist
    When a client projection is rebuilt
    Then the projection reads the existing envelopes
    And no raw envelope is modified to satisfy the projection

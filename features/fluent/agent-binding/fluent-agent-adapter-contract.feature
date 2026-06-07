@fluent @agent-binding @real-agent
Feature: Fluent agent adapter contract
  A fluent session binds to the agent's own native or ACP harness through a
  Firegrid harness I/O role. Firegrid only adapts I/O and durable tools; it does
  not own the reasoning loop, and the raw harness writes no durable facts itself.
  # Canon: docs/cannon/architecture/fluent/harness-io.md "One Rule";
  # docs/cannon/architecture/fluent/architecture.md invariant F-S1.

  Background:
    Given a durable stream session
    And a configured real agent adapter

  Scenario: A real harness is spawned and raw output is recorded
    When the bridge starts the session
    Then the adapter spawns the agent's native or ACP harness
    And the bridge records raw harness output before deriving projections
    And the raw harness process writes no Durable Streams facts directly
    And the session has no Firegrid-owned model invocation

  Scenario: Native turn completion controls prompt sequencing
    Given two user prompts are queued
    When the first prompt is forwarded to the harness
    Then the second prompt is not forwarded until the adapter observes the native turn-complete event

  Scenario: Harness exit becomes durable lifecycle state
    When the harness exits
    Then the stream records a session-ended lifecycle event
    And the bridge does not silently drop the dead harness

  Scenario: Fake adapters are not accepted as end-to-end proof
    Given a fake adapter that does not spawn a real harness
    When the binding experiment runs
    Then the experiment is rejected as a unit-only test path


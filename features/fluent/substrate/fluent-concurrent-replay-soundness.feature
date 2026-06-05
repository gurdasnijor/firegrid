@fluent @substrate @part-1 @replay @mutation
Feature: Fluent concurrent replay soundness
  Named journal keys are sound under concurrent Effect replay. This ratifies the
  Part 1 decision that durable steps are name-addressed rather than
  execution-order-addressed.

  Background:
    Given a fluent journal with no prior step rows
    And a handler that records observable side-effect counts

  Scenario: Concurrent named steps replay from the journal
    Given the handler issues named steps "a", "b", and "c" under unbounded Effect concurrency
    When the handler completes once
    And the same handler is re-driven against the same journal
    Then each replayed step is served from its journaled row
    And none of the side-effecting actions runs during replay
    And the replay result equals the first execution result

  Scenario: Completion order does not determine journal identity
    Given step "slow" completes after step "fast"
    And the handler awaits both steps concurrently
    When the handler is re-driven with the opposite completion order
    Then step "slow" still reads the row keyed "slow"
    And step "fast" still reads the row keyed "fast"
    And no journal miss occurs because of scheduling order

  Scenario: Positional-key mutation fails the proof
    Given the same concurrent handler is run with a positional construction counter mutation
    When the handler is re-driven under a different scheduling order
    Then at least one replayed step misses its journaled row
    And the side-effecting action for that replayed step runs again
    And the experiment verdict is red

  Scenario: Replay proof is non-vacuous
    When the concurrent replay experiment runs
    Then the trace contains a first execution epoch where side-effecting actions ran
    And the trace contains a replay epoch where journal decisions were evaluated
    And a replay-only run without the first execution epoch is rejected as insufficient evidence

  Scenario: Race winner is recorded durably
    Given two named journaled branches race
    When branch "left" wins
    Then the race winner is recorded in the journal
    And replay returns the recorded winner without re-racing live branches
    And changing branch timing on replay does not change the winner

  Scenario: Race loser policy is explicit
    Given two named journaled branches race
    When one branch wins
    Then the configured policy states whether the loser is left to finish or interrupted
    And the replay behavior follows the recorded policy
    And the default Effect race loser interruption is not inherited silently

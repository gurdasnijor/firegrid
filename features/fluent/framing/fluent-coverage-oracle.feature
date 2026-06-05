@fluent @framing @firelab @oracle
Feature: Fluent coverage oracle
  Firelab grades fluent acceptance by product-observable outcomes and
  forge-proof host-substrate evidence. Diagnostic traces help explain failures
  but are not a substitute for Then assertions.

  Background:
    Given a fluent firelab experiment

  Scenario: Acceptance uses product-observable outcomes
    When the experiment completes
    Then the verdict is based on durable stream contents, projections, resumed output, or approval shapes
    And diagnostic spans are supporting evidence only

  Scenario: Host-substrate evidence is forge-proof
    When a coverage witness references substrate events
    Then the referenced evidence is emitted by the host or durable substrate
    And a driver-only span cannot satisfy the witness

  Scenario: Mutation harness must flip red
    Given a feature has a stated mutation
    When the mutation is enabled
    Then the same acceptance scenario fails
    And a mutation that stays green invalidates the coverage proof

  Scenario: Vacuous absence is rejected
    When a claim depends on absence of an event
    Then the experiment also proves the relevant path was entered
    And an empty trace or skipped path cannot pass the claim

@fluent @agent-binding @real-agent @park
Feature: Fluent park interface
  A parking Firegrid tool ends the harness turn through the transport, then a
  later wake re-enters the harness natively.

  Background:
    Given a real harness with a Firegrid parking tool
    And a durable session stream

  Scenario: Parking tool ends the harness turn
    When the harness invokes a durable tool that must wait
    Then the binding returns a run-terminating tool result
    And the harness ends the current turn
    And the harness issues no more tool calls in that turn

  Scenario: Wake re-enters the native harness
    Given a parked tool call has recorded its durable wait intent
    When the waited-for event arrives
    Then the session is re-entered through native resume
    And the resumed harness continues the prior session

  Scenario: Model-voluntary turn ending is not accepted as proof
    Given the binding does not send a run-terminating tool result
    When the model voluntarily stops after the tool call
    Then the park interface is not considered proven


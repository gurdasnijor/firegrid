@fluent @agent-binding @park @real-agent
Feature: Fluent park interface
  A parking Firegrid tool ends the external harness turn through the harness
  transport, records durable suspension before returning, and later resumes by
  native re-entry.

  Background:
    Given a real harness with Firegrid durable tools available
    And a fluent session driven after Durable Streams delivery or claim

  Scenario: Parking records durable suspension before ending the turn
    When the harness invokes a parking durable tool
    Then the tool records its wait or timer intent durably
    And the session records that it is suspended
    And only then does the tool return the harness-specific end-of-turn response

  Scenario: Park uses the harness transport boundary
    When a durable tool parks the session
    Then the current harness turn ends through the harness-native transport
    And Firegrid does not keep a hidden model loop alive to wait in-process

  Scenario: Resume re-enters natively
    Given the parked wait later resolves
    When the fluent post-wake product actor re-drives the session
    Then the bridge resumes or re-enters the native harness
    And the resolved durable result is delivered through the harness's tool path

  Scenario: Fake transport proof is rejected
    Given a fake recorder simulates park without a real harness transport
    When the park-interface experiment runs
    Then the experiment is rejected as insufficient acceptance proof

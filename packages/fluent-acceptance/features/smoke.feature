@fluent @harness @smoke
Feature: Fluent acceptance harness smoke
  Proves the cucumber-js runner, the World, and the product-observable assertion
  style work end to end with no external infrastructure. This is a harness
  self-test, not a product-behavior acceptance proof — it exists so the pipeline
  (runner -> World -> steps -> observable Then) is known-good before real
  firelab-backed and real-agent steps are wired.

  Scenario: The stream read helper returns appended envelopes in order
    Given an in-memory durable stream
    When the bridge records a "user" envelope "hello"
    And the bridge records an "agent" envelope "hi back"
    Then the stream contents are, in order:
      | direction | payload |
      | user      | hello   |
      | agent     | hi back |

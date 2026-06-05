@fluent @harness @real-agent
Feature: Fluent real-agent lane gating
  Proves the @real-agent live-lane precondition: when the live lane is disabled
  (FIREGRID_REAL_AGENT unset), real-agent scenarios are SKIPPED with a clear
  precondition rather than failing or silently passing against a fake. A harness
  self-test for the live-lane gate — NOT a product acceptance proof. The product
  agent-binding features carry the real-spawn assertions.

  Scenario: A real-agent scenario runs only when the live lane is enabled
    Given a scenario that requires a real native or ACP agent
    Then the live real-agent lane is enabled

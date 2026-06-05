@fluent @agent-binding @approval @real-agent
Feature: Fluent approval fidelity
  Fluent preserves the native approval shape of the bound harness. Flattening
  approval into a generic allow/deny envelope is an explicit adapter decision,
  not an accidental loss of information.

  Background:
    Given a real harness that can request approvals

  Scenario: Command execution approval preserves command decision shape
    When the harness requests command execution approval
    And the user approves the command
    Then the bridge forwards the harness-native command decision shape
    And the durable stream records which request id was answered

  Scenario: File change approval preserves file decision shape
    When the harness requests file change approval
    And the user denies the change
    Then the bridge forwards the harness-native file-change decision shape
    And no generic response drops file-change-specific fields

  Scenario: Permission approval preserves scope
    When the harness requests permission approval with a scope
    And the user grants the permission
    Then the bridge forwards the permission response with its scope
    And the scope is available to replay and projection

  Scenario: User-input approval preserves structured answers
    When the harness requests structured user input
    And the user responds with answers
    Then the bridge forwards those answers in the harness-native shape
    And the response is not flattened to a boolean decision

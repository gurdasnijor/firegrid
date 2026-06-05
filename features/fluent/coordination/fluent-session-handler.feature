@fluent @coordination @handler
Feature: Fluent session handler
  handleSession materializes durable session state, provides runtime services,
  and re-enters the external harness through its adapter.

  Background:
    Given a claimed wake for a fluent session

  Scenario: A claimed wake drives the session
    When handleSession starts
    Then committed session state is materialized
    And journal, fenced writer, wake, and adapter services are available to the drive
    And the session advances under that claim

  Scenario: Parking records suspension before returning
    Given the harness calls a durable tool that must wait
    When driveHarness parks the tool call
    Then the session records the suspension durably
    And control returns to the worker without losing the wait intent

  Scenario: Completion records terminal state
    Given the harness completes the turn
    When handleSession finishes
    Then the session records terminal completion
    And the worker can safely ack the claimed wake

  Scenario: driveHarness does not own the harness loop
    When driveHarness invokes the external harness
    Then interaction goes through the adapter contract
    And Firegrid does not replace the harness's native loop

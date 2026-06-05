@fluent @agent-binding @bridge @real-agent
Feature: Fluent bridge mediation
  The bridge serializes prompts, deduplicates human responses, and translates
  interrupts without taking ownership of the external harness loop.

  Background:
    Given a real harness bound through a fluent bridge
    And a durable stream with user intent envelopes

  Scenario: Only one prompt is in flight
    Given two user prompts are queued
    When the bridge forwards the first prompt to the harness
    Then the second prompt remains queued
    And the second prompt is forwarded only after the adapter observes the native turn-complete event

  Scenario: Duplicate approval responses are ignored
    Given the harness has one pending approval request
    When two clients answer the same request id
    Then the bridge forwards only the first effective response
    And the duplicate response remains observable as user intent
    But it does not reach the harness twice

  Scenario: Interrupt cancels pending requests before native interrupt
    Given the harness has pending approval requests
    When a client sends interrupt
    Then the bridge synthesizes cancellation responses for all pending requests
    And the bridge sends the harness-native interrupt after those responses
    And the cancellation responses are recorded as effective bridge behavior

  Scenario: Terminal events are recorded before cleanup
    When the harness reports turn completion or exits
    Then the bridge records the terminal lifecycle event
    And cleanup does not erase the durable terminal evidence

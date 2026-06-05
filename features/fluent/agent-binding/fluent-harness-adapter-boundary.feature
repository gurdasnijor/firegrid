@fluent @agent-binding @adapter-boundary @real-agent
Feature: Fluent harness adapter boundary
  For ACP harnesses, Firegrid presents as the ACP client. The process owner
  supplies the ACP stream; Firegrid owns Layer 1 observation, durable tool
  dispatch, and Layer 2 commitment.

  Background:
    Given a durable stream session
    And a configured real native or ACP process owner
    And Firegrid durable tool bindings are available through Firegrid's ACP client

  Scenario: Firegrid records Layer 1 observation without owning the model loop
    When fluent-runtime drives a prompt through the ACP process owner
    Then the process owner spawns or resumes the real harness
    And the raw harness process writes no Durable Streams records directly
    And Firegrid records faithful Layer 1 harness observations
    And the session records no Firegrid-owned model invocation

  Scenario: Firegrid tool calls cross Layer 1 observation before Layer 2 commitment
    When the harness invokes a Firegrid durable tool
    Then Firegrid records the native tool call as a Layer 1 observation
    And fluent-runtime records the host-committed Layer 2 tool outcome
    And Firegrid returns the committed outcome through the harness native tool-result path
    And the process owner does not decide wait predicates, timers, child lifecycle, or execute semantics

  Scenario: Parking durable tools end the native turn only after durable intent
    When the harness invokes a parking Firegrid durable tool
    Then fluent-runtime records the wait, timer, or child intent before park
    And Firegrid returns the harness-specific end-of-turn or pending response only after the intent is durable
    And Firegrid does not keep a hidden in-process model loop alive

  Scenario: Post-wake redrive reconnects the ACP client and serves the committed result
    Given a parking durable tool has recorded intent and ended the native turn
    And Durable Streams later delivers or grants a matching wake
    When fluent-runtime re-drives the session after the wake
    Then fluent-runtime materializes the session stream before connecting the ACP client
    And the process owner resumes or re-enters the native harness
    And the recorded committed result is delivered through the native tool-result path

  Scenario: Resume does not duplicate observed Layer 1 side effects
    Given the stream contains an observed native side effect from the harness
    When the bridge restarts and resumes the session
    Then Firegrid uses native resume or explicit replay suppression for the observed side effect
    And the side effect is not executed a second time
    And any Firegrid-mediated tool call is paired with its recorded Layer 2 result

  Scenario: Cancel and interrupt preserve both native fidelity and durable evidence
    Given the harness has pending Firegrid work
    When a client cancels or interrupts the session
    Then Firegrid sends the native cancel or interrupt shape expected by the harness
    And fluent-runtime records the Firegrid cancellation, interruption, terminal, or continuation outcome durably
    And a later redrive does not duplicate observed Layer 1 side effects

  Scenario: Fake adapter evidence is rejected at the acceptance layer
    Given an adapter that records events without spawning a real native or ACP harness
    When the harness-adapter-boundary experiment runs
    Then the experiment is rejected as unit-only evidence
    And it is not accepted as end-to-end proof for fluent agent binding

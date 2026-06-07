@fluent @agent-binding @acp @real-agent
Feature: Fluent Firegrid ACP client
  Firegrid presents itself as the ACP client for ACP harnesses: the
  downstream-harness harness I/O role around the external model loop. ACP process
  packages supply the agent process and stream; Firegrid owns ACP client
  callbacks, Layer 1 observation, durable tool dispatch, and Layer 2 commitment.
  # Canon: docs/cannon/architecture/fluent/harness-io.md "One Rule",
  # "ACP Downstream Harness"; fluent-architecture.md invariant F-S1.

  Background:
    Given a real ACP agent process
    And a process owner that can expose the agent's ACP stream
    And fluent-runtime exports a Firegrid ACP client subpath

  Scenario: Firegrid owns the ACP ClientSideConnection client
    When the ACP process owner starts the agent process
    Then the process owner passes the ACP stream to fluent-runtime
    And fluent-runtime constructs the ACP ClientSideConnection with FiregridAcpClient
    And the process owner does not implement Firegrid ACP client callbacks

  Scenario: ACP session updates become Layer 1 observations through Firegrid
    When the ACP agent emits a session update
    Then FiregridAcpClient records the raw ACP update as Layer 1 observation
    And projections are derived from the recorded observation
    And the raw ACP agent process writes no Durable Streams records directly

  Scenario: ACP permission requests preserve native shape while committing Firegrid outcome
    When the ACP agent calls the client permission request method
    Then FiregridAcpClient records the permission request as Layer 1 observation
    And fluent-runtime records the durable approval, cancellation, or denial outcome
    And FiregridAcpClient returns the ACP-shaped permission response to the agent

  Scenario: Firegrid durable tools return committed results through ACP
    When the ACP agent invokes a Firegrid durable tool through the exposed tool edge
    Then Firegrid records the tool request as Layer 1 observation
    And fluent-runtime records the host-committed Layer 2 outcome
    And Firegrid returns the committed result through the ACP-compatible result path
    And the ACP process owner does not decide the tool semantics

  Scenario: ACP adapter package imports only the ACP boundary
    When the ACP process owner package is checked for Firegrid imports
    Then it imports the fluent-runtime ACP subpath
    And it does not import fluent-runtime Store, Host, EventIngress, Sources, or Durable Streams internals

  Scenario: Queryable agent schemas are projection-owned, not process-owned
    When ACP raw events are materialized for UI or firelab queries
    Then the queryable sessions, messages, turns, tool calls, permission requests, and approval rows are derived projections
    And the ACP process owner does not own or export those row schemas as adapter-core state
    And changing the projection schema does not require rewriting raw Layer 1 history

  Scenario: Non-ACP harnesses do not weaken the ACP boundary
    Given a future non-ACP native harness
    When it cannot expose an ACP stream
    Then it must lower native protocol events into the same Layer 1 and Layer 2 boundary
    And the ACP process owner path remains the preferred path for ACP harnesses

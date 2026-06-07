@fluent @agent-binding @acp @zed @real-agent
Feature: Fluent Firegrid ACP conductor
  Firegrid can be launched by Zed or another ACP editor as an external ACP
  agent. The conductor is the editor-facing harness I/O role; the client is the
  downstream-harness harness I/O role. Both are edges around the same
  fluent-runtime session authority. In that topology, Firegrid presents as an ACP
  Agent/conductor to the editor, binds ACP sessions to fluent-runtime, and may
  delegate to downstream ACP agents through the separate Firegrid ACP client path.
  # Canon: docs/cannon/architecture/fluent/harness-io.md "One Rule",
  # "Zed / Editor ACP Conductor" (no public acp.Client | acp.Agent union).

  Background:
    Given Zed or another editor is the ACP client
    And Firegrid is launched as an ACP stdio external agent
    And fluent-runtime exports a Firegrid ACP conductor subpath

  Scenario: Firegrid presents as an ACP Agent to Zed
    When Zed initializes the external agent over stdio
    Then Firegrid implements the ACP Agent interface for the editor-facing connection
    And Firegrid does not expose a public Client-or-Agent union as the primary boundary
    And Firegrid binds the ACP session to fluent-runtime session authority

  Scenario: ACP stdio mode preserves stdout protocol discipline
    When Firegrid runs in ACP stdio mode
    Then stdout contains only ACP protocol frames
    And Firegrid ready records, stream URLs, logs, and diagnostics are not written to stdout
    And diagnostics use stderr or another non-stdout side channel

  Scenario: Editor prompts become fluent-runtime session work
    When Zed sends a session prompt to Firegrid
    Then Firegrid records the accepted user intent durably
    And Firegrid drives fluent-runtime session work for the prompt
    And Firegrid reports ACP session updates back to Zed

  Scenario: Editor cancellation becomes durable Firegrid evidence
    Given an active Zed prompt turn
    When Zed sends ACP session cancel
    Then Firegrid records durable cancellation, continuation, or terminal evidence
    And Firegrid reports the ACP cancellation result through the editor-facing agent connection

  Scenario: Downstream ACP delegation uses the client role explicitly
    Given Firegrid delegates work to a downstream Claude, Codex, or custom ACP agent
    When the conductor routes to the downstream agent
    Then the downstream connection uses FiregridAcpClient
    And the editor-facing connection remains FiregridAcpConductor
    And the two ACP roles remain separate public exports

  Scenario: Firepixel conductor is prior art, not an imported product dependency
    When the Firegrid conductor implementation is designed
    Then it may reuse the Firepixel conductor ideas of explicit roles, AgentSideConnection for the outer editor, ClientSideConnection for downstream components, and ordered routing
    And production Firegrid code does not import from /Users/gnijor/gurdasnijor/firepixel

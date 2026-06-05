@fluent @agent-binding @real-agent @tools
Feature: Fluent MCP tools out
  Firegrid durable tools are exposed to the harness through the harness's own tool
  mechanism. MCP over durable streams is one transport; the non-invasive property
  is the invariant.

  Background:
    Given a real harness bound to a durable stream session
    And the Firegrid durable tool catalog is exposed to that harness

  Scenario: A real harness discovers and invokes a durable tool
    When the harness asks for available tools
    Then the Firegrid durable tool is discoverable
    When the harness invokes that tool during a turn
    Then the invocation is recorded durably
    And the invocation came through the harness's own tool-call path

  Scenario: Firegrid does not drive an owned model loop
    When a durable tool is invoked
    Then the model loop remains owned by the external harness
    And Firegrid does not inject an agent.run step to force the call

  Scenario: Tool transport is replaceable
    Given the durable tool catalog is exposed through a different compatible transport
    When the harness invokes a durable tool
    Then the durable tool semantics are unchanged


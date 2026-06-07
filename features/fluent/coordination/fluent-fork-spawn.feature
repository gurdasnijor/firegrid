@fluent @coordination @spawn
Feature: Fluent fork spawn
  Managed-agent spawn and spawn_all create durable child sessions. Parents join
  children through terminal stream facts rather than inline handler calls. A
  durable tool implemented as an authored procedure runs as a child invocation on
  its own replay-model stream, not inside the managed-session reconstruction
  stream.

  Background:
    Given a parent fluent session

  Scenario: spawn creates a child session stream
    When the parent spawns child "child-1"
    Then a child session stream exists for "child-1"
    And the child stream starts from the parent's fork point
    And the child has independent producer state
    And the parent stream records a Layer 2 child-spawn fact naming the child stream

  Scenario: Parent waits on child result event
    Given child "child-1" has been spawned
    When child "child-1" publishes terminal result "done"
    Then the child appends terminal state and closes its own stream
    And Durable Streams delivers or grants subscribed work for the parent join
    And Firegrid records one Layer 2 child_terminal resolution on the parent stream
    And the parent wait resolves with "done"
    And the parent did not inline-call the child handler

  Scenario: Cross-harness child terminal wakes parent
    Given parent session "parent-1" is driven by harness type "claude"
    And child session "child-1" is driven by harness type "codex"
    When the parent spawns child "child-1"
    And child "child-1" publishes terminal result "tests-passed"
    Then the child terminal fact wakes the parent
    And the parent resolves the child join with "tests-passed"
    And both harness adapters can be killed and resumed without duplicating observed side effects

  Scenario: spawn_all creates deterministic child identities
    When the parent spawn_all creates tasks "a", "b", and "c"
    Then each child session has a deterministic id derived from the parent tool call and slot
    And the parent can join all child result events

  Scenario: Durable tool invocation uses a child authored-procedure stream
    Given a managed session observes a tool call "execute-review"
    And the tool implementation contains authored durable primitives
    When Firegrid accepts the tool invocation
    Then the managed-session stream records Layer 1 tool-call evidence
    And the managed-session stream records a Layer 2 child invocation fact naming a child stream
    And the authored tool body runs on that child stream with keyed journal replay
    And the managed-session stream records only the committed tool result or child terminal resolution
    And Firegrid does not inline the replayable tool body into the managed-session stream

  Scenario: Child race loser policy is explicit
    Given children "fast" and "slow" race
    When "fast" publishes a terminal result first
    Then the parent records "fast" as the winner
    And the configured policy determines whether "slow" is left to finish or durably cancelled

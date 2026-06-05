@fluent @coordination @spawn
Feature: Fluent fork spawn
  Managed-agent spawn and spawn_all create durable child sessions. Parents join
  children through result events rather than inline handler calls.

  Background:
    Given a parent fluent session

  Scenario: spawn creates a child session stream
    When the parent spawns child "child-1"
    Then a child session stream exists for "child-1"
    And the child stream starts from the parent's fork point
    And the child has independent producer state

  Scenario: Parent waits on child result event
    Given child "child-1" has been spawned
    When child "child-1" publishes terminal result "done"
    Then the parent wait resolves with "done"
    And the parent did not inline-call the child handler

  Scenario: spawn_all creates deterministic child identities
    When the parent spawn_all creates tasks "a", "b", and "c"
    Then each child session has a deterministic id derived from the parent tool call and slot
    And the parent can join all child result events

  Scenario: Child race loser policy is explicit
    Given children "fast" and "slow" race
    When "fast" publishes a terminal result first
    Then the parent records "fast" as the winner
    And the configured policy determines whether "slow" is left to finish or durably cancelled


@fluent @coordination @durable-wait @cel @wake
Feature: Fluent durable wait
  wait_for and wait_any park durably by recording wait intent before suspension.
  Candidate events are matched during the drive with CEL over event and self,
  and replay resolves from recorded matches rather than from a moving world.

  Background:
    Given a fluent session with correlation data
    And a wake registry connected to durable event ingress

  Scenario: Wait intent is recorded before parking
    When the handler calls wait_for with predicate "event.type == 'review.posted'"
    Then a WaitIntent record is appended before the handler parks
    And the record contains the predicate
    And the record contains the afterOffset used for catch-up scanning

  Scenario: Catch-up scan prevents lost wakeups
    Given a matching event is appended after the handler computes afterOffset
    And before the handler fully parks
    When the handler evaluates the wait
    Then the catch-up scan sees the matching event
    And the wait resolves without requiring another external append
    And the event is recorded as the matched event for replay

  Scenario: Non-matching wake re-suspends the handler
    Given the handler waits for "event.type == 'github.pr'"
    When an event with type "github.issue" is appended
    Then the worker re-drives the handler
    And the CEL predicate evaluates to false
    And the wait remains pending with its original intent

  Scenario: Matching wake resolves from CEL predicate
    Given the handler waits for "event.type == 'github.pr' && event.value.state == 'merged'"
    When an event with type "github.pr" and state "merged" is appended
    Then the CEL predicate evaluates to true with bindings event and self
    And the wait resolves with that event
    And the matched event is journaled

  Scenario: Match shorthand desugars to event self equality
    Given the handler calls wait_for with match path "value.issueId"
    And self.value.issueId is "42"
    When an event has value.issueId "42"
    Then the wait resolves as if the predicate were "event.value.issueId == self.value.issueId"

  Scenario: self binding is a recorded correlation snapshot
    Given the handler waits for "event.value.repo == self.repo"
    And self.repo is "firegrid" when the wait intent is recorded
    And the live session projection later changes self.repo to "other"
    When an event has value.repo "firegrid"
    Then the CEL predicate evaluates against the recorded self binding
    And the wait resolves with that event
    And replay does not rebuild self from the newer projection

  Scenario: Replay does not re-evaluate against the live world
    Given a wait has already resolved with matched event "e1"
    And a newer event "e2" would also satisfy the predicate
    When the handler is re-driven
    Then the wait resolves from journaled event "e1"
    And the predicate is not re-evaluated to choose "e2"

  Scenario: Bounded wait records exactly one winner
    Given a wait_for is bounded by a timeout
    When the event and timeout race
    Then exactly one winner is recorded in the journal
    And replay returns the recorded winner
    And the losing branch does not resolve the same wait later

  Scenario: wait_any preserves deterministic slot identities
    When the handler calls wait_any with three predicates from one tool call
    Then each wait slot is keyed by the tool call id and slot index
    And a matching event resolves the corresponding slot
    And replay does not depend on the order the slots were evaluated

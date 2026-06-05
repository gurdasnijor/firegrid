@fluent @coordination @ingress
Feature: Fluent event ingress
  External webhooks and producer events enter fluent as fenced durable appends
  and use the same wake registry as approvals, tool results, and timers.

  Background:
    Given a fluent event ingress endpoint
    And a session waiting for external events

  Scenario: External delivery becomes a durable event
    When an external system posts event "review.posted" with delivery id "d-1"
    Then the event is appended as a durable state change
    And the append carries producer fencing data or equivalent delivery-id idempotency

  Scenario: Duplicate delivery is deduplicated
    Given delivery "d-1" has already been appended
    When the external system retries delivery "d-1"
    Then the event is not appended a second time
    And no wait is resolved twice

  Scenario: Matching webhook wakes a waiting session
    Given a session waits for "review.posted"
    When an external "review.posted" event is appended
    Then the wake registry records a match for the waiting session
    And the session is eligible for redrive

  Scenario: Non-matching webhook does not wake unrelated waits
    Given a session waits for "github.pr"
    When an external "github.issue" event is appended
    Then the wait remains pending

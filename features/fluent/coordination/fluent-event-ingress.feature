@fluent @coordination @ingress
Feature: Fluent event ingress
  Provider deliveries and producer events enter fluent as fenced durable appends.
  Durable Streams owns wake delivery; Firegrid owns the product match recorded
  after delivery or claim.

  Background:
    Given a fluent event ingress endpoint
    And a session waiting for external events

  Scenario: Accepted external delivery becomes a durable event
    When an external system posts event "review.posted" with delivery id "d-1"
    Then the event is appended as a durable state change
    And the append carries producer fencing data or equivalent delivery-id idempotency

  Scenario: Duplicate delivery is deduplicated
    Given delivery "d-1" has already been appended
    When the external system retries delivery "d-1"
    Then the event is not appended a second time
    And no wait is resolved twice

  Scenario: Matching provider event records a wait match
    Given a session waits for "review.posted"
    When an external "review.posted" event is appended
    And Durable Streams delivers or grants subscribed work
    Then Firegrid records a wait_matched fact for the waiting session
    And the session can be redriven from that recorded match

  Scenario: Non-matching provider event does not match unrelated waits
    Given a session waits for "github.pr"
    When an external "github.issue" event is appended
    Then the wait remains pending

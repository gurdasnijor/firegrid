@fluent @coordination @taxonomy
Feature: Fluent coordination taxonomy
  Fluent coordination facts are durable state-protocol changes keyed by explicit
  ids. Addressing work is not the same as calling another session.

  Background:
    Given the fluent coordination core is available

  Scenario: Coordination facts are typed durable changes
    When a run, tool call, inbox item, child status, wake, tag, or error changes
    Then the change is recorded as a durable state-protocol message
    And the message has an explicit stable key

  Scenario: Sending addresses an event, not a synchronous call
    When session "parent" sends work to session "child"
    Then the parent appends an addressed event
    And the child decides what to do when it wakes
    And the parent does not synchronously execute the child handler

  Scenario: Candidate wake facts compose with Durable Streams wake delivery
    When a timer fires, an external event arrives, or a child publishes a result
    Then each source appends a durable change
    And Durable Streams delivers or grants subscribed work
    And Firegrid records post-wake eligibility or outcome as a durable change

  Scenario: Tags name durable offsets
    When a client tags a session state as "before-risky-action"
    Then the tag records a stream identity and offset
    And later reads can address that named point without copying state

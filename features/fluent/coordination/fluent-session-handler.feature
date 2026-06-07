@fluent @coordination @handler
Feature: Fluent session handler
  handleSession materializes committed stream state after Durable Streams
  delivers or grants work, then drives the external harness through its adapter.
  It never owns or replaces the harness loop, and it never owns substrate lease,
  cursor, pull-queue, retry, or webhook-wake mechanics.

  Background:
    Given Durable Streams has delivered or granted work for a fluent session
    And the session has committed durable stream history

  Scenario: Handler materializes committed state before driving
    When handleSession starts after delivery or claim
    Then it reads committed session stream history
    And it builds the journal and wake context from that history
    And it does not use the subscription acked offset as the replay boundary
    And it uses the acked offset only to materialize candidate source facts for the claimed wake

  Scenario: Handler drives the external harness through the adapter
    When the session has work to deliver to the harness
    Then handleSession calls the configured adapter
    And the adapter interacts with the external harness
    And handleSession does not call an owned agent.run loop

  Scenario: Parking is recorded before return
    When the harness parks on a durable tool
    Then handleSession records the durable parking state
    And handleSession returns without waiting in-process

  Scenario: Post-claim drive appends product outcome before ack
    When handleSession runs under a Durable Streams-granted claim
    Then it materializes session facts from durable streams
    And it evaluates Firegrid product semantics for waits, timers, children, or tool results
    And it appends one Layer 2 product outcome before acking or doning the wake
    And if the append fails it does not report successful progress to Durable Streams
    And it does not implement an alternate claim, lease, cursor, or retry mechanism

  Scenario: Terminal completion closes the turn
    When the harness reaches terminal completion
    Then handleSession records terminal output
    And the finite turn stream is closed or otherwise marked with a durable terminal fact

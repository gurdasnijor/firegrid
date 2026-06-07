@fluent @coordination @durable-sleep @wake
Feature: Fluent durable sleep
  sleep and wait_until park durably by recording timer intent before suspension.
  A timer source materializes time as a durable append, and normal wake delivery
  redrives the session. Durable Streams owns wake claim, lease, cursor, retry,
  and delivery; Firegrid owns timer intent, fired-time product facts, and the
  post-claim resolution.

  Background:
    Given a fluent session with a durable journal
    And a timer source integrated with Durable Streams wake delivery

  Scenario: Timer intent is recorded before the handler parks
    When the handler calls sleep until time "T"
    Then a TimerScheduled record is appended before the handler suspends
    And the record contains the sleep key and target time "T"
    And the handler does not rely on a process-local sleep to remember the timer

  Scenario: Timer source materializes the wake
    Given a TimerScheduled record exists for time "T"
    When time "T" arrives
    Then the append-at-T timer source appends a TimerFired record
    And Durable Streams delivers or grants work for the subscribed session
    And the TimerFired append is distinguishable from a driver-forged observation

  Scenario: Sleep resumes from the journal after restart
    Given the handler parked on a TimerScheduled record
    And the process exits before time "T"
    When Durable Streams grants a wake claim after TimerFired is appended
    Then the post-claim product actor materializes the session facts from the provided offsets
    And Firegrid appends one Layer 2 timer_fired or sleep resolution fact
    And Firegrid acks or dones the wake only after that resolution is durable
    And the sleep resolves from the recorded TimerFired resolution
    And no process-local timer state is required

  Scenario: Replaying an already fired sleep does not reschedule
    Given TimerScheduled and TimerFired records already exist for sleep key "s1"
    When the handler is re-driven
    Then sleep key "s1" resolves from the journal
    And no duplicate TimerScheduled record is appended
    And no duplicate TimerFired record is required

  Scenario: wait_until uses the same durable mechanism
    When the handler calls wait_until for an absolute timestamp
    Then it records timer intent before parking
    And the append-at-T source materializes time as a durable TimerFired event
    And it resumes only after Firegrid records the Layer 2 timer resolution
    And it does not fabricate firedAt from a local client or worker clock

  Scenario: Timer source does not own session resume
    Given a TimerScheduled record exists for session "s1"
    When the append-at-T source appends TimerFired for session "s1"
    Then the timer source does not call the session handler directly
    And Durable Streams wake delivery decides which post-claim actor may work
    And Firegrid performs materialize, resolution append, and ack after the wake is claimed

  Scenario: Process-local sleep mutation fails the proof
    Given durable sleep is replaced by a process-local sleep mutation
    When the process exits before the target time
    Then no durable TimerFired record can wake the session
    And the experiment verdict is red

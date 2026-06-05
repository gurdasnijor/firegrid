@fluent @substrate @durable-streams @consumer @pull-wake @webhook
Feature: Fluent Durable Streams consumer substrate
  Fluent-runtime builds wake/redrive on Durable Streams named consumers,
  pull-wake, webhook wake, and producer-fenced coordination rather than
  rebuilding lease, cursor, queue, retry, or task-claim machinery.

  Background:
    Given a Durable Streams server with named consumer support
    And the upstream Durable Streams consumer conformance suite is available

  Scenario: Upstream L1 named consumer conformance is the substrate gate
    When the fluent runtime substrate package is validated
    Then it runs the upstream named consumer conformance suite against the chosen Durable Streams server
    And the suite covers registration, idempotent registration, acquire, ack, release, stale epoch, offset regression, and delete
    And fluent-runtime does not implement a separate durable lease table
    And fluent-runtime does not implement a separate durable cursor store

  Scenario: Pull-wake conformance is the worker fleet gate
    When the fluent runtime substrate package is validated
    Then it runs the upstream pull-wake conformance suite against the chosen Durable Streams server
    And the suite covers wake events, claimed events, no wake while reading, persisted cursors, lease-expiry re-wake, and competing worker claims
    And fluent-runtime does not implement a custom pull queue
    And fluent-runtime does not implement custom worker-ownership fencing

  Scenario: Webhook wake conformance is the serverless wake gate
    When the fluent runtime substrate package is validated
    Then it runs the upstream webhook conformance suite against the chosen Durable Streams server
    And the suite covers subscription delivery, signed notification, callback, ack, done, retry, and idle transitions
    And fluent-runtime does not implement a custom webhook retry loop
    And fluent-runtime does not treat provider webhooks and Durable Streams webhook wakes as the same protocol event

  Scenario: Claimed wake handler is the only fluent-runtime worker primitive
    Given a Durable Streams named consumer has pending work
    When a fluent worker acquires the consumer epoch
    Then Durable Streams owns the lease, token, acked offsets, retry, and re-wake behavior
    And fluent-runtime reads from the acquired offsets
    And fluent-runtime materializes Firegrid session facts
    And fluent-runtime appends Layer 2 coordination outcomes
    And fluent-runtime acks or dones the substrate wake only after the durable outcome is recorded

  Scenario: Product waits compose above the substrate
    Given a fluent session records a wait_for intent before parking
    And a candidate state-change fact is appended to a subscribed stream
    When Durable Streams wakes a named consumer
    And a fluent worker acquires the wake
    Then the worker evaluates the Firegrid CEL predicate against event and self
    And the worker records the wait match as a Layer 2 session fact
    And the worker does not ask Durable Streams to understand the CEL predicate

  Scenario: Producer-fenced coordination handles task claims
    Given multiple actors can execute the same tool task
    When they attempt to claim the task
    Then every actor uses the same task-derived Producer-Id
    And every first claim attempt uses Producer-Epoch 0 and Producer-Seq 0
    And only the actor whose append is stored executes the task
    And losing or duplicate actors read the recorded claim instead of executing

  Scenario: Epoch override handles recovery, not normal ownership
    Given a task claim is stale according to product policy
    When a recovery actor intentionally bumps the producer epoch
    Then the recovery claim starts at Producer-Seq 0 for the new epoch
    And stale actors using the older epoch are fenced
    And the override is recorded as an auditable stream fact

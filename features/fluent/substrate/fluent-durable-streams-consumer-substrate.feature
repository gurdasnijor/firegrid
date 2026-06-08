@fluent @substrate @durable-streams @consumer @pull-wake @webhook
Feature: Fluent Durable Streams consumer substrate
  The Firegrid host builds product wake/redrive on Durable Streams named
  consumers, pull-wake, webhook wake, and producer-fenced coordination rather
  than rebuilding lease, cursor, queue, retry, scheduled-wake,
  predicate-subscription, or task-claim machinery. Upstream Durable Streams
  conformance is an imported substrate prerequisite; Firegrid acceptance asserts
  product use of those primitives after a DS-granted wake.

  Background:
    Given a Durable Streams server with named consumer support
    And the upstream Durable Streams consumer conformance suite is available as an imported prerequisite

  Scenario: Two execution models share one consumer substrate
    Given an authored procedure is parked on a durable primitive
    And a managed session is parked on a durable tool exchange
    When Durable Streams delivers or grants subscribed work for either unit
    Then both use the same named-consumer, pull-wake, webhook-wake, claim, ack, release, and producer-fencing substrate
    And the authored procedure continues by replaying its Effect body through journal hits
    And the managed session continues by reconstructing native harness state from stream facts
    And the Firegrid host does not create a second substrate for either model

  Scenario: Upstream L1 named consumer conformance is the substrate prerequisite
    When the selected Durable Streams dependency is admitted for Firegrid host use
    Then the imported prerequisite includes the upstream named consumer conformance suite against the chosen Durable Streams server
    And that suite covers registration, idempotent registration, acquire, ack, release, stale epoch, offset regression, and delete
    And the Firegrid host does not implement a separate durable lease table
    And the Firegrid host does not implement a separate durable cursor store

  Scenario: Pull-wake conformance is the worker fleet prerequisite
    When the selected Durable Streams dependency is admitted for Firegrid host use
    Then the imported prerequisite includes the upstream pull-wake conformance suite against the chosen Durable Streams server
    And that suite covers wake events, claimed events, no wake while reading, persisted cursors, lease-expiry re-wake, and competing worker claims
    And the Firegrid host does not implement a custom pull queue
    And the Firegrid host does not implement custom worker-ownership fencing

  Scenario: Webhook wake conformance is the serverless wake prerequisite
    When the selected Durable Streams dependency is admitted for Firegrid host use
    Then the imported prerequisite includes the upstream webhook conformance suite against the chosen Durable Streams server
    And that suite covers subscription delivery, signed notification, callback, ack, done, retry, and idle transitions
    And the Firegrid host does not implement a custom webhook retry loop
    And the Firegrid host does not treat provider webhooks and Durable Streams webhook wakes as the same protocol event

  Scenario: Post-claim product step is the only Firegrid host wake primitive
    Given a Durable Streams named consumer has pending work
    When Durable Streams grants a claim to a fluent post-claim actor
    Then Durable Streams owns the claim, lease, token, acked offsets, retry, and re-wake behavior
    And the Firegrid host reads from the acquired offsets
    And the Firegrid host materializes Firegrid session facts
    And the Firegrid host appends one Layer 2 coordination outcome for the product decision
    And the Firegrid host acks or dones the substrate wake only after the durable outcome is recorded

  Scenario: Product waits compose above named substrate contracts
    Given a fluent session records a wait_for intent before parking
    And the intent records the CEL predicate and self snapshot or recorded reference
    And a candidate state-change fact is appended to a subscribed stream
    When Durable Streams wakes a named consumer
    And Durable Streams grants a wake claim to a fluent post-claim actor
    Then a named wait-matcher contract evaluates the Firegrid CEL predicate against event and recorded self
    And the post-claim actor records the wait match as a Layer 2 session fact
    And a generic predicate matcher must be specified as substrate or substrate-adapter behavior before the Firegrid host depends on it

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

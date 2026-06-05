@fluent @substrate @post-claim @redrive
Feature: Fluent post-claim redrive
  Fluent post-claim actors use Durable Streams-granted claims to drive product
  progress. Claim contention, stale-generation fencing, cursors, retry, and
  wake reissue are Durable Streams conformance concerns, not fluent-runtime
  mechanisms.

  Background:
    Given Durable Streams has granted a wake claim for a fluent session

  Scenario: Durable Streams owns claim contention
    When two actors compete for the same wake
    Then Durable Streams grants at most one active claim
    And fluent-runtime does not implement a second ownership or lease table

  Scenario: Post-claim drive materializes durable state
    When a post-claim actor drives under the granted claim
    Then it materializes committed session state
    And it reads replay data from the session journal or snapshot source
    And it does not use the subscription acked offset as the replay boundary

  Scenario: Restarted drive does not repeat journaled side effects
    Given a side effect already has a journaled result
    When a post-claim actor restarts and re-drives the session
    Then the side effect result is replayed
    And the side effect is not executed again

  Scenario: Ack happens only after durable product outcome
    When the post-claim actor records a Layer 2 outcome
    Then it acks or dones through Durable Streams after that append succeeds
    And if the append fails, it does not ack successful product progress

  Scenario: Mid-turn arrivals rely on substrate re-wake
    Given new work arrives while a claimed drive is running
    When the post-claim actor acks or dones the current wake
    Then subsequent delivery is handled through Durable Streams wake semantics
    And fluent-runtime does not maintain a custom pending-work queue

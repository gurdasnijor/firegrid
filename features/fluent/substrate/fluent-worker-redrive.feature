@fluent @substrate @post-claim @redrive
Feature: Fluent post-claim redrive
  Fluent post-claim actors use Durable Streams-granted claims to drive product
  progress. Claim contention, stale-generation fencing, cursors, retry, and
  wake reissue are Durable Streams conformance concerns, not fluent-runtime
  mechanisms. Firegrid's responsibility begins after the claim: materialize
  stream facts, append one Layer 2 product outcome, continue the appropriate
  execution model, and ack/done only after the durable outcome succeeds.

  Background:
    Given Durable Streams has granted a wake claim for a fluent session

  Scenario: Durable Streams owns claim contention
    When two actors compete for the same wake
    Then Durable Streams grants at most one active claim
    And Durable Streams owns the active lease, generation, retry, and re-wake behavior
    And fluent-runtime does not implement a second ownership, lease, cursor, or pull-queue table

  Scenario: Post-claim drive materializes durable state
    When a post-claim actor drives under the granted claim
    Then it materializes committed session state
    And it reads replay or reconstruction data from the session journal or snapshot source
    And it does not use the subscription acked offset as the replay boundary
    And it uses the provided offsets only to read candidate source facts for the claimed wake

  Scenario: Restarted drive does not repeat journaled side effects
    Given a side effect already has a journaled result
    When a post-claim actor restarts and re-drives the session
    Then the side effect result is replayed
    And the side effect is not executed again

  Scenario: Ack happens only after durable product outcome
    When the post-claim actor records a Layer 2 outcome
    Then it acks or dones through Durable Streams after that append succeeds
    And if the append fails, it does not ack successful product progress

  Scenario Outline: Redrive continuation follows the execution model
    Given the post-claim actor has appended the durable product outcome
    When the claimed unit is a <model>
    Then Firegrid continues by <continuation>
    And already-observed Layer 1 side effects are not re-executed

    Examples:
      | model              | continuation                                                                        |
      | authored procedure | re-driving the Effect body so journal hits carry it past the resolved primitive     |
      | managed session    | reconstructing native harness state from stream facts and resuming through harness I/O |

  Scenario: Mid-turn arrivals rely on substrate re-wake
    Given new work arrives while a claimed drive is running
    When the post-claim actor acks or dones the current wake
    Then subsequent delivery is handled through Durable Streams wake semantics
    And fluent-runtime does not maintain a custom pending-work queue

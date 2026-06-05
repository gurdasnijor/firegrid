@fluent @substrate @worker
Feature: Fluent worker redrive
  Workers use Durable Streams subscription claim, ack, release, and generation
  fencing to drive sessions exactly under server-owned leases.

  Background:
    Given a Durable Streams subscription wake for a fluent session

  Scenario: Only the claimed worker drives
    When worker "a" claims the wake
    And worker "b" attempts to claim the same wake
    Then worker "a" drives the session
    And worker "b" observes that the wake is already claimed
    And worker "b" does not drive the session

  Scenario: Claimed drive materializes durable state
    When a worker drives under a claim
    Then it materializes committed session state
    And it reads replay data from the session journal or snapshot source
    And it does not use the subscription acked offset as the replay boundary

  Scenario: Restarted drive does not repeat journaled side effects
    Given a side effect already has a journaled result
    When a worker restarts and re-drives the session
    Then the side effect result is replayed
    And the side effect is not executed again

  Scenario: Stale ack is fenced
    Given worker "a" loses its lease generation
    When worker "a" attempts to ack the wake
    Then the ack is rejected
    And delivery state is not advanced by the stale worker

  Scenario: Mid-turn arrivals schedule another wake
    Given new work arrives while a claimed drive is running
    When the worker acks the current wake
    Then the ack reports that another wake is pending


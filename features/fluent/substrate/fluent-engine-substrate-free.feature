@fluent @substrate @part-1 @effect-native
Feature: Fluent engine substrate-free Effect core
  Fluent collapses the Restate-shaped Operation/Future DSL onto Effect. The
  durable execution core is an Effect program that receives journal services at
  the handler edge; it is not a second scheduler, a Durable Streams client, or
  a deployment process.

  Background:
    Given a fluent session stream
    And a Journal service backed by a fenced writer for that stream

  Scenario: A named journal step is a plain Effect
    When a handler builds a journaled step named "classify" from an Effect action
    Then the journaled step is itself an Effect
    And executing the step records the result under journal key "classify"
    And re-executing the same handler serves key "classify" from the journal

  Scenario: The engine does not require a bespoke generator driver
    When a handler composes journaled steps inside Effect.gen
    Then the handler is driven by Effect's runtime
    And no fluent Scheduler drive loop is required to advance the handler
    And no module-global current scheduler slot is required to find the journal

  Scenario: Durability enters through services at the handler edge
    When a session handler starts
    Then it provides the session stream identity
    And it provides a fenced writer scoped to that session stream
    And it provides a Journal service built from that fenced writer
    And the Effect body does not import Durable Streams or a deployment package directly
    And any implementation package that imports Durable Streams is outside the authoring engine

  Scenario: Effect composition replaces Future combinators
    When a handler starts two named journaled steps concurrently
    Then the handler composes them with Effect concurrency primitives
    And spawned local work is represented by Effect fibers
    And joining local work does not create a durable child session

  Scenario: Journaled failures preserve typed error boundaries
    Given a named journal step fails with a schema-encodable domain error
    When the handler is re-driven
    Then the journaled failure is decoded from the journal
    And the side-effecting action is not executed again
    And in-process control errors are not written as domain journal rows

  Scenario: Journaled success values decode through declared schemas
    Given a named journal step records a schema-encodable success value
    When the handler is re-driven
    Then the replayed payload is decoded through the declared value schema
    And malformed or version-incompatible journal payloads fail as journal boundary errors
    And the engine does not return replayed payloads with an unchecked unknown-to-domain cast

  Scenario: Positional counters are not part of the durable engine contract
    When a handler defines named journal steps
    Then the journal key for each step is supplied by the caller or tool call
    And the key does not depend on a mutable construction-time step counter
    And inserting an unrelated step does not shift existing journal keys

  Scenario: Durable authoring owns deterministic effect services
    Given a fluent-firegrid handler reads time or random values that affect later control flow
    When the handler is executed under the durable authoring environment
    Then Clock and Random reads are provided through journaled Effect services
    And raw Date, Math.random, crypto randomness, or nondeterministic step keys are lint-backed boundary violations
    And Clock.sleep is not treated as a durable timer unless lowered through a named Durable Streams substrate timer contract

  Scenario: Retry lives inside the journaled run action
    Given a named journal step performs a retryable side effect
    When the side effect is retried
    Then the retry schedule is inside the Effect action passed to run
    And only the terminal success or typed failure is written to the journal
    And replay does not retry around a recorded run result

  Scenario: Compensation can be a run-backed finalizer
    Given a handler performs multiple durable side effects
    When a later side effect fails or the handler is interrupted
    Then Effect finalizers or onError paths can run compensation
    And compensation that must be replay-stable is itself recorded as a named run step
    And finalizer-backed compensation does not introduce a separate compensation scheduler

  Scenario: Effect owns local concurrency while durable sessions stay outside the authoring core
    When a handler forks, races, or interrupts local work
    Then the local lifetime is represented by Effect fibers, scopes, and interruption
    And joining local work does not create or join a durable child session
    And durable child sessions, external harness-loop spawn, and cross-session wakeup remain outside fluent-firegrid until their Durable Streams substrate contracts are specified

  Scenario: Durable tool bodies run on child streams
    Given an external durable parent invokes a durable tool whose implementation is an authored procedure
    When an external runner accepts the tool invocation
    Then the parent stream records the tool call and child invocation facts
    And the authored tool body runs with its own Journal service on a child stream
    And the parent stream receives only the committed child terminal or tool result fact
    And the fluent engine does not inline the child authored procedure into the parent handler

  Scenario: Journal write path preserves concurrent step semantics
    Given multiple named run steps append journal rows concurrently
    When the writer strategy is selected for the invocation stream
    Then the strategy must not impose a caller-visible positional ordering contract on named steps
    And any producer fencing, epoch, or flush behavior is handled as a substrate write-path decision
    And the authoring engine contract remains open for the dedicated producer/write-path hardening slice

  Scenario: Missing substrate features block deployment binding rather than expanding the engine
    Given an authored primitive needs durable wait, durable sleep, scheduled trigger, or cross-session wakeup
    When Durable Streams does not yet expose the required substrate contract
    Then fluent-firegrid records the primitive as a deferred authoring capability
    And no deployment binding may implement a parallel substrate inside the authoring package
    And the missing contract is specified at the Durable Streams or substrate-adapter layer first

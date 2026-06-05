@fluent @substrate @part-1 @effect-native
Feature: Fluent engine substrate-free Effect core
  Fluent collapses the Restate-shaped Operation/Future DSL onto Effect. The
  durable execution core is an Effect program that receives journal services at
  the handler edge; it is not a second scheduler and it does not import the old
  runtime.

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
    And the Effect body does not import durable-streams or the legacy runtime directly

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

  Scenario: Positional counters are not part of the durable engine contract
    When a handler defines named journal steps
    Then the journal key for each step is supplied by the caller or tool call
    And the key does not depend on a mutable construction-time step counter
    And inserting an unrelated step does not shift existing journal keys

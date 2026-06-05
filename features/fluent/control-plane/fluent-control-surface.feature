@fluent @control-plane
Feature: Fluent control surface
  External control of fluent entities is product spelling over durable stream
  facts: clients send addressed input, name points in a stream, fork new entities
  from those points, and read projections. Every control operation is expressed
  against the durable stream; reads never become a second source of truth.

  Background:
    Given a fluent entity control API over durable streams

  Scenario: Send appends an addressed durable event without invoking a handler
    When a client sends event "hello" to entity "session-1"
    Then entity "session-1" has an addressed durable event "hello"
    And no entity handler is invoked synchronously by the send request
    And the event is delivered through the durable stream, not a direct call

  Scenario: Tag names a durable point in an entity stream
    Given entity "session-1" has durable events "A" and "B"
    When a client tags entity "session-1" at its current point as "before-c"
    Then the tag "before-c" resolves to the stream offset after "A" and "B"
    And the tag is a stable address usable as a fork point or read anchor

  Scenario: Fork creates a new entity from a tag, preserving the source prefix
    Given entity "session-1" has durable events "A" and "B"
    And entity "session-1" has a tag "before-c" at its current point
    When a client forks entity "session-1" at tag "before-c" as "session-2"
    Then entity "session-2" starts from the source prefix "A" and "B"
    When entity "session-1" later appends "C"
    Then entity "session-2" does not inherit "C"
    When entity "session-2" appends "D"
    Then entity "session-1" does not observe "D"

  Scenario: Fork can branch from an explicit offset
    Given entity "session-1" has durable events "A", "B", and "C"
    When a client forks entity "session-1" at the offset after "A" as "session-3"
    Then entity "session-3" starts from the source prefix "A"
    And entity "session-3" does not inherit "B" or "C"

  Scenario: Read returns a projection derived from durable facts
    Given entity "session-1" has durable events "A" and "B"
    When a client reads entity "session-1"
    Then the read response is a projection derived from the durable events
    And the read plane is not a second source of truth

  Scenario: Get and head reflect only what the durable stream contains
    Given entity "session-1" has durable events "A" and "B"
    When a client gets entity "session-1"
    Then the returned state matches the projection of "A" and "B"
    When a client requests head metadata for entity "session-1"
    Then the head reflects the entity's current durable stream point
    And neither get nor head returns state absent from the durable stream

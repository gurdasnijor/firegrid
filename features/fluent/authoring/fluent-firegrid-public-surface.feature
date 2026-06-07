@fluent @authoring @fluent-firegrid @public-surface
Feature: Fluent Firegrid public authoring surface
  @firegrid/fluent-firegrid exposes the user-facing authoring DSL for fluent
  workflows. It mirrors the useful restate-sdk-gen affordances while keeping
  deployment, entity addressing, and external control concerns outside the
  authoring package until the Durable Streams substrate contracts are settled.

  Scenario: Application authors define product behavior before deployment topology
    When an application author chooses fluent-firegrid
    Then the first design surface is typed handler definitions and Effect bodies
    And the authoring package names the product commands, inputs, outputs, and durable step keys
    And it does not require a Durable Streams endpoint, consumer id, wake stream, lease, worker pool, or HTTP listener
    And Durable Streams substrate contracts are selected or specified before any deployment binding is designed

  Scenario: Definitions are the public package entrypoint
    When an author defines a service, object, or workflow
    Then the definition names the target and its handlers
    And the definition does not start a server, open an HTTP listener, or connect to an external control API
    And the definition can be handed to an external runner, test harness, or deployment binding later

  Scenario: Definitions carry enough metadata for later binding
    Given an external runner binds a fluent-firegrid definition
    When the runner exposes product send, call, observe, or entity addressing for that definition
    Then it can derive the entity kind, entity name, handler names, and handler input and output contracts from the definition
    And it can route addressed input to the selected handler without importing fluent-firegrid internals
    And missing binding metadata is treated as a public-surface gap

  Scenario: Generator handlers compose with free primitives
    Given a service handler is written as a generator function
    When the handler uses run, all, race, select, or spawn
    Then the handler body reads as workflow logic without a handler ctx parameter
    And the free primitives compose with Effect values
    And the author does not pass an ops object or current scheduler explicitly

  Scenario: run records named journal steps
    When an author calls run with an explicit name or named action
    Then the step identity is the stable name
    And replay resolves the step from the journal by that name
    And the side-effecting action is not re-executed for an already journaled name

  Scenario: run declares replay schemas at the journal boundary
    When an author calls run for a step that records a success value or typed failure
    Then the public authoring surface accepts an explicit value schema for replayed successes
    And it accepts an explicit error schema for replayed typed failures
    And replay decodes recorded journal payloads through those schemas before returning them to the handler
    And replay does not recover values or errors by casting an unknown payload to the handler type

  Scenario: Missing step names fail at the authoring boundary
    When an author calls run with an anonymous action and no explicit name
    Then fluent-firegrid rejects the step before executing the action
    And the failure explains that a journal-entry name is required

  Scenario: Effect owns local composition
    When an author composes concurrent or spawned local work
    Then all, race, select, and spawn are Effect-shaped helpers
    And fluent-firegrid does not expose a bespoke Future scheduler as the public model
    And durable child-session spawn remains outside the authoring core until its Durable Streams substrate contract is specified
    And external harness-loop spawn remains outside fluent-firegrid because those loops are not authored Effect bodies

  Scenario: retry and compensation are authored inside Effect
    When an author needs retryable or compensating durable work
    Then retry policies are applied inside the run action whose terminal result is journaled
    And retrying around an already journaled run is rejected by examples and tests as the wrong replay model
    And compensation is expressed with Effect finalizers or onError paths whose compensating side effects may themselves be run-backed steps

  Scenario: Handler-edge execution is explicit and lower-level
    Given an external runner has selected durable identity and producer identity
    When the runner invokes a fluent-firegrid handler
    Then it supplies the journal execution context at the handler edge
    And execute or invoke drives the authored body against that journal
    And this binding does not define a deployment or control API
    And the runner does not need a scheduler, awaitable, or journal implementation export from fluent-firegrid to perform the invocation

  Scenario: Descriptor helpers are public type-level API
    When an author declares handler input and output contracts
    Then fluent-firegrid exposes descriptor helpers for schema or serde-backed handlers
    And those descriptors can be used to derive typed definitions
    And implementation helpers preserve the declared handler input and output types

  Scenario: Typed clients are derived from definitions, not handwritten
    Given a fluent definition has typed handler descriptors
    When an external ingress client is constructed for that definition
    Then the client methods match the definition's handler names and input types
    And call-style clients return handler outputs
    And send-style clients return durable send or invocation references

  Scenario: Scheduler and substrate internals are not the public API
    When an author imports from the package root
    Then scheduler internals, awaitable internals, and journal implementation details are absent from the primary authoring surface
    And any test-only or deployment-integration seam is clearly separated from the root public API

  Scenario: Deployment and control APIs stay out of fluent-firegrid
    When an external client sends, forks, tags, schedules, reads, heads, or deletes an entity
    Then that operation belongs to Durable Streams, a read model, or a future deployment binding
    And fluent-firegrid only supplies the authored handler logic that external execution may drive

  Scenario: Substrate mechanics stay out of fluent-firegrid
    When a feature needs claim, ack, lease, cursor, wake retry, scheduled wake, predicate subscription, producer fencing, or stream URL construction
    Then that feature is not implemented in fluent-firegrid
    And the required Durable Streams substrate contract is named before any deployment binding is admitted
    And fluent-firegrid receives only typed journal services and product inputs at the handler edge

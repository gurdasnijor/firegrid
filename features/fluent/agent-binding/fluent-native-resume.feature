@fluent @agent-binding @real-agent @resume
Feature: Fluent native resume
  Managed agent sessions resume by reconstruction, not by replay. Resume
  reconstructs the harness's native resume artifact from durable history and
  resumes natively across process and sandbox boundaries; the non-deterministic
  model loop is never re-run as the durable mechanism.
  # Canon: docs/cannon/architecture/fluent/execution-models.md "Model B: Managed
  # Sessions Resume By Reconstruction"; fluent-architecture.md invariant F-S6.

  Background:
    Given a durable stream with prior raw harness history
    And a real agent adapter with resume support

  Scenario: A session resumes from stream-derived native state
    When the bridge restarts with stream history present
    Then the adapter prepares a native resume artifact from the stream
    And the bridge spawns the harness with the recovered resume id
    And unfinished prompts are replayed after the resumed connection opens

  Scenario: Claude resumes through reconstructed transcript state
    Given the prior harness is Claude
    When the bridge prepares resume in a new sandbox
    Then it reconstructs a Claude transcript from durable history
    And rewritten paths point at the new sandbox
    And Claude is started with the reconstructed resume id

  Scenario: Codex resumes by thread id
    Given the prior harness is Codex
    When the bridge prepares resume
    Then it recovers the latest thread id from agent history
    And Codex is resumed with that thread id

  Scenario: Fresh spawn fallback is visible and constrained
    Given native resume spawn fails
    When pending prompts can safely bridge the gap
    Then the bridge may start a fresh harness
    And the fallback is recorded as resume fallback, not native continuation

  Scenario: Local-only resume state is insufficient
    Given the stream does not contain enough history to reconstruct resume state
    When local sandbox files are missing
    Then the bridge cannot claim native resume succeeded

  Scenario: Resume suppresses every already-observed Layer 1 side effect
    Given the durable history contains already-observed Layer 1 side effects
    And the side effects include harness-native shell, file, or test effects Firegrid did not mediate
    When the bridge reconstructs the native resume artifact and resumes natively
    Then no already-observed Layer 1 side effect is executed a second time
    And each Firegrid-mediated tool call is served from its recorded Layer 2 result rather than re-run
    And suppression covers harness-native side effects, not only Firegrid-mediated tools

  Scenario: Fake recorder resume proof is rejected at the acceptance layer
    Given a fake recorder or fake codec replays resume without a real harness
    When the native-resume experiment runs
    Then the experiment is rejected as unit-only evidence
    And it is not accepted as end-to-end proof that native resume suppresses observed side effects


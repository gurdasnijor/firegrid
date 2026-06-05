@fluent @agent-binding @real-agent @resume
Feature: Fluent native resume
  Resume reconstructs the harness's native resume artifact from durable history
  and resumes natively across process and sandbox boundaries.

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


Feature: Durable turn timers and waits
  A turn can register durable sleeps and waits that survive replay. A scheduled
  sleep stays pending until its due time, then fires; a wait stays pending until
  a candidate event satisfies its predicate, then matches. Both outcomes are
  visible by reading the turn back. (#942 source endpoints over FluentStore.)

  Background:
    Given a session "s1" for agent "claude"
    And turn "t1" is open with prompt "do the work"

  Scenario: A scheduled sleep registers pending and fires when due
    When turn schedules sleep "sleep-1" due at 1000
    Then the sleep is registered pending
    When due timers fire at 1000
    Then timer "sleep-1" is reported fired
    And reading the turn shows event "turn.timer_fired"

  Scenario: A durable wait stays pending until a matching candidate arrives
    When turn registers wait "w1" with predicate "event.type == 'turn.completed'"
    Then the wait is registered pending
    When a candidate event "turn.started" is offered to pending waits
    Then wait "w1" stays not matched
    When a candidate event "turn.completed" is offered to pending waits
    Then wait "w1" is matched
    And reading the turn shows event "turn.wait_matched"

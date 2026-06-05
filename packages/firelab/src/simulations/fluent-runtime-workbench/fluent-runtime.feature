Feature: Fluent runtime managed-agent store

  Scenario: Create a session
    When I POST "/sessions" with body
      """
      { "sessionId": "acc-create", "agent": "claude" }
      """
    Then the response status is 200
    And the response field "sessionId" equals "acc-create"

  Scenario: Open a turn and read it back open
    When I POST "/sessions" with body
      """
      { "sessionId": "acc-turn", "agent": "claude" }
      """
    Then the response status is 200
    When I POST "/sessions/acc-turn/turns" with body
      """
      { "turnId": "t1", "prompt": "hello" }
      """
    Then the response status is 200
    And the response field "turnId" equals "t1"
    When I GET "/sessions/acc-turn/turns/t1"
    Then the response status is 200
    And the response field "streamClosed" equals false

  Scenario: Reading a turn that was never started fails
    When I GET "/sessions/acc-missing/turns/never"
    Then the response status is 500

  Scenario: Control-plane send then read an entity
    When I POST "/sessions" with body
      """
      { "sessionId": "acc-entity", "agent": "claude" }
      """
    Then the response status is 200
    When I POST "/entities/acc-entity/send" with body
      """
      { "name": "ping", "payload": { "n": 1 } }
      """
    Then the response status is 200
    And the response field "entityId" equals "acc-entity"
    When I GET "/entities/acc-entity"
    Then the response status is 200
    And the response field "entityId" equals "acc-entity"

  Scenario: Control-plane tag captures the head offset
    When I POST "/sessions" with body
      """
      { "sessionId": "acc-tag", "agent": "claude" }
      """
    Then the response status is 200
    When I POST "/entities/acc-tag/tag" with body
      """
      { "name": "checkpoint" }
      """
    Then the response status is 200
    And the response field "name" equals "checkpoint"

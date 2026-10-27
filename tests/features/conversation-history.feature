Feature: Conversation history
  As a KajianQ reader
  I want the conversations this browser has held to be listed and reopenable
  So that starting a new conversation never loses the previous one

  Background:
    The list is local metadata (id, first question, locale, time); the
    transcripts stay on the server behind the rehydration endpoint, stubbed
    here so the flow runs with zero LLM spend.

  Scenario: A browser without conversations says how history works
    When I open the chat with an empty history list
    And I open the conversation history
    Then the history drawer says there are no conversations yet
    When I press Escape
    Then the history drawer is closed

  Scenario: A conversation in the list reopens its transcript
    When I open the chat with one stored conversation
    And I open the conversation history
    Then the drawer lists that conversation
    When I reopen that conversation
    Then the drawer closes and the transcript shows its first question

  Scenario: A conversation the server no longer holds is marked expired
    When I open the chat with one stored conversation the server has forgotten
    And I open the conversation history
    When I reopen that conversation
    Then the row is marked expired and stays in the list
    When I remove it
    Then the list is empty

  Scenario: A conversation can be downloaded as a Markdown file
    When I open the chat with one stored conversation
    And I open the conversation history
    Then downloading that conversation writes a Markdown file

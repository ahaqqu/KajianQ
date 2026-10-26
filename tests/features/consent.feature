Feature: Keeping a conversation in the browser is a choice
  As a KajianQ reader
  I want to decide whether the chat keeps my conversation in this browser
  So that nothing about it is stored unless I agree

  Scenario: A fresh browser is asked before anything is kept
    When I open the chat in a fresh browser
    Then the consent card asks before anything is kept
    And no chat data is stored in the browser
    When I choose not to keep anything
    Then the consent card is gone
    And only the choice is stored
    And reloading does not ask again

  Scenario: Agreeing keeps the conversation for the next visit
    When I open the chat in a fresh browser
    And I choose to keep the conversation
    And I ask about ayat kursi on that page
    Then the browser keeps the session for next time

  Scenario: The history drawer carries the storage switch
    When I open the chat in a fresh browser
    And I choose to keep the conversation
    And I open the conversation history
    Then the drawer offers to stop keeping conversations
    When I stop keeping conversations
    Then the drawer says browser storage is off

  Scenario: The privacy notice tells the same story
    When I open the privacy page
    Then the storage line names the consent choice and when it applies

Feature: Notes CRUD
  As a user
  I want local-first notes
  So that I can capture ideas offline and sync later

  Scenario: Home shows health and schema
    When I open the home page
    Then I see the home title
    And the health schema version is visible

  Scenario: Create a note
    When I open the notes page
    And I create a note titled "Buy milk" with body "2 liters"
    Then I see a note titled "Buy milk"

  Scenario: Empty notes list
    When I open the notes page with a fresh session
    Then I see the empty notes message

  Scenario: Offline note creation stays visible
    When I open the notes page
    And I go offline
    And I create a note titled "Offline idea" with body "later"
    Then I see a note titled "Offline idea"
    And the sync status indicates offline or local

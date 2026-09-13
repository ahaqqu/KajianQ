Feature: KajianQ shell
  As a visitor
  I want the PWA shell to load, greet me, and report API health
  So that I know the foundation deploys and serves correctly

  Scenario: Chat is the home page and shows the empty state
    When I open the home page
    Then I see the chat composer

  Scenario: The empty state greets and offers starter questions
    When I open the home page
    Then I see the greeting heading
    And I see three suggestion chips

  Scenario: The theme toggles to dark and persists across a reload
    When I open the home page
    And I toggle the dark theme
    Then the page carries the dark theme
    And reloading keeps the dark theme

  Scenario: Health page shows health and schema
    When I open the health page
    Then I see the home title
    And the health schema version is visible

  Scenario: Switch language to English (the product defaults to Bahasa Indonesia)
    When I open the health page
    And I switch the language to English
    Then I see the health page in English

  Scenario: Home page has no serious accessibility violations
    When I open the home page
    Then the page has no serious accessibility violations

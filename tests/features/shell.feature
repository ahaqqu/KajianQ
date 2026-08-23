Feature: KajianQ shell
  As a visitor
  I want the PWA shell to load and report API health
  So that I know the foundation deploys and serves correctly

  Scenario: Home shows health and schema
    When I open the home page
    Then I see the home title
    And the health schema version is visible

  Scenario: Switch language to Bahasa Indonesia
    When I open the home page
    And I switch the language to Bahasa Indonesia
    Then I see the home page in Bahasa Indonesia

  Scenario: Home page has no serious accessibility violations
    When I open the home page
    Then the page has no serious accessibility violations

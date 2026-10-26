Feature: Public reading pages
  As a reader
  I want the FAQ, privacy notice and terms to be reachable, readable and honest
  So that I can understand the product and my data before trusting an answer

  Scenario: The FAQ answers the product's questions
    When I open the FAQ page
    Then I see the FAQ heading
    And the FAQ lists its questions as disclosures
    And the page has no serious accessibility violations

  Scenario: The privacy page carries the Art. 13 register
    When I open the privacy page
    Then I see the privacy heading
    And I see the controller card
    And I see the sub-processor register

  Scenario: The terms page names the public contact channel
    When I open the terms page
    Then I see the terms heading
    And the terms name the public contact channel

  Scenario: The footer links the legal pages from every static page
    When I open the about page
    Then the footer links the privacy notice and the terms
    And the footer opt-out link targets the privacy anchor

  Scenario: The mobile header keeps the whole wordmark
    When I open the home page on a phone
    Then the header shows the full wordmark
    And the header shows three round controls

  Scenario: The mobile drawer carries the navigation and a new conversation
    When I open the home page on a phone
    And I open the navigation drawer
    Then I see four navigation links
    And I see the new conversation action

Feature: About and Collection pages
  As a visitor
  I want to read what KajianQ is and what it draws on
  So that I can judge the product and its sources before trusting an answer

  Scenario: The header reaches both pages from the chat
    When I open the home page
    Then I see the primary navigation
    When I follow the "Koleksi" nav link
    Then I see the collection page
    When I follow the "Tentang" nav link
    Then I see the about page

  Scenario: The burger menu opens on a small screen and navigates
    When I open the collection page on a small screen
    Then the navigation is collapsed into a burger button
    When I open the burger menu
    Then I see the nav links in the menu
    When I follow the "Tentang" link in the menu
    Then the burger menu is closed
    And I see the about page

  Scenario: The collection page separates available from planned sources
    When I open the collection page
    Then I see an entry marked "Tersedia" for the Uthmani Quran text
    And I see a planned Kitab entry
    And the planned entries carry their registered reference

  Scenario: The collection tabs filter the register
    When I open the collection page
    And I choose the "Tafsir" collection tab
    Then only planned entries remain
    And the "Tafsir" tab is the active filter
    When I choose the "Semua" collection tab
    Then the full register is shown again

  Scenario: Both pages follow the language switch
    When I open the collection page
    And I switch the language to English
    Then I see the collection page in English
    When I open the about page
    And I switch the language to English
    Then I see the about page in English

  Scenario: The collection page has no serious accessibility violations
    When I open the collection page
    Then the page has no serious accessibility violations

  Scenario: The about page has no serious accessibility violations
    When I open the about page
    Then the page has no serious accessibility violations

  Scenario: The about page names who processes the data, for how long, and how to erase it (#179)
    When I open the about page
    Then I see the privacy notice rendered from the register
    And I see the netcup host marked as in use today, with the decommissioned vendors marked as having no serving role
    And I see the retention row for reverse-proxy access logs marked "14 hari"
    And the erasure card names the endpoint that erases the data

  Scenario: The privacy notice follows the language switch (#179)
    When I open the about page
    And I switch the language to English
    Then I see the privacy notice in English

  Scenario: The privacy notice states what stays in the browser (#179)
    When I open the about page
    Then I see the browser-storage line: no cookies, localStorage keys, erasable
    When I switch the language to English
    Then I see the browser-storage line in English

  Scenario: An available source links into the chat with its question pre-filled
    When I open the collection page
    And I follow the first available source's ask link
    Then the chat opens with that source's question in the composer
    And the chat URL carries no question param
    And no answer was sent

  Scenario: The ask affordance follows the language switch
    When I open the collection page
    And I switch the language to English
    Then the first available source's ask link is in English

  Scenario: Opening the chat directly leaves the composer empty
    When I open the home page
    Then the chat composer is empty

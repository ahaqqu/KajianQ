Feature: Chat — ask, answer, citations, warnings, disclaimer
  As a KajianQ user
  I want answers with verifiable citations, Arabic originals, honest warnings, and the ulama disclaimer
  So that I can trust and check what the chatbot tells me

  Background:
    All /v1/* traffic is intercepted with fixture streams (zero LLM spend in CI);
    the live path stays covered by eval:smoke in the Staging workflow.

  Scenario: Asking produces a staged loading state, then a cited answer
    When I open the chat and ask about ayat kursi
    Then I see staged loading while the answer is prepared
    And the answer renders with a citation chip
    And the disclaimer renders as a distinct footer

  Scenario: A citation chip opens the Arabic original with its translation
    When I open the chat and ask about ayat kursi
    And the answer renders with a citation chip
    And tapping the chip shows the Arabic original

  Scenario: A dhaif answer carries the warning card and the grade badge
    When I ask a question whose answer carries a dhaif hadith
    Then the dhaif warning renders as a warning card with the grade badge

  Scenario: A refusal renders as a plain card without citation affordances
    When I ask something the corpus cannot answer
    Then the refusal renders as a plain card with no citation chips

  Scenario: Reloading restores the full transcript with citations
    When I open the chat and ask about ayat kursi
    And the answer renders with a citation chip
    And reloading restores the full transcript

  Scenario: The chat page has no serious accessibility violations
    When I open the chat and ask about ayat kursi
    And the answer renders with a citation chip
    Then the chat page has no serious accessibility violations

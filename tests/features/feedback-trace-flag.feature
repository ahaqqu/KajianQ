Feature: Feedback — anonymous thumbs and trace-anchored flags
  As a KajianQ user
  I want to rate an answer and flag the exact failing element from the Trace panel
  So that my report is actionable without creating an account

  Background:
    All /v1/* traffic is intercepted with fixture streams (zero LLM spend in CI);
    the live path stays covered by eval:smoke in the Staging workflow.

  Scenario: Thumbing up an answer posts anonymous feedback against it
    When I ask about ayat kursi with feedback capture
    And the answer renders with a citation chip
    And I thumb the answer up
    Then the thumbs carry my rating and anchor the answer
    And the feedback bar thanks me

  Scenario: Flagging a source from the Trace panel anchors the chunk
    When I ask about ayat kursi with feedback capture
    And the answer renders with a citation chip
    And I expand the answer's Trace for feedback
    And I flag the consulted source as irrelevant
    Then the flag carries the chunk reference and the reason category
    And the flag button confirms the report

  Scenario: Flagging the failing element from the citation sheet anchors the label
    When I ask about ayat kursi with feedback capture
    And the answer renders with a citation chip
    And tapping the chip shows the Arabic original
    And I flag the citation as wrong
    Then the flag carries the citation label and the reason category

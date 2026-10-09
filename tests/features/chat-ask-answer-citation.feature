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

  # #292: the postprocess appends warning → MT label → disclaimer, and a draft
  # that already carried its disclaimer leaves `[warning][MT label]` as the
  # tail. The pre-fix two-paragraph peel left the warning in the body and the
  # card drew it again — the canonical sentence rendered twice.
  Scenario: The dhaif warning renders once when the MT label follows it (#292)
    When I ask a question whose dhaif answer ends with the machine-translation label
    Then the dhaif warning renders exactly once beside the MT label

  # #348: the model can repeat the canonical line INSIDE one trailing
  # paragraph (QA #345 probe p9b). The A2 byte-equality gate rejected that
  # paragraph — it is not byte-equal to the canonical line — so the peel put it
  # back into the body and the frame-flag card drew a third copy: the wire
  # carried 2, the page displayed 3.
  Scenario: The dhaif warning renders once when the trailing paragraph repeats it (#348)
    When I ask a question whose dhaif answer repeats the canonical line in its last paragraph
    Then the dhaif warning renders exactly once despite the repeated line

  # #361: QA #356 probes p4/p9 — the model repeated the canonical line THREE
  # times on ONE line, SPACE-SEPARATED (3 × 93 = 281 chars). The #348 collapse
  # split the paragraph on "\n", so the single over-cap line classified as null
  # and stopped the peel: the paragraph stayed in the body as prose and the
  # flag-driven card drew on top — the wire carried 3, the page displayed 4.
  Scenario: The dhaif warning renders once when the trailing paragraph repeats it space-separated (#361)
    When I ask a question whose dhaif answer repeats the canonical line space-separated
    Then the dhaif warning renders exactly once despite the space-separated repeat

  Scenario: Markdown in the answer renders as rich text, never literal markers (#150)
    When I ask a question whose answer contains markdown
    Then the answer renders bold, emphasis, and list items with no literal markdown

  Scenario: A refusal renders as a plain card without citation affordances
    When I ask something the corpus cannot answer
    Then the refusal renders as a plain card with no citation chips

  Scenario: Reloading restores the full transcript with citations
    When I open the chat and ask about ayat kursi
    And the answer renders with a citation chip
    And reloading restores the full transcript
    And the Trace panel is available from the rehydrated transcript

  Scenario: Expanding the Trace lists the sources consulted in plain language
    When I open the chat and ask about ayat kursi
    And the answer renders with a citation chip
    And I expand the answer's Trace
    Then I see the sources consulted with no technical detail

  Scenario: The Trace's deeper layer shows intent, the routing decision, sub-queries, scores, and model identity
    When I open the chat and ask about ayat kursi
    And the answer renders with a citation chip
    And I expand the answer's Trace
    And I open the Trace's technical details
    Then I see the router intent, the routing decision, sub-queries, retrieval scores, and model identity

  Scenario: The expanded Trace has no serious accessibility violations
    When I open the chat and ask about ayat kursi
    And the answer renders with a citation chip
    And I expand the answer's Trace
    And I open the Trace's technical details
    Then the chat page has no serious accessibility violations

  Scenario: A capped transcript says older messages are not shown
    When I open a chat whose stored transcript was capped
    Then the transcript says older messages are not shown

  # B1: the clamp claim is proven on the wire, not by "no request happened".
  # Before the ceiling the composer sent nothing extra; now a clamped draft
  # DOES send, so the property is what the POST body carries.
  Scenario: An over-long message is capped in the composer and sent at most at the ceiling (#256)
    When I open the chat and paste a message longer than the ceiling
    Then the composer holds the ceiling and says so
    When I press Enter to send the clamped draft
    Then the outgoing chat POST carries the clamped message, no longer than the ceiling

  # #271: a stored session id the store cannot represent (an older, hand-edited,
  # or corrupted localStorage value) must not break the page. The rehydration
  # endpoint answers its documented 404 — never a 500 — and the reader gets a
  # fresh chat instead of a load error, with the malformed id never replayed.
  Scenario: A stored session id the store cannot represent starts a fresh chat (#271)
    When I open a chat whose stored session id is malformed
    Then the app starts a fresh chat without an error
    When I ask a question in that fresh chat
    Then the outgoing chat POST carries no session id

  Scenario: The chat page has no serious accessibility violations
    When I open the chat and ask about ayat kursi
    And the answer renders with a citation chip
    Then the chat page has no serious accessibility violations

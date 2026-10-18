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

  # #303: the postprocess suppresses its own append when the draft already
  # carries the canonical copy (`hasWeakWarning`), so the delivered answer is
  # `[prose][canonical warning][prose][MT label][disclaimer]` and the frame still
  # flags the dhaif. The peel owns that copy wherever it sits: the card draws it
  # once and the body keeps none of it.
  Scenario: The dhaif warning renders once when the canonical line sits mid-answer (#303)
    When I ask a question whose dhaif answer carries the canonical line mid-answer
    Then the dhaif warning renders exactly once despite the mid-answer line

  # #303: the delivered variant where the copy and the MT label share ONE
  # paragraph: stripping the copy leaves the label line byte-identical in the
  # body, so no answer content moves and the card draws the canonical line once.
  Scenario: The dhaif warning renders once when the label shares the copy's paragraph (#303)
    When I ask a question whose dhaif answer puts the label in the canonical line's paragraph
    Then the dhaif warning renders exactly once beside the shared label

  # #548: the model can wrap the canonical line in markup that wraps ONLY the
  # copy (`**<copy>**`, `- <copy>`, `> <copy>`). The delimiters are not answer
  # bytes, so the peel takes them with the copy: the card draws the line once
  # and no literal wrap markup is left in the body.
  Scenario: The dhaif warning renders once when wrap-only markup wraps the canonical line (#548)
    When I ask a question whose dhaif answer wraps the canonical line in markup
    Then the dhaif warning renders exactly once with no wrap markup left

  # #365: ONE trailing paragraph alternates the canonical line with the disclaimer
  # sentence, and the model's closing disclaimer paragraph below it owns the
  # footer (the postprocess adds none when the draft already says "bukan fatwa").
  # The copies peel to the card like every other copy; the interleaved sentences
  # are the footer's own line, so they leave the body with the copies — each
  # sentence renders once, and nothing the model wrote is dropped.
  Scenario: The dhaif warning renders once when the trailing paragraph interleaves the disclaimer (#365)
    When I ask a question whose dhaif answer interleaves the canonical line with the disclaimer
    Then the dhaif warning renders exactly once and the disclaimer once despite the interleave

  Scenario: Markdown in the answer renders as rich text, never literal markers (#150)
    When I ask a question whose answer contains markdown
    Then the answer renders bold, emphasis, and list items with no literal markdown

  Scenario: A refusal renders as a plain card without citation affordances
    When I ask something the corpus cannot answer
    Then the refusal renders as a plain card with no citation chips

  # #506: a message carrying no letter and no digit is not a question, so the run
  # answers it from the product's canned decline instead of generating one. It is
  # rendered from the record like every other answer — and nothing decorates it,
  # because the stages that append the rules were never entered.
  Scenario: A message carrying no question is declined from canned copy
    When I send a message that is not a question
    Then the decline renders as a plain card with no citation chips

  # #436: a HYBRID answer — a grounded partial answer that runs into the canonical
  # insufficiency sentence — is a refusal on the trace AND a cited answer on the
  # page. The frame carries both, and the reader must keep the chip the verse in
  # the text earns instead of the empty pure-refusal sheet.
  Scenario: A hybrid answer that refuses only in part keeps its citation chips (#436)
    When I ask a question whose answer answers in part and then refuses
    Then the hybrid answer renders its grounded citation chip

  Scenario: Reloading restores the full transcript with citations
    When I open the chat and ask about ayat kursi
    And the answer renders with a citation chip
    And reloading restores the full transcript
    And the Trace panel is available from the rehydrated transcript

  # A rehydration request that begins after the initial load failed is stale by
  # the time it lands: it was fetched before the turn's write, so applying it
  # would replace the streamed answer with the pre-turn history.
  Scenario: A held reconnect transcript never replaces the streamed answer
    When I open a chat whose transcript load failed and hold its reconnect refetch
    And I ask a question while the reconnect refetch is held
    And the held reconnect refetch arrives with the pre-turn history
    Then the streamed answer remains in the transcript

  # A route change, not a reload: the page's fresh mount meets the transcript
  # the shared query cache fetched before the turn. Applying that snapshot would
  # drop the answer the reader just received; the mount fetches the session's
  # current transcript instead.
  Scenario: Leaving the chat and coming back keeps the completed answer
    When I open the chat with a stored session and ask about ayat kursi, then leave and come back
    Then the completed answer is still in the transcript

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

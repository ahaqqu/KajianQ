# language: en
@local
Feature: Admin trace browser

  The operator's failure-search surface. It stays closed — the same 401 for every
  miss — until the admin password is given, and the public shell never points at
  it. Once open it shows an answer's own question and answer, the totals summed
  over every provider call that answer made, each call's model identity and cost
  consistency from the provider config, the stored trace as a download, and the
  same Trace panel the chat renders for that answer.

  Background:
    Given the admin trace data is stubbed

  Scenario: The surface is closed until the operator signs in
    When I open the admin surface
    Then I am asked for the admin password
    And the trace list is not shown
    And the public home page offers no link to the admin surface

  Scenario: An operator signs in and reads one answer's totals and stored trace
    When I open the admin surface
    And I sign in with the admin password
    And I open the first answer in the list
    Then I see the answer's tokens, cost and latency
    And I see every provider call, the embedding included
    And I see the model identity and cost consistency of every provider call
    And the Trace panel shows the answer's sources
    And the stored trace downloads as JSON

  Scenario: Every admin read answers the same 401 without a session
    Then every admin read answers the same 401, with and without a forged cookie

  Scenario: A filter narrows the list to the answers it matches
    When I open the admin surface
    And I sign in with the admin password
    And I search the traces for "riba"
    Then only the answer mentioning riba is listed

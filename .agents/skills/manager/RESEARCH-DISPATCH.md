# Research dispatch

Dispatch `researcher` **before** an implementer when any one holds:

- two fix rounds on the same symptom, with different fixes, both failed — the manager's step 5 checks it again before any third fix;
- the failure has a symptom but no stated mechanism — no one can point to the code path or the measurement that produces it;
- a design choice between approaches with no evidence in the repo (a new retrieval stage, provider or prompt strategy);
- a pending decision needs a number that does not exist yet (gate calibration, corpus coverage, the cost of a path);
- an external system — vendor API, model, database — behaves differently from its documentation.

The brief you write is one screen: the question as a falsifiable claim, **the kill condition** — the observation that would refute it — the decision it unblocks, the budget (spend and prototypes), what evidence form settles it, and the stop rule. Name the artifact paths in the task text — the brief's file, the experiment log's file, the prototype directory, and where a bug's failing test lives; the `research` skill takes them from the dispatch and does not invent repo structure. Dispatch it into its own worktree, `.worktrees/research-<slug>` on branch `research/<slug>`, and tell it to remove that worktree once the branch is pushed (canonical: `SKILL.md` — Workspace isolation).

On return, verify before you read the result:

- **The boundary.** `git diff --name-only origin/main...research/<slug>` names only the artifact paths you stated; any other path — production code, a gate, a workflow, a contract — rejects the return outright, because a research branch that carries production code is not research. `gh pr list --head research/<slug> --state all --json number` is empty, and `git ls-remote origin refs/heads/research/<slug>` equals the tip it reported.
- **One number.** Re-run one `E<n>` command yourself: a research result you cannot reproduce is a rumour with a bibliography.

Then the implementer carries the brief: the fix is theirs, the diagnosis is the researcher's.

Do not dispatch research for a task whose mechanism is already stated **and verified** — a mechanism nobody has demonstrated is the guess the role exists to test, so demonstrate it first or research it. And do not let a finding become a code dispatch until you can state the invariant in one sentence.

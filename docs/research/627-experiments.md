# Experiment log — #627 decision packet

One entry per experiment, appended as it ends, never rewritten. `E<n>` is the stable evidence id
the decision brief cites. Every command is copy-pasteable from the repository root; the database
is the read-only local corpus (`PGPASSWORD=kq psql -h 127.0.0.1 -p 55432 -U postgres -d kajianq`,
every session under `SET default_transaction_read_only = on`).

Inputs labelled **reported** are quoted from the QA reports whose traces were erased; what the
experiment measures is the instrument's decision on those inputs, never their content.

---

## E0 — branch-namespace finding (before E1)

**Question:** can the dispatch's branch `research/627-decision-packet` exist?

**Setup:** the shared checkout already had `refs/heads/research` (50a6a4a, the earlier #627
research branch), and git refs cannot hold both `research` and `research/<child>`.

**Command:**
`git worktree add .worktrees/research-627-decision-packet -b research/627-decision-packet origin/main`

**Result:** `fatal: cannot lock ref 'refs/heads/research/627-decision-packet': 'refs/heads/research'
exists`. The manager archived the old branch to `refs/heads/research/archive`, after which the
rename succeeded. Cost: ~10 minutes of dispatch time and one round-trip to the manager.

**Verdict:** confirmed convention defect, worked around; the artifact branch is
`research/627-decision-packet`.

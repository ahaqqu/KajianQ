# ADR-0066: A reader sees the chain's grade and its grader, never a passage's headline

## Decision

1. **The grade a reader sees belongs to an Isnad, and travels with its Grader.** Where the rows were read, every reader-facing rendering of a citation — the passage sheet and the downloaded conversation — renders one entry per stored transmission row of the passage it grounds, each with that row's own grade and the grader the row attributes it to — never a headline grade for the passage, and never a grade named without its grader. A row that states a grade but names no grader refuses the read rather than rendering an unattributable verdict.
2. **Every stored row renders, in stored order.** No presentation path selects, sorts or collapses rows: a passage whose chains disagree is shown as disagreement, and the same rows reach the generator and the reviewer. A read the retrieval budget bounds is presented as a prefix and says so; a silently shortened list is not permitted.
3. **The per-chain record is the trace's, not a fresh read.** Retrieval reads the rows for the passages it puts in context, records them as their own typed trace event, and both wire frames — the citation payload and the Trace panel — project that record. A passage whose read found no row keeps v1's rendering; a chain-bearing passage the budget left unread is recorded as unread and shows no grade; a run with no chain-bearing passage records no event.
4. **The weak-evidence rule fires on any weak row.** A passage whose headline grade is sound but whose transmission carries a dhaif Isnad is flagged and warned as surely as a passage graded dhaif, because the reader's risk is the chain that carries it; the warning's copy says whether the passage or one chain is weak.
5. **Chain grade and narrator are retrieval filter dimensions that select a passage, never a row.** A filter on either brings the passage in whole, with every row it stores: narrowing a passage to the one row that matched would present a single chain as the passage's transmission.
6. **The generator may not add to the record.** It presents every row with the grade the context states, states no grade the context does not, and claims corroboration — hasan li-ghayrihi — or writes a takhrij only where the context's own rows support it. Those two claims rest on the model recognising two passages as the same matn; the record carries passages and their chains, not a matn identity, so that judgement is prompt-scoped and untraced until reconciliation supplies it.
7. **A narrator-reliability answer rests on the catalogue's rows.** Where the evidence carries no critic assessment, the answer says so; it never fills the gap from recalled biography.

## Why

Hadith science grades chains, not texts: one matn may be sahih through one Isnad and dhaif through another, and a single headline grade makes that passage either falsely confident or falsely dismissed. v1 stored one grade per hadith and rendered it as the passage's verdict, so the product's most trust-sensitive answer class restated a simplification the discipline rejects. The reader-visible unit is therefore the row with its grader, and the evidence that reaches the reader is the evidence retrieval actually read.

The alternative — keep the headline, show the chains on request — was rejected because the headline is exactly the claim that cannot be supported when the rows disagree, and a reader who does not open the sheet would never learn the difference. Sorting rows by strength and showing the best was rejected for the same reason: it reproduces the headline with more words.

## Consequences

- Retrieval gains one post-fusion read of stored rows and narrators for the passages in context, bounded by configuration and recorded on the trace; the read costs no provider call.
- Filters on chain grade and narrator constrain passage selection only, so a filtered search can rank a passage by one row while the citation still shows all of them.
- The prompt carries the presentation rules; every reader-facing rendering — the sheet, the downloaded conversation and the Trace — drops the flattened grade wherever rows were read, and marks a passage the read left unread.
- Where the corpus stores no rows — collections and narrations outside Sanadset's reach — the v1 rendering stands; the reader is never told a chain exists.
- **Revisit when** the corpus's rows can be reconciled per matn for every hadith, when the Golden Set v2 gate measures a presentation choice differently, or when graded transmissions of non-hadith material enter scope.

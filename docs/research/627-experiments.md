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

---

## E8 — does the local harness score a known case correctly? (run first, cited last)

**Question:** is `packages/eval`'s recorded-run replay a harness whose numbers can be believed?

**Setup:** the repo's own replay fixture (`golden-set-v0-replay.json`, run
`be4a100d-3ab3-44ac-8f23-d7e662de165a`, base `9c57893`) with the head build's scorers.

**Command:**
`bun test packages/eval/src/golden-set-replay.test.ts`

**Result:** `7 pass / 0 fail`, 54 `expect()` calls. The suite reports 0.700 address recall where the
type-only metric reads 1.000, flips no other row's pass state, and keeps the case's evidence chain.

**Verdict:** confirmed — the harness computes the known case. Every later number comes from the
same modules (`citationValidity`, `citationAddressRecall`, the real grammar and identity parser).

**Cost:** ~0.2 s, $0.

---

## E1 — are the six recorded causes true at head?

**Question:** do the required and cited addresses exist, and are the claimed equivalences actually
the same report at the corpus head?

**Setup:** read-only SQL over `doc_children` (42,511 rows). Arabic normalisation strips harakat,
tatweel and punctuation; equivalence signal is the Jaccard of 5-word shingles over normalised
`text_ar` (whole row, isnad included), plus the visible chain. Commands: the SQL selects one row
per `(collection, hadithNo)`; the Quran counts normalise `text_ar` and test the two names as tokens.

**Command (essentials):**

```bash
PGPASSWORD=kq psql -q -h 127.0.0.1 -p 55432 -U postgres -d kajianq -c \
 "select citation->>'collection', citation->>'hadithNo', text_ar from doc_children
  where (citation->>'collection',citation->>'hadithNo') in
  (('bukhari','1108'),('nasai','598'),('bukhari','1395'),('abudawud','1584'),
   ('nasai','5144'),('ibnmajah','3597'),('bukhari','5026'),('bukhari','5027'))"
PGPASSWORD=kq psql -q -h 127.0.0.1 -p 55432 -U postgres -d kajianq -t -c \
 "select coalesce(citation->>'sourceType','?'), count(*) from doc_children group by 1"
```

The full probe (normaliser + Jaccard + Quran name count) is the Python script recorded in the
appendix of this entry.

**Result:**

| claim under test                                      | measured at head                                                                                                                                                        | verdict                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| address universe                                      | 35,982 hadith addresses (collection+number), 6,236 Qur'an addresses, 293 untyped = 42,511 rows                                                                          | —                                                        |
| `Bukhari 1108 ≡ Nasai 598` "same report"              | 1108: Anas ← Hafs ← Yahya ← Husayn; 598: Ibn Umar ← Nafi' ← Malik ← Qutayba. 5-gram Jaccard **0.000**. Same ruling (combining Maghrib/Isha in travel), different report | **refuted as "same report"**; true only as "same ruling" |
| `Bukhari 1395 ≡ Abu Dawud 1584` "same matn and chain" | chain identical (Zakariya ← Yahya ← Abu Ma'bad ← Ibn Abbas); Jaccard **0.250**, the shared run is the matn                                                              | **confirmed**                                            |
| `Nasai 5144 ≡ Ibn Majah 3597` "same instruction"      | Ali ← … vs Abdullah bin Amr ← …; Jaccard **0.011**                                                                                                                      | confirmed as same instruction, **not** same report       |
| `Bukhari 5026` vs cited 5027/5028/4937                | Jaccard 0.009 / 0.000 / 0.010; different matns                                                                                                                          | confirmed different narrations                           |
| `QS. 1:1` vs `QS. 1:3`                                | 1:1's normalised text **contains** 1:3 exactly; both name ar-Rahman + ar-Rahim                                                                                          | confirmed same names, 1:3 is a shorter address           |
| naive "shares the two names" rule                     | exactly **6** Qur'an addresses contain both names as tokens (1:1, 1:3, 2:163, 27:30, 41:2, 59:22); 15 unordered pairs                                                   | bounded, not thousands                                   |
| all 13 proposed identity members exist                | each exactly one row (598, 1395, 1584, 1783, 2522, 2435, 5144, 5148, 5149, 5160, 3597, 3590, 1720)                                                                      | confirmed                                                |

**Verdict:** confirmed with one important correction — the audit's "006 same report" is wrong at
head. D1's three groups are not one kind of claim: 016 is a factual identity, 006 and 017 are
requirement-scope decisions (same ruling/instruction, different narration).

**Cost:** seconds, $0.

**Appendix — E1 probe (run with `PGPASSWORD=kq python3 e1.py`):**

```python
import re, subprocess, sys
def q(sql):
    o = subprocess.run(['psql','-q','-h','127.0.0.1','-p','55432','-U','postgres','-d','kajianq',
                        '-t','-A','-F','\t','-c',sql], capture_output=True, text=True,
                       env={'PGPASSWORD':'kq','PATH':'/usr/bin:/bin'})
    if o.returncode: sys.exit(o.stderr)
    return [l.split('\t') for l in o.stdout.strip().split('\n') if l]
def norm(s):
    s = re.sub(r'[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]', '', s or '')
    s = re.sub(r'[^\u0621-\u064a\s]', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()
def shingles(t, n=5):
    w = t.split(); return {tuple(w[i:i+n]) for i in range(len(w)-n+1)} if len(w) >= n else {tuple(w)}
def jac(a, b):
    A, B = shingles(norm(a)), shingles(norm(b)); return len(A & B) / len(A | B) if A and B else 0
addr = [('bukhari','1108'),('nasai','598'),('malik','331'),('bukhari','1395'),('abudawud','1584'),
        ('nasai','5144'),('ibnmajah','3597'),('nasai','5148'),('bukhari','5026'),('bukhari','5027'),
        ('bukhari','5028'),('bukhari','4937'),('tirmidhi','662')]
rows = {k: q(f"select text_ar from doc_children where citation->>'collection'='{k[0]}' "
             f"and citation->>'hadithNo'='{k[1]}'") for k in addr}
for a, b in [(('bukhari','1108'),('nasai','598')), (('bukhari','1395'),('abudawud','1584')),
             (('nasai','5144'),('ibnmajah','3597')), (('bukhari','5026'),('bukhari','5027'))]:
    print(a, b, round(jac(rows[a][0][0], rows[b][0][0]), 3))
```

---

## E2 — D1 identity map: recovery and corpus-wide blast radius

**Question:** with the three proposed groups applied, which Golden Set rows flip, and how many
corpus address pairs become mutually equivalent?

**Setup:** the real `citationValidity` scorer, the real grammar (`normalizeCitationLabel`,
`citationCandidatesIn`, `addressesNamedBy`) and the real `parseHadithIdentitySet`/`identityResolver`.
Inputs are the **reported** cited sets of runs `5d47c85b` (R1) and `6888d711` (R2) from #627's audit;
the scorer decision is measured, the cited content is quoted. The frame carries the cited labels
(the deployed server frame derives from the same retrieved chunks).

**Command:** `bun e2.ts` (script below).

**Result:**

| row | required     | R1 current → proposed | R2 current → proposed |
| --- | ------------ | --------------------- | --------------------- |
| 006 | Bukhari 1108 | 0.000 → **1.000**     | 0.000 → **1.000**     |
| 016 | Bukhari 1395 | 0.000 → **1.000**     | 0.000 → **1.000**     |
| 017 | Nasai 5144   | 0.000 → **1.000**     | 0.000 → **1.000**     |
| 008 | Bukhari 5026 | 0.000 → 0.000         | 0.000 → 0.000         |
| 012 | QS. 1:1      | 0.000 → 0.000         | 0.000 → 0.000         |
| 007 | QS. 42:11    | 0.000 → 0.000         | 0.000 → 0.000         |

Address recall is unchanged by construction (identity is validity-only): 006 1.000, 016
**0.000**, 017 1.000, 008 0.000, 012 1.000, 007 0.000.

Corpus-wide accounting: the map grows from **29 labels / 107 unordered pairs** to **42 labels /
143 pairs** — **13 newly mapped labels and 36 newly equivalent address pairs**, no more. Every
new pair is inside one signed group; a label outside a group still resolves to `null` and matches
nothing. Because identity can only add a match, no currently-passing row can flip to fail.

**Verdict:** confirmed for recovery and blast radius. D1 flips exactly the three target rows'
validity and no other row; 016 still fails the address gate.

**Cost:** seconds, $0. Data-only change; reversible by deleting the groups.

**Script:**

```ts
const ROOT = "<worktree>";
const { citationValidity, citationAddressRecall } = await import(
  `${ROOT}/packages/eval/src/scorers.ts`
);
const { normalizeCitationLabel, citationCandidatesIn } = await import(
  `${ROOT}/packages/kajianq-domain/src/chat-citation-normalize.ts`
);
const { addressesNamedBy } = await import(
  `${ROOT}/packages/kajianq-domain/src/chat-citation-addresses.ts`
);
const G = {
  normalizeLabel: normalizeCitationLabel,
  labelsInText: citationCandidatesIn,
  addressesNamedBy,
};
const base = JSON.parse(
  readFileSync(`${ROOT}/packages/kajianq-domain/fixtures/hadith-identities-v0.json`, "utf8"),
);
base.groups
  .find((g) => g.id === "combining-prayers-in-travel-maghrib-isha")
  .members.push("HR. Nasai no. 598");
const proposedRaw = {
  ...base,
  groups: [
    ...base.groups,
    {
      id: "zakat-obligation-ibn-abbas",
      canonical: "HR. Bukhari no. 1395",
      members: [
        "HR. Abu Dawud no. 1584",
        "HR. Ibn Majah no. 1783",
        "HR. Nasai no. 2522",
        "HR. Nasai no. 2435",
      ],
    },
    {
      id: "gold-and-silk-prohibition",
      canonical: "HR. Nasai no. 5144",
      members: [
        "HR. Nasai no. 5148",
        "HR. Nasai no. 5149",
        "HR. Nasai no. 5160",
        "HR. Ibn Majah no. 3597",
        "HR. Ibn Majah no. 3590",
        "HR. Tirmidhi no. 1720",
      ],
    },
  ],
};
const current = { identityOf: identityResolver(parseHadithIdentitySet(base)) };
const proposed = { identityOf: identityResolver(parseHadithIdentitySet(proposedRaw)) };
const frame = (labels) => ({ citations: labels.map((label) => ({ label })) });
// rows carry required, retrieved, cited[2] verbatim from the audit; score:
citationValidity(row.required, "", { frame: frame(cited), grammar: G, identity: map });
```

---

## E3 — D2 Qur'an verse equivalence: recovery and blast radius

**Question:** does a curated `{1:1, 1:3}` pair flip 012, and what would a "shares the two names"
rule admit corpus-wide?

**Setup:** the same real scorer plus a prototype Qur'an resolver on the normalised labels; E1's
measured name count bounds the naive rule.

**Command:** `bun e3.ts` (same pattern as E2; resolver maps exactly the pair to one key).

**Result:**

| case                                     | exact | with curated pair |
| ---------------------------------------- | ----- | ----------------- |
| 012, cited 1:3                           | 0.000 | **1.000**         |
| 012, cited 55:1 / 1:3 / 17:110           | 0.000 | **1.000**         |
| control 001, required 2:255, cited 2:255 | 1.000 | 1.000             |
| control 007, required 42:11, cited 59:24 | 0.000 | 0.000             |

Fixture blast radius: **gs-v0-012 is the only row that requires either pair label**. Corpus
blast radius: the curated pair adds **1 equivalence pair**; the naive "both names" rule would add
at most **15 pairs across 6 addresses** (1:1, 1:3, 2:163, 27:30, 41:2, 59:22) — bounded, and
demonstrably not all equivalent (2:163 states tawhid, not the basmalah).

**Verdict:** confirmed — one row, one pair, no control moves. The rule must name the pair, not the
shared names.

**Cost:** small code (a Qur'an resolver/loader); no corpus write, no re-embed; reversible.

---

## E4 — D3 requirement set for `gs-v0-008`

**Question:** does an any-of requirement recover 008, and which other rows does the contract
change touch?

**Setup:** the real scorer and address-recall function, evaluated for each member of
`{Bukhari 5026, Bukhari 5027, Bukhari 4937}`; the row passes if any member satisfies each gate.
Inputs: reported cited sets R1/R2 and the reported retrieved labels (5027/5028/4937).

**Command:** `bun e45.ts` (E4/E5 script).

**Result:**

| draw                  | single-address validity | any-of validity | single-address recall | any-of recall |
| --------------------- | ----------------------- | --------------- | --------------------- | ------------- |
| R1 (cited 5027, 4937) | 0.000                   | **1.000**       | 0.000                 | **1.000**     |
| R2 (cited 4937)       | 0.000                   | **1.000**       | 0.000                 | **1.000**     |

Blast radius: the fixture has **21 rows / 18 requirements; no row has more than one required
citation**, and 3 rows require none. A global AND→OR semantics change is therefore inert on
today's fixture and only the curated multi-member set can move a verdict; the risk is the next
row that gets a second requirement. Per-row curation confines the change to 008.

**Verdict:** confirmed — 008 passes on both gates with the set; the cost is contract shape plus a
curator's signature on the set.

**Cost:** a contract field + scorer change, fixture data; no re-embed; reversible.

---

## E5 — D4 address-recall policy for `gs-v0-016`

**Question:** if an identity-equivalent retrieved address satisfies address recall, which rows
flip, and what does the metric stop distinguishing?

**Setup:** exact `citationAddressRecall` vs an identity-satisfied variant, proposed D1 map, on the
six rows' reported retrieved labels.

**Command:** `bun e45.ts`.

**Result:**

| row | exact address recall | identity-satisfied  |
| --- | -------------------- | ------------------- |
| 006 | 1                    | 1                   |
| 016 | **0**                | **1**               |
| 017 | 1                    | 1                   |
| 008 | 0                    | 0                   |
| 012 | 1                    | 0 (hadith-only map) |
| 007 | 0                    | 0                   |

Only **016** flips. After D1 the map carries **42 labels in 6 groups**; an identity-aware address
metric would let any of those 42 labels satisfy the address requirement of any member. It would
also make the reported address-recall mean incomparable with every run measured under the exact
address (0.857 at `3d07155`).

**Verdict:** confirmed — D4 recovers 016 only when D1 is also applied; the price is the metric's
meaning, not just a number.

**Cost:** scorer/SPECS decision; no data, no re-embed; reversible but breaks historical
comparability.

---

## E6 — the 007 lever, and 016's reachability (local exact-rank probe)

**Question:** can any query representation reach `QS. 42:11`, and how far is 016's required row?

**Setup:** the corpus's own stored `embedding_primary` (gemini-embedding-001, 1536 dims, 42,511
rows). Query embeddings are live calls to the same model (`dimensions: 1536`, OpenAI-compatible
endpoint); rank = 1 + count of rows with smaller cosine distance. This is a **local single-vector
dense rank**, not the deployed router+RRF fused set.

**Command:** `PGPASSWORD=kq python3 e6.py` (and `e6b.py`, `e6c.py` for the hadith rows); the scripts
embed the named texts then run the rank SQL shown below.

```sql
with t as (select citation, embedding_primary <=> '[...]'::vector d from doc_children where embedding_primary is not null),
     tg as (select d from t where citation->>'surah'='42' and citation->>'ayah'='11')
select (select count(*)+1 from t, tg where t.d < tg.d) as rank, (select count(*) from t) as total;
```

**Result:**

| query shape                                                                     | `QS. 42:11` overall | within surah 42 |
| ------------------------------------------------------------------------------- | ------------------- | --------------- |
| verbatim question                                                               | **#5352 / 42,511**  | #18 / 53        |
| quotation: 42:11's own Indonesian translation                                   | **#1**              | #1              |
| concept expansion "tanzih Allah: tidak ada sesuatu pun yang serupa dengan-Nya…" | **#56**             | #1              |
| doctrinal expansion "sifat wajib Allah tanzih mukhalafat lil hawadits"          | #4299               | #12             |

Hadith required rows, verbatim question: `Bukhari 1108` **#11**, `Nasai 5144` **#40**,
`Bukhari 1395` **#48**, `Bukhari 5026` **#397**. For 016, quoting Abu Dawud 1584's translation
puts 1584 at **#1** and 1395 at **#8**; an Indonesian concept paraphrase of the zakat matn leaves
them at #171/#354.

**Verdict:** confirmed — no _general_ wording reaches 42:11 (`#56` at best, outside any top-10
cut); the only wording that reaches it #1 contains the answer text. 007's retrieval cannot be
fixed by representation alone, which is why its lever is a curated concept→anchor path, not a
query change. For 016, the pair is retrievably identical (#1/#8 under the matn), so the identity
claim has retrieval support; the _question_ alone does not reach either.

**Cost:** 10 query embeddings, vendor `usage` absent; estimated < 250 input tokens at
$0.20/MTok = **< $0.00005**. Wall clock ~3 minutes including probes.

---

## E7 — combined verdict on the 21 rows

**Question:** what does the set score if every measured change is applied?

**Setup:** the recorded 15/21 pass set from run `5d47c85b` plus each measured flip; D5 is not
counted as a pass because its citation behaviour needs a deployed run.

**Command:** arithmetic over E2–E5 (no new probe).

**Result:**

| change              | rows recovered | new total                | condition                                                           |
| ------------------- | -------------- | ------------------------ | ------------------------------------------------------------------- |
| baseline            | —              | 15/21                    | recorded run                                                        |
| D1                  | 006, 017       | 17/21                    | only if 006/017's requirement is ruled to be the ruling/instruction |
| D1 (016 group only) | —              | 15/21                    | 016 validity 1, address 0                                           |
| D2                  | 012            | 16/21 (18/21 with D1)    | curated pair                                                        |
| D3                  | 008            | 17/21 (19/21 with D1+D2) | curated set                                                         |
| D4 on top of D1     | 016            | **20/21**                | metric change, owner call                                           |
| D5                  | 007            | **21/21 conditional**    | needs the bridge built + deployed runs; not measured                |

Interactions: 016 needs **D1 and D4 together**; D3 alone closes 008; D2 alone closes 012; D1
alone closes 006 and 017 only under the requirement-scope ruling. D5 is the only row that needs
new engineering, and its recovery is not measurable locally.

**Verdict:** the memo's "five of six" is confirmed **on the instrument's verdicts**, with the
qualifications above: two of the three D1 groups rest on a requirement ruling, not a same-report
fact, and 016's pass is bought by a metric change.

**Cost:** $0.

---

## Spend and limits

- Paid spend: 10 query embeddings, <$0.00005 (vendor returned no usage; estimate from input
  tokens at the configured $0.20/MTok). No paid model call, no re-embed.
- Wall clock: ~65 minutes of the 90-minute budget.
- Not measured: a fresh deployed run under any change (the fused set is unstable run to run);
  the generator's citation choice when 42:11 is newly retrieved; the generalisation of a concept
  table to questions outside the Golden Set (no held-out set exists yet).

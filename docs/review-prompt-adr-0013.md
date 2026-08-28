# Review prompt: compare original plan vs. ADR-0013 proposal

Use this prompt when handing off to another AI agent for review. The agent should read the original plan and the proposed ADR, then deliver a structured comparison and recommendation.

## Prompt text to send

You are reviewing a proposed architectural change for the KajianQ project.

Read these documents in order:

1. Original specification: GitHub issue #1 (`Spec: KajianQ v1 — Islamic classical-knowledge chatbot on the DARS engine`). Use the GitHub REST API if `gh issue view` fails: `gh api repos/ahaqqu/KajianQ/issues/1 --jq '{title,body}'`.
2. Current translation/indexing ADR: `/home/ahaqqu/Projects/KajianQ/adr/0006-llm-translated-kitab.md`.
3. Current Neon/RagStore ADR: `/home/ahaqqu/Projects/KajianQ/adr/0008-neon-pgvector-behind-ragstore-adapter.md`.
4. Proposed ADR: `/home/ahaqqu/Projects/KajianQ/adr/0013-bilingual-retrieval-arabic-canonical-evidence.md`.
5. Related tickets (optional but recommended): #4 (Neon schema), #6 (Quran ingestion), #7 (hadith ingestion), #9 (embedding benchmark), #10 (chat pipeline), #21 (kitab tracer), #24 (terminology glossary), #25 (Deep Think).

Deliver a structured review with the following sections:

### 1. Summary of the proposal

In 2–3 sentences, what does ADR-0013 change about the original plan?

### 2. Comparison table

Compare the original plan and the proposal across these dimensions:

| Dimension | Original plan | ADR-0013 proposal | Your assessment |
|---|---|---|---|
| Canonical evidence language | | | |
| Role of Indonesian translation | | | |
| Retrieval design | | | |
| Embedding benchmark gate | | | |
| LLM context contents | | | |
| Citation validation source | | | |
| Storage/indexing overhead | | | |
| Implementation risk | | | |
| User trust / safety impact | | | |

For each row, mark whether the proposal is **better**, **worse**, **neutral**, or **unclear** versus the original plan, and give one sentence of reasoning.

### 3. Technical correctness check

Answer these questions:

- Is cross-lingual Indonesian → Arabic retrieval technically feasible with the current embedding model choice (`gemini-embedding-001`)? What evidence or precedent supports your answer?
- Does storing Arabic as the sole canonical evidence break any requirement in spec #1 or in ADR-0006/ADR-0008?
- Does the proposal introduce any new failure modes that the original plan does not have?
- Are there any tickets whose acceptance criteria would need to change if ADR-0013 is accepted? List them and the specific changes.

### 4. Open questions

List the most important unresolved questions from ADR-0013, plus any new ones you identify. For each, say whether it can be answered by code/benchmarks, by a human domain expert, or by further research.

### 5. Recommendation

Choose one of the following and justify in 3–5 sentences:

- **Accept ADR-0013 as written.**
- **Accept with amendments** — specify the amendments.
- **Reject ADR-0013** — keep the original plan and explain why.
- **Defer** — collect more evidence before deciding; say what evidence and which ticket should produce it.

Your recommendation should weigh user trust (strict citations, Arabic originals), retrieval quality (can Indonesian queries find Arabic evidence?), engineering cost (dual indices, re-embedding), and alignment with the existing spec and ADRs.

### 6. Next concrete step

Regardless of your recommendation, name the single next action the project should take to resolve the question.

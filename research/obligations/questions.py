#!/usr/bin/env python3
"""The six measured questions and their declared evidence requirements.

`required_groups` is a conjunction of alternatives: every group must have at
least one member present in the context (coverage) and at least one member
cited (grounding). The addresses are normalized citation labels, so spelling
variants are compared through `kq.normalize_label`.

Five of the six carry a requirement this repository already owns:

* `gs-v0-016` / `gs-v0-006` — the Golden Set's `requiredCitations`;
* `gs-v0-022` — the replacement row in the in-review `agent/648-014-wording`
  branch, the only row that states an istri/ibu question;
* `q-owner` / `q-tri` — researcher-declared: the Jibril hadith is the corpus
  passage that defines iman, islam and ihsan in one narration, and the owner's
  measured baseline cited exactly these two labels (Bukhari 4777, Muslim 97).
  Declaring it makes the comparison's evidence requirement falsifiable without
  pretending the Golden Set fixes a comparison row;
* `q-ruling` — researcher-declared multi-part ruling: Bukhari 1503 states the
  zakat-fitrah obligation, amount, who and timing; Bukhari 1395 the zakat
  obligation itself. Two obligations, two addresses, both required.
"""

QUESTIONS: list[dict] = [
    {
        "id": "q-owner",
        "question": "Apa beda ihsan dan iman?",
        "language": "id",
        "kind": "comparison (owner's)",
        "required_groups": [["hr. bukhari no. 4777", "hr. muslim no. 97"]],
        "required_source": "researcher-declared (Jibril hadith; the owner's cited evidence)",
    },
    {
        "id": "q-tri",
        "question": "Apa perbedaan iman, islam, dan ihsan?",
        "language": "id",
        "kind": "comparison (three terms)",
        "required_groups": [["hr. bukhari no. 4777", "hr. muslim no. 97"]],
        "required_source": "researcher-declared (Jibril hadith defines all three)",
    },
    {
        "id": "gs-v0-022",
        "question": "Siapa yang harus diutamakan: istri atau ibu?",
        "language": "id",
        "kind": "comparison (istri/ibu)",
        "required_groups": [["hr. bukhari no. 5971"]],
        "required_source": "Golden Set replacement row, in-review agent/648-014-wording",
    },
    {
        "id": "gs-v0-016",
        "question": "Which hadith describes the obligations of Zakat, and what does it say?",
        "language": "en",
        "kind": "ruling (zakat obligations)",
        "required_groups": [["hr. bukhari no. 1395"]],
        "required_source": "Golden Set requiredCitations",
    },
    {
        "id": "gs-v0-006",
        "question": "Apakah menjamak shalat saat safar diperbolehkan? Sebutkan dalilnya.",
        "language": "id",
        "kind": "ruling with dalil (jamak)",
        "required_groups": [["hr. bukhari no. 1108"]],
        "required_source": "Golden Set requiredCitations",
    },
    {
        "id": "q-ruling",
        "question": "Apa hukum zakat fitrah dan zakat mal, dan siapa yang wajib mengeluarkannya?",
        "language": "id",
        "kind": "multi-part ruling (zakat fitrah + zakat mal)",
        "required_groups": [["hr. bukhari no. 1503"], ["hr. bukhari no. 1395"]],
        "required_source": "researcher-declared (two addresses, both required)",
    },
]


def by_id(identifier: str) -> dict:
    for question in QUESTIONS:
        if question["id"] == identifier:
            return question
    raise KeyError(identifier)

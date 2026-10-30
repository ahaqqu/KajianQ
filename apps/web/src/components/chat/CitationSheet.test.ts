// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ChatCitation, ChatSessionMessage } from "@app/contracts";
import { LocaleCtx } from "../../lib/i18n";
import { CitationSheet } from "./CitationSheet";
import { MessageCard } from "./MessageCard";

// React 19 + vitest: mark the environment for act() (testing-library's flushes).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

/**
 * The citation sheet's per-chain view (spec §9.5).
 *
 * The invariant: the sheet shows the transmission evidence the trace recorded —
 * every row, in the record's order, each with its own grade, its grader and its
 * Arabic sanad — and it never flattens that to one badge. A passage whose chains
 * disagree must read as disagreement; a single badge would be the v1 claim this
 * change removes.
 */

const BASE: ChatCitation = {
  label: "HR. Bukhari no. 1",
  arabic: "حدثنا",
  machineTranslated: false,
  source: "HR. Bukhari",
};

function renderSheet(citation: ChatCitation) {
  render(
    createElement(
      LocaleCtx.Provider,
      { value: "id" },
      createElement(CitationSheet, { citation, onClose: () => {} }),
    ),
  );
}

const texts = (testId: string): (string | null)[] =>
  screen.queryAllByTestId(testId).map((node) => node.textContent);

describe("CitationSheet — per-chain transmission evidence", () => {
  it("renders every stored row with its own grade, grader and Arabic sanad", () => {
    renderSheet({
      ...BASE,
      chains: [
        {
          narrators: [
            { id: "n1", nameAr: "نافع" },
            { id: "n2", nameAr: "ابن عمر" },
          ],
          grade: "sahih",
          grader: "al-bukhari",
        },
        {
          narrators: [{ id: "n1", nameAr: "نافع" }],
          grade: "dhaif",
          grader: "al-daraqutni",
        },
      ],
    });

    expect(texts("citation-chain")).toHaveLength(2);
    // Both grades render, including the weak one the flattened model would hide
    // behind the stronger chain: the sheet never picks the best row.
    expect(texts("grade-badge")).toEqual(["sahih", "dhaif"]);
    expect(texts("citation-grader")).toEqual(["penilai: al-bukhari", "penilai: al-daraqutni"]);
    // The sanad section is labelled like every other section of the sheet.
    expect(screen.getAllByText("Jalur periwayatan")).toHaveLength(1);
    // The sanad renders in the record's order, not sorted or deduped.
    const sanads = screen.getAllByTestId("citation-sanad");
    expect(sanads[0]?.getAttribute("dir")).toBe("rtl");
    expect(sanads[0]?.textContent).toBe("نافع < ابن عمر");
    expect(sanads[1]?.textContent).toBe("نافع");
  });

  it("marks an unread passage and suppresses its flattened grade", () => {
    renderSheet({ ...BASE, grade: "sahih", chainsUnread: true });
    // The read never covered this passage, so its flat grade is not evidence: the
    // sheet has to say the chains were not read and show no verdict at all.
    expect(texts("grade-badge")).toEqual([]);
    expect(texts("citation-chains-unread")[0]).toContain("tidak dibaca");
  });

  it("shows no flat grade badge when the chains are present", () => {
    renderSheet({
      ...BASE,
      grade: "sahih",
      chains: [
        { narrators: [{ id: "n1", nameAr: "نافع" }], grade: "dhaif", grader: "al-daraqutni" },
      ],
    });

    // The flattened field would read "sahih" beside a dhaif chain — exactly the
    // upgrade this view must not present.
    expect(texts("grade-badge")).toEqual(["dhaif"]);
  });

  it("keeps the flat grade for a citation whose run recorded no chain", () => {
    renderSheet({ ...BASE, grade: "dhaif" });
    expect(texts("grade-badge")).toEqual(["dhaif"]);
    expect(screen.queryByTestId("citation-chains")).toBeNull();
  });

  it("says a row is ungraded rather than borrowing another row's grade", () => {
    renderSheet({
      ...BASE,
      chains: [
        { narrators: [{ id: "n1", nameAr: "نافع" }], grade: "sahih", grader: "al-bukhari" },
        { narrators: [{ id: "n2", nameAr: "ابن عمر" }] },
      ],
    });

    expect(texts("citation-chain-ungraded")).toEqual(["tanpa penilaian"]);
    // An unresolved narrator keeps its id: the chain is never shortened to the
    // narrators whose names resolved.
  });

  it("says a bounded list is a prefix, and keeps an unresolved narrator's id", () => {
    renderSheet({
      ...BASE,
      chains: [
        { narrators: [{ id: "n1" }], grade: "hasan", grader: "al-tirmidhi", moreMayExist: true },
      ],
    });

    expect(texts("citation-chain-truncated")).toEqual(["sanad lain tidak ditampilkan"]);
    expect(screen.getByTestId("citation-sanad").textContent).toBe("n1");
  });
});

/**
 * The sheet's footer flags come from MessageCard. A chained passage must offer a
 * grade flag per rendered row and no flat-grade flag: the flat anchor cannot name
 * which sanad the reader disputes, so the server could not resolve it to a row.
 */
describe("MessageCard — a chained citation's grade flags name their rows", () => {
  const MESSAGE: ChatSessionMessage = {
    id: "m1",
    role: "assistant",
    content: "Hadits [HR. Bukhari no. 1].",
    createdAt: 1,
    citations: {
      messageId: "m1",
      refusal: false,
      dhaifWarning: false,
      citations: [
        {
          ...BASE,
          grade: "sahih",
          chains: [
            {
              narrators: [{ id: "n1", nameAr: "نافع" }],
              grade: "sahih",
              grader: "al-bukhari",
            },
            {
              narrators: [{ id: "n2", nameAr: "ابن عمر" }],
              grade: "dhaif",
              grader: "al-daraqutni",
            },
          ],
        },
      ],
    },
  };

  it("renders one flag per chain row and none for the flattened grade", () => {
    render(
      createElement(
        LocaleCtx.Provider,
        { value: "id" },
        createElement(MessageCard, { message: MESSAGE, persisted: true }),
      ),
    );
    fireEvent.click(screen.getByTestId("citation-chip"));
    expect(screen.getByTestId("flag-chain-0")).toBeTruthy();
    expect(screen.getByTestId("flag-chain-1")).toBeTruthy();
    expect(screen.queryByTestId("flag-grade")).toBeNull();
  });
});

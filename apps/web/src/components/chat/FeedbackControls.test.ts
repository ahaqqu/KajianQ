// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";
import type { ChatCitation } from "@app/contracts";
import { chainGradeAnchor } from "./FeedbackControls";

/**
 * The grade flag on a chained citation. The anchor must name the specific row —
 * its position plus the row's own verdict — because the server resolves it
 * against the citation's `chains`; a label-only anchor names the passage and
 * cannot distinguish two disagreeing rows.
 */
const CITATION: ChatCitation = {
  label: "HR. Bukhari no. 1",
  arabic: "حدثنا",
  grade: "sahih",
  machineTranslated: false,
};

describe("chainGradeAnchor", () => {
  it("names the row's position and its own grade and grader", () => {
    expect(
      chainGradeAnchor(
        CITATION,
        { narrators: [{ id: "n1" }], grade: "dhaif", grader: "al-daraqutni" },
        1,
      ),
    ).toEqual({
      type: "chain",
      category: "questionable_grade",
      id: "HR. Bukhari no. 1",
      chainIndex: 1,
      grade: "dhaif",
      grader: "al-daraqutni",
    });
  });

  it("keeps an ungraded row's anchor free of borrowed attribution", () => {
    const anchor = chainGradeAnchor(CITATION, { narrators: [{ id: "n1" }] }, 0);
    expect(anchor).toEqual({
      type: "chain",
      category: "questionable_grade",
      id: "HR. Bukhari no. 1",
      chainIndex: 0,
    });
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The GDPR documents are compliance artefacts, and the failure mode that
 * matters for them is not a broken link — it is a claim that has quietly
 * stopped being true, in the direction that UNDERSTATES the posture. Nothing
 * else in CI reads them, and both are cited from code
 * (`apps/web/src/lib/privacy-notice*.ts`, which renders the public notice), so
 * a stale sentence here is a false statement the product makes to visitors.
 *
 * These tests pin the specific defects found by reading the two documents
 * against the code, plus the structural rule that keeps them from
 * re-acquiring the same class of drift.
 *
 * They are deliberately textual and few. A test that tried to verify GDPR
 * compliance would be theatre; a test that pins "this document must not
 * contradict that one about a fact we can check in the source" is not.
 */

const read = (rel) => readFileSync(resolve(process.cwd(), rel), "utf8");
const ART30 = "docs/GDPR-ARTICLE-30-RECORD.md";
const DPIA = "docs/GDPR-DPIA-LITE.md";

describe("the GDPR documents do not contradict the code or each other", () => {
  it("the DPIA does not claim the personalData gap is open when it is closed", () => {
    // The defect: the DPIA's mitigation table said "serving call sites do not
    // set the flag yet, an open precondition tracked by #181" while its own §4,
    // thirty lines later, recorded the gap as Closed (2026-09-21). The stale
    // half understated the privacy posture in a document whose whole job is to
    // demonstrate it. Verified against the source rather than taken on trust:
    const generator = read("packages/kajianq-domain/src/chat-generator.ts");
    const retriever = read("packages/kajianq-domain/src/chat-retriever.ts");
    expect(generator).toMatch(/personalData: true/);
    expect(retriever).toMatch(/personalData: true/);
    // …and the enforcement test exists, which is what makes "closed" checkable.
    expect(read("apps/api/src/lib/personal-data-serving.test.ts")).toMatch(/personalData/);

    const dpia = read(DPIA);
    // No sentence may claim the flag is unset at serving call sites.
    expect(dpia).not.toMatch(/call sites do not set the flag yet/);
    expect(dpia).not.toMatch(/an open precondition tracked by #181/);
  });

  it("no GDPR document cites Cloudflare Worker cron syntax as a live mechanism", () => {
    // The DPIA cited `crons: ["17 3 * * *"]` for the reclamation schedule. That
    // is Worker cron syntax; the schedule is now a systemd timer
    // (provision/vps/systemd/kajianq-cron.timer, OnCalendar=*-*-* 03:17:00).
    // A citation naming a mechanism that no longer exists is how a reader
    // concludes the control is unmanaged.
    expect(read("provision/vps/systemd/kajianq-cron.timer")).toMatch(
      /OnCalendar=\*-\*-\* 03:17:00/,
    );
    for (const doc of [ART30, DPIA]) {
      expect(read(doc), doc).not.toMatch(/crons:/);
    }
  });

  it("executed work is stated in the past tense, not as pending", () => {
    // The migration is done and Cloudflare + Neon are deleted. A document that
    // still says it "executes the move" reads as a plan someone forgot to
    // finish, which is exactly the drift swept in #206/#181.
    const dpia = read(DPIA);
    expect(dpia).not.toMatch(/GDPR-E \(#181\) executes the move/);
    expect(dpia).not.toMatch(/while the migration is pending/);
    // The closure must be stated, so the tense is not merely deleted.
    expect(dpia).toMatch(/Closed \(2026-09-21\)/);
  });

  it("the Art. 30 register remains the single source of truth for the measures", () => {
    // The structural rule that prevents the duplication returning. The DPIA's
    // §3 used to restate the mitigation list with its own evidence column,
    // which is how it came to disagree with §4 about the personalData flag: two
    // copies of one fact drift. §7 of the record holds the measures; the note
    // holds only the Art. 9 reasoning about them.
    const dpia = read(DPIA);
    const art30 = read(ART30);
    // The pointer must be present, and must name §7 — not "the record" vaguely.
    expect(dpia).toMatch(/GDPR-ARTICLE-30-RECORD\.md[\s\S]{0,80}§7/);
    expect(dpia).toMatch(/single source of truth/);
    expect(art30).toMatch(/single source of truth for the\s+measures/);

    // And both must say why they are separate, so the merge gets proposed
    // again by the next reader who notices the overlap.
    for (const doc of [ART30, DPIA]) {
      expect(read(doc), doc).toMatch(/point-in-time|different lifecycles/);
    }
  });

  it("the Art. 30 record does not restate ADR-0043's values as its own", () => {
    // The record derives from ADR-0043 and says so; if it ever starts
    // asserting values independently, the two can drift and the DPA
    // declaration block (§9) would be the copy that is wrong.
    const art30 = read(ART30);
    expect(art30).toMatch(/ADR-0043 is the source of truth/);
  });
});

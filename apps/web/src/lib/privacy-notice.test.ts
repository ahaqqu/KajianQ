/// <reference types="node" />
// The drift guards below read repo files, which the app bundle cannot, hence the module mirrors
// them. The Node reference is file-scoped because the web tsconfig types the app for the browser.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  CONTROLLER,
  ERASURE,
  REGISTER_RULE,
  REGISTER_SOURCE,
  RETENTION,
  STORAGE,
  SUB_PROCESSORS,
  type ProcessorStatus,
  type ProcessorTier,
  type RetentionItem,
  type RetentionStatus,
  type SubProcessor,
} from "./privacy-notice";
import { messages } from "./i18n";

/**
 * The privacy notice is a compliance disclosure, so its two honesty rules are pinned here
 * rather than trusted to review:
 *
 *   1. **The register is the Art. 30 record's, not prose this module owns.** The tests read the
 *      record's register table and `models.json` and assert the module renders exactly those rows,
 *      tiers and personal-data verdicts.
 *   2. **No claim without code.** A `current` retention row points at behavior that exists
 *      (the adapter's TTL constant, the erasure route); a `planned` row carries its ticket,
 *      and never the reverse.
 */

const ROOT = new URL("../../../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");

/** Every `.ts`/`.tsx` source file under the given dirs, read from disk because the app bundle
 * cannot walk the repo; deterministic, sorted, with `node_modules` and build output excluded. */
function walkSources(dirs: string[]): string[] {
  const files: string[] = [];
  const walk = (relative: string): void => {
    const entries = readdirSync(new URL(relative, ROOT), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".wrangler")
        continue;
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry.name) && statSync(new URL(path, ROOT)).isFile())
        files.push(path);
    }
  };
  for (const dir of dirs) walk(dir);
  return files;
}

const ROPA = read("docs/GDPR-ARTICLE-30-RECORD.md");
const MODELS_JSON = JSON.parse(read("packages/infra/src/providers/models.json")) as {
  vendors: Record<string, { freeTier: boolean; personalDataAllowed: boolean }>;
};
const SESSION_ADAPTER = read("packages/infra/src/rag-store-postgres-session.ts");
const AUTH_ROUTE = read("apps/api/src/routes/auth.ts");

type RegisterRow = { vendor: string; cells: string[] };

/** The record's text between one `## ` heading and the next, so a parse cannot
 * wander into another section's tables. */
function recordSection(heading: string): string {
  const start = ROPA.indexOf(heading);
  if (start < 0) throw new Error(`the Art. 30 record has no "${heading}" section`);
  const rest = ROPA.slice(start + heading.length);
  const end = rest.indexOf("\n## ");
  return end < 0 ? rest : rest.slice(0, end);
}

/** The §6 retention table's row for a category, so a value is read beside the
 * category it belongs to rather than anywhere in the document. */
function retentionRow(category: string): { category: string; retention: string } {
  for (const raw of recordSection("## 6. Retention").split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 3 || cells[0] === "Category") continue;
    if (cells[0]!.toLowerCase().includes(category.toLowerCase())) {
      return { category: cells[0]!, retention: cells[1]! };
    }
  }
  throw new Error(`no §6 retention row for ${category} in the Art. 30 record`);
}

/** The Art. 30 record's register table, parsed from its §8. */
function ropaRegisterRows(): RegisterRow[] {
  const rows: RegisterRow[] = [];
  for (const raw of recordSection("## 8. Recipients and sub-processor chain").split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    // The register is the record's only five-column table; this drops the header
    // and the `|---|` separator without depending on their exact wording.
    if (cells.length !== 5) continue;
    // A retired processor's row is struck through, so the emphasis goes too.
    const vendor = cells[0]!.replace(/\*\*|~~/g, "").trim();
    if (vendor.length === 0 || vendor === "Processor" || /^[-\s]+$/.test(vendor)) continue;
    rows.push({ vendor, cells });
  }
  return rows;
}

const REGISTER_ROWS = ropaRegisterRows();

/** The register row whose vendor name starts with the notice row's name. */
function ropaRowFor(vendor: string): RegisterRow {
  const row = REGISTER_ROWS.find((candidate) => candidate.vendor.startsWith(vendor));
  if (!row) throw new Error(`no register row for ${vendor} in the Art. 30 record`);
  return row;
}

const byId = (id: string): SubProcessor => {
  const row = SUB_PROCESSORS.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`no notice row ${id}`);
  return row;
};

const retentionById = (id: string): RetentionItem => {
  const row = RETENTION.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`no retention row ${id}`);
  return row;
};

/** The vendor catalog ids behind the notice rows that name an LLM vendor; the paid Gemini row
 * is a separate catalog vendor (`gemini-paid`) because the register rule keys on terms. */
const CATALOG_IDS: Record<string, string> = {
  gemini: "gemini",
  "gemini-paid": "gemini-paid",
  deepseek: "deepseek",
  "ollama-cloud": "ollama-cloud",
  alibaba: "qwen",
  typesafe: "typesafe",
};

const STATUS_KEY = {
  current: "aboutPrivacyStatusCurrent",
  transition: "aboutPrivacyStatusTransition",
  planned: "aboutPrivacyStatusPlanned",
  "no-serving-role": "aboutPrivacyStatusNoServingRole",
} as const;

describe("privacy notice: the register mirrors the Art. 30 record", () => {
  it("parsed the record's register (so the drift guards below are not vacuous)", () => {
    expect(REGISTER_ROWS.length).toBeGreaterThanOrEqual(7);
    expect(REGISTER_ROWS[0]!.vendor).toContain("netcup");
  });

  it("carries every register row, and no row the record does not", () => {
    for (const processor of SUB_PROCESSORS) {
      expect(
        REGISTER_ROWS.some((row) => row.vendor.startsWith(processor.name)),
        `${processor.name} is not in the Art. 30 record's register`,
      ).toBe(true);
    }
    for (const row of REGISTER_ROWS) {
      expect(
        SUB_PROCESSORS.some((processor) => row.vendor.startsWith(processor.name)),
        `register row "${row.vendor}" has no notice row`,
      ).toBe(true);
    }
    expect(SUB_PROCESSORS.length).toBe(REGISTER_ROWS.length);
  });

  it("takes each row's tier from the register's Tier column, not from prose", () => {
    const tierOf = (row: RegisterRow): ProcessorTier => {
      const cell = row.cells[3]!.toLowerCase();
      if (cell.includes("paid")) return "paid";
      if (cell.includes("free")) return "free";
      throw new Error(`unrecognized tier cell for ${row.vendor}: ${row.cells[3]}`);
    };
    for (const processor of SUB_PROCESSORS) {
      expect(tierOf(ropaRowFor(processor.name)), `${processor.name} tier`).toBe(processor.tier);
    }
  });

  it("marks a vendor not-for-personal-data exactly when the register's verdict says so", () => {
    for (const processor of SUB_PROCESSORS) {
      const row = ropaRowFor(processor.name);
      const expected = /not permitted/i.test(row.cells[4]!) ? "not-for-personal-data" : "permitted";
      expect(processor.verdict, `${processor.name} verdict`).toBe(expected);
    }
  });

  it("keeps the register's rule: a free tier never carries personal data", () => {
    for (const processor of SUB_PROCESSORS) {
      if (processor.tier !== "free") continue;
      // Permitted on a free tier only when the row carries no serving-path personal data: a
      // transition row the migration strips, or a decommissioned row whose processing ended.
      expect(processor.verdict === "permitted", `${processor.name} is free-tier`).toBe(
        processor.status === "transition" || processor.status === "no-serving-role",
      );
    }
  });

  it("agrees with models.json's machine-checkable shadow, in both directions", () => {
    for (const processor of SUB_PROCESSORS) {
      const catalogId = CATALOG_IDS[processor.id];
      if (catalogId === undefined) continue;
      const vendor = MODELS_JSON.vendors[catalogId];
      expect(vendor, `${catalogId} missing from models.json`).toBeDefined();
      expect(vendor!.freeTier, `${catalogId} freeTier`).toBe(processor.tier === "free");
      expect(vendor!.personalDataAllowed, `${catalogId} personalDataAllowed`).toBe(
        processor.verdict === "permitted",
      );
    }
    // A catalog vendor that denies personal data must be registered here as
    // such, or the notice would understate a rule the seam enforces.
    for (const [id, vendor] of Object.entries(MODELS_JSON.vendors)) {
      if (vendor.personalDataAllowed) continue;
      const row = SUB_PROCESSORS.find((processor) => CATALOG_IDS[processor.id] === id);
      expect(row, `${id} denies personal data but is not in the notice`).toBeDefined();
      expect(row!.verdict).toBe("not-for-personal-data");
    }
  });

  it("states the hosting move honestly: netcup live, Cloudflare archives-only, Neon gone", () => {
    // Netcup is the live host; Cloudflare keeps only the at-rest R2 archive and Neon is
    // decommissioned. Both stay registered: the archive bears personal data.
    expect(byId("netcup").status).toBe("current");
    expect(byId("cloudflare").status).toBe("no-serving-role");
    expect(byId("neon").status).toBe("no-serving-role");
    // The register says the same in its own rows, so a reader is never sent to a
    // processor that no longer serves.
    expect(ropaRowFor("Neon").cells[1], "the Neon row").toMatch(/decommissioned/i);
    expect(ropaRowFor("Cloudflare").cells[4], "the Cloudflare verdict").toMatch(
      /at-rest archives only/i,
    );
  });

  it("does not claim a transition row is gone before decommissioning is approved", () => {
    // Decommissioning is owner-gated, so a row may not silently disappear from the register —
    // the move narrows it, it does not erase it.
    for (const processor of SUB_PROCESSORS) {
      if (processor.status !== "transition") continue;
      expect(processor.note, `${processor.id} has no narrowing note`).toBeDefined();
    }
  });

  it("gives every vendor a role and a personal-data line in both locales", () => {
    for (const processor of SUB_PROCESSORS) {
      for (const field of ["role", "personalData"] as const) {
        const copy = processor[field];
        expect(copy.en.length, `${processor.id}.${field}.en`).toBeGreaterThan(0);
        expect(copy.id.length, `${processor.id}.${field}.id`).toBeGreaterThan(0);
        expect(copy.en, `${processor.id}.${field}`).not.toBe(copy.id);
      }
      // A legal/brand name is never translated.
      expect(processor.name, processor.id).not.toMatch(/[^\x20-\x7e]/);
    }
  });

  it("states the register rule and the controller line in both locales", () => {
    for (const copy of [REGISTER_RULE, CONTROLLER.body]) {
      expect(copy.en.length).toBeGreaterThan(0);
      expect(copy.id.length).toBeGreaterThan(0);
      expect(copy.en).not.toBe(copy.id);
    }
  });
});

describe("privacy notice: retention is the record's values, enforced by real code", () => {
  it("states the 30-day session TTL the adapter actually implements", () => {
    const ttl = /const SESSION_TTL_MS = (\d+) \* 24 \* 60 \* 60 \* 1000/.exec(SESSION_ADAPTER);
    expect(ttl, "the adapter's SESSION_TTL_MS is not in the expected shape").not.toBeNull();
    const days = Number(ttl![1]);
    expect(days).toBe(30);
    const session = retentionById("sessions");
    expect(session.window.en).toContain(`${days} days`);
    expect(session.window.id).toContain(`${days} hari`);
    // The record's own §6 row for this category fixes the same value, so mutating the
    // window — here or in the row — fails before the copy can drift. The cell opens with
    // the value, and the assertion is anchored there: the row's later summary sentence
    // repeats the figure, so a substring match would survive a change to the real one.
    const row = retentionRow("Anonymous sessions");
    expect(row.retention).toMatch(new RegExp(`^\\*\\*${days} days of inactivity\\*\\*`));
    expect(row.retention).toContain("no separate age-based deletion of chat rows");
  });

  it("states the 14-day access-log and 30-day backup windows the record fixes", () => {
    expect(retentionRow("Server access logs").retention).toMatch(/^\*\*14 days\*\*/);
    expect(retentionRow("Backups").retention).toMatch(/^\*\*30 days rolling\*\*/);
    const accessLogs = RETENTION.find((item) => item.id === "access-logs")!;
    expect(accessLogs.window.en).toContain("14 days");
    expect(accessLogs.window.id).toContain("14 hari");
    const backups = RETENTION.find((item) => item.id === "backups")!;
    expect(backups.window.en).toContain("30-day");
    expect(backups.window.id).toContain("30 hari");
  });

  it("states no retention window the record does not fix", () => {
    const allowedDays = new Set(["14", "30"]);
    for (const item of RETENTION) {
      const stated = [...item.window.en.matchAll(/(\d+)[- ]day/g)].map((match) => match[1]!);
      for (const days of stated) {
        expect(allowedDays, `${item.id} states ${days} days`).toContain(days);
      }
    }
  });

  it("never lets a planned row claim to be live, nor a live row carry a ticket", () => {
    for (const item of RETENTION) {
      if (item.status === "planned") expect(item.planRef, item.id).toBeTruthy();
      else expect(item.planRef, item.id).toBeUndefined();
    }
    const current = RETENTION.filter((item) => item.status === "current").map((item) => item.id);
    expect(current).toContain("sessions");
    expect(current).toContain("erasure");
    // Every stated retention window is enforced by something live on the host, so no row may
    // remain `planned`: that understates the protection the controller provides — the same
    // honesty failure as the reverse. A future window lands as `planned` plus its ticket.
    expect(RETENTION.filter((item) => item.status === "planned")).toEqual([]);
    expect(current.sort()).toEqual(RETENTION.map((item) => item.id).sort());
  });

  it("says there is no separate age-based deletion of chat rows", () => {
    expect(retentionRow("Anonymous sessions").retention).toContain(
      "no separate age-based deletion of chat rows",
    );
    const session = retentionById("sessions");
    expect(session.window.en).toContain("no separate age-based deletion");
    expect(session.window.id).toContain("Tidak ada penghapusan berbasis usia terpisah");
  });

  it("names the record as the register's source in both locales", () => {
    // The provenance line is user-visible, so a reader sent to the wrong artifact is the
    // failure this pins; the rule that the rows enforce is ADR-0043 decision 3.
    for (const [locale, copy] of Object.entries(REGISTER_SOURCE)) {
      expect(copy, `${locale} provenance names the Art. 30 record`).toContain(
        "GDPR-ARTICLE-30-RECORD.md",
      );
      expect(copy, `${locale} provenance names the rule`).toContain("ADR-0043");
    }
  });

  it("gives every row what / window / enforcedBy in both locales", () => {
    for (const item of RETENTION) {
      for (const field of ["what", "window", "enforcedBy"] as const) {
        const copy = item[field];
        expect(copy.en.length, `${item.id}.${field}.en`).toBeGreaterThan(0);
        expect(copy.id.length, `${item.id}.${field}.id`).toBeGreaterThan(0);
        expect(copy.en, `${item.id}.${field}`).not.toBe(copy.id);
      }
    }
  });
});

describe("privacy notice: erasure points at the route that exists", () => {
  it("names the self-deletion endpoint the API actually mounts", () => {
    expect(AUTH_ROUTE).toContain('.delete("/v1/auth/me"');
    expect(`${ERASURE.method} ${ERASURE.path}`).toBe("DELETE /v1/auth/me");
  });

  it("lists the four subtrees the cascade removes, all of which the route documents", () => {
    expect(/sessions, chat sessions and messages, feedback, answer traces/.test(AUTH_ROUTE)).toBe(
      true,
    );
    for (const term of ["sessions", "chat", "trace", "feedback"]) {
      expect(ERASURE.what.en.toLowerCase()).toContain(term);
    }
  });

  it("records the missing UI control instead of inventing an affordance", () => {
    // The gap is real (no erase control in apps/web today) and the copy says so.
    expect(ERASURE.uiAffordance).toBe("absent");
    expect(ERASURE.noUiNote.en).toContain("no button for this yet");
    expect(ERASURE.noUiNote.id).toContain("belum punya tombol");
    // The local-first posture invites reading "clearing local storage" as erasure, so the
    // distinction is stated.
    expect(ERASURE.localNote.en).toContain("only changes what this browser holds");
    expect(ERASURE.localNote.en).toContain("server-side copy stays");
    expect(ERASURE.localNote.id).toContain("hanya mengubah apa yang dipegang peramban ini");
  });

  it("gives the erasure copy both locales", () => {
    for (const copy of [ERASURE.what, ERASURE.noUiNote, ERASURE.localNote]) {
      expect(copy.en.length).toBeGreaterThan(0);
      expect(copy.id.length).toBeGreaterThan(0);
      expect(copy.en).not.toBe(copy.id);
    }
  });
});

describe("privacy notice: labels are externalized", () => {
  const KEYS = [
    "aboutPrivacyLabel",
    "aboutPrivacyBody",
    "aboutPrivacyControllerLabel",
    "aboutPrivacyProcessorsLabel",
    "aboutPrivacyRoleLabel",
    "aboutPrivacyDataLabel",
    "aboutPrivacyStatusCurrent",
    "aboutPrivacyStatusTransition",
    "aboutPrivacyStatusPlanned",
    "aboutPrivacyStatusNoServingRole",
    "aboutPrivacyTierPaid",
    "aboutPrivacyTierFree",
    "aboutPrivacyVerdictPermitted",
    "aboutPrivacyVerdictNotForPersonalData",
    "aboutPrivacyPlannedPrefix",
    "aboutPrivacyRetentionLabel",
    "aboutPrivacyErasureLabel",
    "aboutPrivacyStorageLabel",
  ] as const;

  it("has every notice label in both locales", () => {
    for (const key of KEYS) {
      expect(messages.en[key].length, `${key}.en`).toBeGreaterThan(0);
      expect(messages.id[key].length, `${key}.id`).toBeGreaterThan(0);
    }
  });

  it("names each distinct processor status", () => {
    const statuses: ProcessorStatus[] = ["current", "transition", "planned", "no-serving-role"];
    const labels = statuses.map((status) => messages.id[STATUS_KEY[status]]);
    expect(new Set(labels).size).toBe(statuses.length);
  });

  it("keeps the retention status pair distinct", () => {
    const retentionStatuses: RetentionStatus[] = ["current", "planned"];
    const labels = retentionStatuses.map((status) => messages.id[STATUS_KEY[status]]);
    expect(new Set(labels).size).toBe(retentionStatuses.length);
  });
});

describe("privacy notice: browser storage is stated from the code that stores it", () => {
  it("names the localStorage keys the app actually writes", () => {
    // The claim is pinned to each key's source, not to prose: the keys are the owning modules'
    // exported constants re-exported through `privacy-notice.ts`, so a rename breaks the typecheck.
    const chatStore = read("apps/web/src/lib/chat-store.ts");
    const theme = read("apps/web/src/lib/theme.ts");
    const declared = [
      ...chatStore.matchAll(/export const (?:SESSION|TOKEN|HISTORY)_KEY = "([^"]+)"/g),
      ...theme.matchAll(/export const THEME_KEY = "([^"]+)"/g),
    ].map((match) => match[1]!);
    expect(declared.sort()).toEqual([...STORAGE.keys].sort());
  });

  it("claims no cookies only because the code sets none", () => {
    expect(STORAGE.setsCookies).toBe(false);
    // The whole web app and the whole API are scanned: a cookie added in any other component,
    // route, or helper makes the /about notice stale, and this assertion is the tripwire.
    const sources = walkSources(["apps/web/src", "apps/api/src"]);
    // The notice module's doc comment names `document.cookie` to explain the
    // claim, and this test asserts about it — neither is a cookie use.
    const prose = new Set([
      "apps/web/src/lib/privacy-notice-storage.ts",
      "apps/web/src/lib/privacy-notice.test.ts",
    ]);
    expect(sources.length).toBeGreaterThan(100);
    for (const file of sources) {
      if (prose.has(file)) continue;
      const source = read(file);
      expect(
        /document\.cookie|["']set-cookie["']/i.test(source),
        `${file} writes a cookie — the /about notice says none is set`,
      ).toBe(false);
    }
  });

  it("states the functional-only exemption and the self-erase path in both locales", () => {
    expect(STORAGE.body.en).toContain("sets no cookies");
    expect(STORAGE.body.en).toContain("no tracking");
    expect(STORAGE.body.id).toContain("tidak memasang cookie");
    expect(STORAGE.body.id).toContain("tanpa pelacakan");
    expect(STORAGE.body.en.toLowerCase()).toContain("erase them yourself");
    expect(STORAGE.body.id.toLowerCase()).toContain("menghapusnya sendiri");
    expect(STORAGE.body.en).not.toBe(STORAGE.body.id);
  });

  it("names no processor, vendor, or retention window", () => {
    // UI-posture copy, not register data: a named vendor or a day count here would make it
    // register data and it would need a row in the Art. 30 record's register.
    for (const copy of [STORAGE.body.en, STORAGE.body.id]) {
      expect(copy, "storage copy names a day count").not.toMatch(/\b\d+[- ](day|hari)\b/i);
      for (const vendor of SUB_PROCESSORS) {
        expect(copy, `storage copy names ${vendor.name}`).not.toContain(vendor.name);
      }
    }
  });
});

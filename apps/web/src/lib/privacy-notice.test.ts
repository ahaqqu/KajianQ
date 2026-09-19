/// <reference types="node" />
// The drift guards below read the register and the enforcing code from the repo
// (Node can; the app bundle cannot, which is why the module mirrors them). The
// directive is file-scoped because `apps/web/tsconfig.json` types the app for
// the browser only.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTROLLER,
  ERASURE,
  REGISTER_RULE,
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
 * The privacy notice (#179, GDPR-C) is a compliance disclosure, so its two
 * honesty rules are pinned here rather than trusted to review:
 *
 *   1. **The register is ADR-0043's, not prose this module owns.** The tests
 *      read the ADR's register table and `models.json` and assert the module
 *      renders exactly those rows with exactly those tiers and personal-data
 *      verdicts — the drift the ticket forbids.
 *   2. **No claim without code.** A `current` retention row points at behavior
 *      that exists today (the adapter's TTL constant, the erasure route); a
 *      `planned` row carries its ticket. A row may never claim to be live
 *      without the code behind it, and may never carry a ticket while live.
 *
 * The markdown registers are read here in the test (Node can read repo files);
 * the app bundle cannot, which is why the module mirrors them.
 */

const ROOT = new URL("../../../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");

/**
 * Every `.ts`/`.tsx` source file under the given repo-root-relative dirs
 * (Node can walk the repo; the app bundle cannot, which is why the drift
 * guards read from disk). Deterministic: sorted paths, `node_modules` and
 * build output excluded.
 */
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

const ADR_0043 = read("adr/0043-netcup-vps-hosting-gdpr-posture.md");
const ROPA = read("docs/GDPR-ARTICLE-30-RECORD.md");
const MODELS_JSON = JSON.parse(read("packages/infra/src/providers/models.json")) as {
  vendors: Record<string, { freeTier: boolean; personalDataAllowed: boolean }>;
};
const SESSION_ADAPTER = read("packages/infra/src/rag-store-neon-session.ts");
const AUTH_ROUTE = read("apps/api/src/routes/auth.ts");

type RegisterRow = { vendor: string; cells: string[] };

/** ADR-0043 decision 3's register table, parsed from the markdown. */
function adrRegisterRows(): RegisterRow[] {
  const rows: RegisterRow[] = [];
  for (const raw of ADR_0043.split("\n")) {
    // The ADR indents its tables inside the decision list, so the row's own
    // line starts with whitespace before the pipe.
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    // The register is the ADR's only five-column table; this drops the header
    // and the `|---|` separator without depending on their exact wording.
    if (cells.length !== 5) continue;
    const vendor = cells[0]!.replace(/\*\*/g, "").trim();
    if (vendor.length === 0 || vendor === "Processor" || /^[-\s]+$/.test(vendor)) continue;
    rows.push({ vendor, cells });
  }
  return rows;
}

const REGISTER_ROWS = adrRegisterRows();

/** The ADR row whose vendor name starts with the notice row's name. */
function adrRowFor(vendor: string): RegisterRow {
  const row = REGISTER_ROWS.find((candidate) => candidate.vendor.startsWith(vendor));
  if (!row) throw new Error(`no ADR-0043 register row for ${vendor}`);
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

/** The vendor catalog ids behind the notice rows that name an LLM vendor. */
const CATALOG_IDS: Record<string, string> = {
  gemini: "gemini",
  deepseek: "deepseek",
  alibaba: "qwen",
  moonshot: "kimi",
  typesafe: "typesafe",
};

const STATUS_KEY = {
  current: "aboutPrivacyStatusCurrent",
  transition: "aboutPrivacyStatusTransition",
  planned: "aboutPrivacyStatusPlanned",
  "no-serving-role": "aboutPrivacyStatusNoServingRole",
} as const;

describe("privacy notice: the register mirrors ADR-0043", () => {
  it("parsed the ADR register (so the drift guards below are not vacuous)", () => {
    expect(REGISTER_ROWS.length).toBeGreaterThanOrEqual(8);
    expect(REGISTER_ROWS[0]!.vendor).toContain("netcup");
  });

  it("carries every register row, and no row the ADR does not", () => {
    for (const processor of SUB_PROCESSORS) {
      expect(
        REGISTER_ROWS.some((row) => row.vendor.startsWith(processor.name)),
        `${processor.name} is not in ADR-0043's register`,
      ).toBe(true);
    }
    for (const row of REGISTER_ROWS) {
      expect(
        SUB_PROCESSORS.some((processor) => row.vendor.startsWith(processor.name)),
        `ADR row "${row.vendor}" has no notice row`,
      ).toBe(true);
    }
    expect(SUB_PROCESSORS.length).toBe(REGISTER_ROWS.length);
  });

  it("takes each row's tier from the ADR's Tier column, not from prose", () => {
    const tierOf = (row: RegisterRow): ProcessorTier => {
      const cell = row.cells[3]!.toLowerCase();
      if (cell.includes("paid")) return "paid";
      if (cell.includes("free")) return "free";
      throw new Error(`unrecognized tier cell for ${row.vendor}: ${row.cells[3]}`);
    };
    for (const processor of SUB_PROCESSORS) {
      expect(tierOf(adrRowFor(processor.name)), `${processor.name} tier`).toBe(processor.tier);
    }
  });

  it("marks a vendor not-for-personal-data exactly when the ADR's verdict says so", () => {
    for (const processor of SUB_PROCESSORS) {
      const row = adrRowFor(processor.name);
      const expected = /not permitted/i.test(row.cells[4]!) ? "not-for-personal-data" : "permitted";
      expect(processor.verdict, `${processor.name} verdict`).toBe(expected);
    }
  });

  it("keeps the register's rule: a free tier never carries personal data", () => {
    for (const processor of SUB_PROCESSORS) {
      if (processor.tier !== "free") continue;
      // Permitted on a free tier only as the transitional rows whose
      // personal-data footprint the migration removes (ADR-0043 decision 3).
      expect(processor.verdict === "permitted", `${processor.name} is free-tier`).toBe(
        processor.status === "transition",
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

  it("states the transition honestly: the destination is planned, not live", () => {
    // #181 has not happened. netcup is the destination and the two vendors
    // serving today are transition rows — the notice is never false today, and
    // cutover is a status edit rather than a copy rewrite.
    expect(byId("netcup").status).toBe("planned");
    expect(byId("cloudflare").status).toBe("transition");
    expect(byId("neon").status).toBe("transition");
    expect(ADR_0043).toContain("Nothing here\nclaims the VPS is live");
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

describe("privacy notice: retention is the ADR's values, enforced by real code", () => {
  it("states the 30-day session TTL the adapter actually implements", () => {
    const ttl = /const SESSION_TTL_MS = (\d+) \* 24 \* 60 \* 60 \* 1000/.exec(SESSION_ADAPTER);
    expect(ttl, "the adapter's SESSION_TTL_MS is not in the expected shape").not.toBeNull();
    const days = Number(ttl![1]);
    expect(days).toBe(30);
    const session = retentionById("sessions");
    expect(session.window.en).toContain(`${days} days`);
    expect(session.window.id).toContain(`${days} hari`);
    // The ADR and the Art. 30 record fix the same value, so a change in either
    // fails here before the copy can drift.
    expect(ADR_0043).toContain("Anonymous sessions: 30 days");
    expect(ROPA).toContain("30 days of inactivity");
  });

  it("states the 14-day access-log and 30-day backup windows the ADR fixes", () => {
    expect(ADR_0043).toContain("Server access logs: 14 days");
    expect(ADR_0043).toContain("30-day rolling retention");
    const accessLogs = RETENTION.find((item) => item.id === "access-logs")!;
    expect(accessLogs.window.en).toContain("14 days");
    expect(accessLogs.window.id).toContain("14 hari");
    const backups = RETENTION.find((item) => item.id === "backups")!;
    expect(backups.window.en).toContain("30-day");
    expect(backups.window.id).toContain("30 hari");
  });

  it("states no retention window the ADR does not fix", () => {
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
    const planned = RETENTION.filter((item) => item.status === "planned");
    expect(planned.map((item) => item.planRef).sort()).toEqual(["#180", "#180", "#181"]);
  });

  it("says there is no separate age-based deletion of chat rows", () => {
    expect(ADR_0043).toContain("There is no separate age-based deletion");
    const session = retentionById("sessions");
    expect(session.window.en).toContain("no separate age-based deletion");
    expect(session.window.id).toContain("Tidak ada penghapusan berbasis usia terpisah");
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
    // ADR-0043 decision 4 + the route's own OpenAPI description: sessions,
    // chat sessions/messages, traces, feedback.
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
    // The "clearing local storage is not erasure" distinction is stated,
    // because the local-first posture invites exactly that misreading.
    expect(ERASURE.localNote.en).toContain("only drops the session id on your device");
    expect(ERASURE.localNote.id).toContain("hanya membuang id sesi");
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
    // The claim is pinned to the source of each key, not to prose: the keys
    // are the owning modules' own exported constants (`chat-store.ts`
    // `SESSION_KEY`/`TOKEN_KEY`, `theme.ts` `THEME_KEY`) re-exported through
    // `privacy-notice.ts` — a key rename fails the typecheck before the
    // notice can drift (thermo-review B1). This test pins the value ↔
    // constant identity so a literal edit inside an owning module fails here.
    const chatStore = read("apps/web/src/lib/chat-store.ts");
    const theme = read("apps/web/src/lib/theme.ts");
    const declared = [
      ...chatStore.matchAll(/export const (?:SESSION|TOKEN)_KEY = "([^"]+)"/g),
      ...theme.matchAll(/export const THEME_KEY = "([^"]+)"/g),
    ].map((match) => match[1]!);
    expect(declared.sort()).toEqual([...STORAGE.keys].sort());
  });

  it("claims no cookies only because the code sets none", () => {
    expect(STORAGE.setsCookies).toBe(false);
    // The whole web app and the whole API are scanned, not three files
    // (thermo-review B2): a cookie added in any other component, route, or
    // helper makes the /about notice stale — this assertion is the tripwire,
    // and it fails the suite the moment the notice line stops being true.
    const sources = walkSources(["apps/web/src", "apps/api/src"]);
    // The notice module's doc comment names `document.cookie` to explain the
    // claim, and this test asserts about it — neither is a cookie use.
    const prose = new Set([
      "apps/web/src/lib/privacy-notice-storage.ts",
      "apps/web/src/lib/privacy-notice.test.ts",
    ]);
    expect(sources.length).toBeGreaterThan(100); // the scan is real, not vacuous
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
    // Erasable by the visitor, from the browser — the local half of erasure.
    expect(STORAGE.body.en.toLowerCase()).toContain("erase them yourself");
    expect(STORAGE.body.id.toLowerCase()).toContain("menghapusnya sendiri");
    expect(STORAGE.body.en).not.toBe(STORAGE.body.id);
  });

  it("names no processor, vendor, or retention window", () => {
    // UI-posture copy, not register data: it therefore carries no ADR-0043 row.
    // A named vendor or a day count here would make it register data and it
    // would need one.
    for (const copy of [STORAGE.body.en, STORAGE.body.id]) {
      expect(copy, "storage copy names a day count").not.toMatch(/\b\d+[- ](day|hari)\b/i);
      for (const vendor of SUB_PROCESSORS) {
        expect(copy, `storage copy names ${vendor.name}`).not.toContain(vendor.name);
      }
    }
  });
});

import fc from "fast-check";
import { test } from "@fast-check/vitest";
import { describe, expect } from "vite-plus/test";
import type { ModelConfigEntry, ModelConfigRecord } from "../rag-store-model-config-seam";
import { modelConfigDrift, modelConfigDriftEmpty, modelConfigKey } from "./model-config-mirror";

/**
 * The drift check's laws on generated row sets (ADR-0022 decision 3).
 *
 * The check is the only thing standing between a config edit and an admin page that
 * still says the retired model's price is current. Its laws are: a mirror derived from
 * the entries is never drift, the finding does not depend on row order, and each kind
 * of disagreement — a missing row, an extra row, a changed payload — names exactly the
 * row that disagrees.
 */

const entryArb: fc.Arbitrary<ModelConfigEntry> = fc.record({
  role: fc.constantFrom("generator", "reviewer", "embedder"),
  provider: fc.constantFrom("alpha", "beta", "gamma"),
  modelId: fc.constantFrom("chat", "embed", "decide"),
  config: fc.record({
    priceMicroUsdPerMTok: fc.record({
      in: fc.nat({ max: 10_000_000 }),
      out: fc.nat({ max: 10_000_000 }),
    }),
    capabilities: fc.constant(["generate"]),
  }),
});

const entriesArb = fc.uniqueArray(entryArb, {
  selector: (entry) => modelConfigKey(entry),
  maxLength: 12,
});

function recordsOf(entries: readonly ModelConfigEntry[]): ModelConfigRecord[] {
  return entries.map((entry) => ({ ...entry, active: true, updatedAt: 0 }));
}

describe("the model-config drift check — laws on generated rows", () => {
  test.prop([entriesArb])(
    "a mirror derived from the entries is never drift, in either row order",
    (entries) => {
      expect(modelConfigDriftEmpty(modelConfigDrift(entries, recordsOf(entries)))).toBe(true);
      expect(modelConfigDriftEmpty(modelConfigDrift(entries, recordsOf(entries).reverse()))).toBe(
        true,
      );
    },
  );

  test.prop([entriesArb, fc.nat()])(
    "dropping a row names exactly that key as missing",
    (entries, raw) => {
      if (entries.length === 0) return;
      const index = raw % entries.length;
      const dropped = entries[index]!;
      const rows = recordsOf(entries).filter((_, at) => at !== index);
      const drift = modelConfigDrift(entries, rows);
      expect(drift.missing).toEqual([modelConfigKey(dropped)]);
      expect(drift.unexpected).toEqual([]);
      expect(drift.changed).toEqual([]);
    },
  );

  test.prop([entriesArb, fc.nat()])(
    "changing any row's price names exactly that key as changed",
    (entries, raw) => {
      if (entries.length === 0) return;
      const index = raw % entries.length;
      const target = entries[index]!;
      const rows = recordsOf(entries).map((row, at) => {
        if (at !== index) return row;
        const price = (row.config.priceMicroUsdPerMTok as { in: number; out: number }) ?? {
          in: 0,
          out: 0,
        };
        return {
          ...row,
          config: { ...row.config, priceMicroUsdPerMTok: { in: price.in + 1, out: price.out } },
        };
      });
      const drift = modelConfigDrift(entries, rows);
      expect(drift.changed).toEqual([modelConfigKey(target)]);
      expect(drift.missing).toEqual([]);
      expect(drift.unexpected).toEqual([]);
    },
  );

  test.prop([entriesArb])(
    "a row the config does not name is named unexpected, and never changes anything else",
    (entries) => {
      const retired: ModelConfigRecord = {
        role: "generator",
        provider: "retired",
        modelId: "retired-model",
        config: { priceMicroUsdPerMTok: { in: 1, out: 1 } },
        active: true,
        updatedAt: 0,
      };
      const drift = modelConfigDrift(entries, [...recordsOf(entries), retired]);
      expect(drift.unexpected).toEqual([modelConfigKey(retired)]);
      expect(drift.missing).toEqual([]);
      expect(drift.changed).toEqual([]);
      expect(drift.inactive).toEqual([]);
    },
  );

  test.prop([entriesArb])(
    "an empty mirror is drift exactly when the config has entries",
    (entries) => {
      const drift = modelConfigDrift(entries, []);
      expect(modelConfigDriftEmpty(drift)).toBe(entries.length === 0);
      expect(drift.missing).toEqual(entries.map(modelConfigKey).sort());
    },
  );
});

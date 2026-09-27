import { describe, expect, it } from "vitest";
import { withTextLayers } from "./chunk-text-layers";

/**
 * The one owner of the ADR-0006 text-layer metadata rule (B1 of #243's
 * review). The fused path and the surah-scope expansion both call this, so
 * the assertions here are the rule for both paths: both layers attach, an
 * absent translation is omitted (never rendered as an empty labeled layer),
 * and the store row's own metadata is preserved but cannot overwrite the
 * layers.
 */
describe("withTextLayers", () => {
  it("attaches both text layers over the row metadata", () => {
    expect(
      withTextLayers({ surah: 1, citation: "QS. 1:1" }, "بسم الله", "Dengan nama Allah"),
    ).toEqual({
      surah: 1,
      citation: "QS. 1:1",
      textAr: "بسم الله",
      textId: "Dengan nama Allah",
    });
  });

  it("omits the translation when the row has none — null or empty string", () => {
    expect(withTextLayers({}, "النص", null)).toEqual({ textAr: "النص" });
    expect(withTextLayers({}, "النص", "")).toEqual({ textAr: "النص" });
  });

  it("keeps the layer keys authoritative over same-named row metadata", () => {
    // A row whose metadata already carried a stale `textAr`/`textId` (an
    // ingest-time snapshot) must not shadow the current columns — the
    // assembler reads the columns' values or nothing.
    expect(withTextLayers({ textAr: "stale", textId: "stale" }, "current", "terjemahan")).toEqual({
      textAr: "current",
      textId: "terjemahan",
    });
  });
});

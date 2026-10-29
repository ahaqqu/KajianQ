import { describe, expect, it } from "vite-plus/test";
import {
  createCallBudget,
  ModelCallCeilingError,
  resolveCallCeiling,
  S1_MODEL_CALL_CEILING,
} from "./sanadset-budget";

/**
 * Test intent, named before the assertions:
 * - trap: the call ceiling is the only mechanical brake on spend, so it is asserted to be
 *   a hard constant that a flag cannot raise — a clamp would hide the mistake, an error
 *   makes it visible;
 * - trap: `take()` must throw *before* the call it would authorize, so a run stops at the
 *   ceiling rather than after exceeding it.
 */

describe("the hard ceiling", () => {
  it("is the pre-registered value", () => {
    expect(S1_MODEL_CALL_CEILING).toBe(6000);
  });

  it("is what a run gets when no flag asks for more", () => {
    expect(resolveCallCeiling(undefined)).toBe(S1_MODEL_CALL_CEILING);
  });

  it("cannot be raised by a flag", () => {
    expect(() => resolveCallCeiling(S1_MODEL_CALL_CEILING + 1)).toThrow(
      /exceeds the hard ceiling/u,
    );
  });

  it("accepts a lower ceiling", () => {
    expect(resolveCallCeiling(10)).toBe(10);
  });

  it("rejects a ceiling that is not a positive integer", () => {
    expect(() => resolveCallCeiling(0)).toThrow(/positive integer/u);
    expect(() => resolveCallCeiling(-5)).toThrow(/positive integer/u);
    expect(() => resolveCallCeiling(1.5)).toThrow(/positive integer/u);
  });

  it("refuses to build a budget with a nonsense ceiling", () => {
    expect(() => createCallBudget(0)).toThrow(/positive integer/u);
  });
});

describe("the call budget", () => {
  it("counts a reservation and reports what remains", () => {
    const budget = createCallBudget(3);
    budget.take();
    expect(budget.calls).toBe(1);
    expect(budget.remaining()).toBe(2);
  });

  it("throws instead of over-spending, carrying the counts", () => {
    const budget = createCallBudget(2);
    budget.take();
    budget.take();
    expect(budget.remaining()).toBe(0);
    try {
      budget.take();
      throw new Error("expected the budget to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelCallCeilingError);
      expect((error as ModelCallCeilingError).calls).toBe(2);
      expect((error as ModelCallCeilingError).ceiling).toBe(2);
    }
    expect(budget.calls).toBe(2);
  });
});

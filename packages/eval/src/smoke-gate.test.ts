import { describe, expect, it } from "vitest";
import { decideSmokeGate } from "./smoke-gate";

/**
 * The smoke gate's exit policy. These tests pin the contract the staging
 * gate relies on: a clean run passes outright, a single bad question (failed
 * or skipped — a skip is a transport transient) passes only as an explicit
 * `tolerated` verdict the caller must surface, anything beyond the tolerance
 * fails, and `maxBad = 0` still reproduces the original zero-tolerance gate.
 */
describe("decideSmokeGate", () => {
  it("passes a clean run outright", () => {
    expect(decideSmokeGate(0, 0, 1)).toEqual({ pass: true, tolerated: false });
  });

  it("passes one failed question at the default tolerance, marked tolerated", () => {
    expect(decideSmokeGate(1, 0, 1)).toEqual({ pass: true, tolerated: true });
  });

  it("counts a skipped question as bad", () => {
    expect(decideSmokeGate(0, 1, 1)).toEqual({ pass: true, tolerated: true });
    expect(decideSmokeGate(0, 2, 1)).toEqual({ pass: false, tolerated: false });
  });

  it("fails when failed plus skipped exceed the tolerance", () => {
    expect(decideSmokeGate(1, 1, 1)).toEqual({ pass: false, tolerated: false });
    expect(decideSmokeGate(2, 0, 1)).toEqual({ pass: false, tolerated: false });
  });

  it("reproduces the zero-tolerance gate at max 0", () => {
    expect(decideSmokeGate(0, 0, 0)).toEqual({ pass: true, tolerated: false });
    expect(decideSmokeGate(1, 0, 0)).toEqual({ pass: false, tolerated: false });
    expect(decideSmokeGate(0, 1, 0)).toEqual({ pass: false, tolerated: false });
  });

  it("passes every question within a wide tolerance", () => {
    expect(decideSmokeGate(4, 1, 5)).toEqual({ pass: true, tolerated: true });
  });
});

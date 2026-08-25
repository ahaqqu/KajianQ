import { describe, expect, it } from "vitest";
import { raiseClockFloor, stampNow } from "./clock";

describe("raiseClockFloor", () => {
  it("takes the max of current floor, server clock, and local clock", () => {
    expect(raiseClockFloor(100, 200, 150)).toBe(200);
    expect(raiseClockFloor(300, 200, 150)).toBe(300);
    expect(raiseClockFloor(100, 200, 400)).toBe(400);
  });

  it("treats a missing floor as 0", () => {
    expect(raiseClockFloor(undefined, 200, 150)).toBe(200);
  });

  it("never lowers the floor", () => {
    expect(raiseClockFloor(500, 100, 100)).toBe(500);
  });
});

describe("stampNow", () => {
  it("stamps local now when no floor is stored", () => {
    expect(stampNow(undefined, 123)).toBe(123);
  });

  it("never stamps below the floor (slow local clock)", () => {
    expect(stampNow(500, 100)).toBe(500);
  });

  it("stamps local now when ahead of the floor", () => {
    expect(stampNow(500, 900)).toBe(900);
  });
});

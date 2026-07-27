import { describe, expect, it } from "vitest";
import { getGreeting, getSchemaVersion } from "./store";

describe("store helpers", () => {
  it("greeting and schema", () => {
    expect(getGreeting()).toBe("Hello World");
    expect(getSchemaVersion()).toBe(2);
  });
});

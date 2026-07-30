import { beforeEach, describe, expect, it, vi } from "vitest";
import { initSentry } from "./sentry";

const { init } = vi.hoisted(() => ({ init: vi.fn() }));

vi.mock("@sentry/react", () => ({ init }));

describe("initSentry", () => {
  beforeEach(() => {
    init.mockClear();
  });

  it("does not initialize the SDK when the DSN is absent", () => {
    initSentry(undefined);
    expect(init).not.toHaveBeenCalled();
  });

  it("initializes errors-only when the DSN is set", () => {
    initSentry("https://key@o0.ingest.sentry.io/1");
    expect(init).toHaveBeenCalledWith({
      dsn: "https://key@o0.ingest.sentry.io/1",
      tracesSampleRate: 0,
    });
  });
});

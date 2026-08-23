import { describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger";

describe("createLogger", () => {
  it("emits structured JSON", () => {
    const sink = vi.fn();
    const log = createLogger({ service: "api" }, sink);
    log.info("hello", { ok: true });
    expect(sink).toHaveBeenCalledOnce();
    const parsed = JSON.parse(sink.mock.calls[0]![0] as string) as {
      level: string;
      msg: string;
      service: string;
      ok: boolean;
    };
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello");
    expect(parsed.service).toBe("api");
    expect(parsed.ok).toBe(true);
  });

  it("child merges fields", () => {
    const sink = vi.fn();
    const log = createLogger({ a: 1 }, sink).child({ b: 2 });
    log.warn("w");
    const parsed = JSON.parse(sink.mock.calls[0]![0] as string) as {
      a: number;
      b: number;
    };
    expect(parsed.a).toBe(1);
    expect(parsed.b).toBe(2);
  });

  it("supports debug and error levels", () => {
    const sink = vi.fn();
    const log = createLogger({}, sink);
    log.debug("d");
    log.error("e");
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it("default sink writes without throwing", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger({ service: "t" });
    log.info("via-default");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});


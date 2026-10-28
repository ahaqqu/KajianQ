import { describe, expect, it, vi } from "vite-plus/test";
import { readLoginBody } from "./admin-login";

/**
 * The login body's ORDER, which is the mechanism the media-type gate claims: a declared
 * type that is not JSON must never reach the read.
 *
 * `readLoginBody` takes the declared type and the read as its two arguments, so an
 * unread body is an observable fact — a read function that fails when invoked, asserted
 * not to have been invoked. Presence-only coverage of the gate would stay green if a
 * refactor parsed first and checked the header afterwards, which is exactly the shape
 * that hands a browser form's body to the JSON parser.
 */
const readThatMustNotRun = () => Promise.reject(new Error("the body must not be read"));

describe("readLoginBody: the media type is checked before the body is read", () => {
  it("never reads the body of a declaration it will not parse", async () => {
    for (const contentType of [
      undefined,
      "",
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=----kajianq",
      "application/json-patch+json",
    ]) {
      const read = vi.fn(readThatMustNotRun);
      expect(await readLoginBody(contentType, read), String(contentType)).toBeNull();
      expect(read, String(contentType)).not.toHaveBeenCalled();
    }
  });

  it("reads and validates a JSON body, handing back the contract's own value", async () => {
    const read = vi.fn(async () => ({ password: "correct horse battery staple" }));
    expect(await readLoginBody("application/json; charset=utf-8", read)).toEqual({
      password: "correct horse battery staple",
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("treats an unreadable body and a contract miss as the same null", async () => {
    expect(await readLoginBody("application/json", readThatMustNotRun)).toBeNull();
    for (const body of [
      null,
      {},
      { password: "" },
      { password: "x".repeat(513) },
      { password: 42 },
    ]) {
      expect(
        await readLoginBody("application/json", async () => body),
        JSON.stringify(body),
      ).toBeNull();
    }
  });
});

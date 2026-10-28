import { describe, expect, it } from "vite-plus/test";
import { fc, test as fcTest } from "@fast-check/vitest";
import { constantTimeEqual, hmacSha256, sha256, toHex } from "./constant-time";

/**
 * The secret-comparison primitive's contract. A timing side channel cannot be
 * asserted from a unit test (a wall-clock assertion is flake, not evidence), so the
 * machine-checkable half is the *result* contract plus the structural fact the
 * implementation makes true by construction: both compared buffers are digests of a
 * fixed length, so the loop bound is a constant of the construction and every byte
 * is folded into one accumulator.
 *
 * The traps below are the real bug shapes: an early return on the first differing
 * byte (a timing oracle), and a length check that a full-prefix match can pass.
 */
describe("constantTimeEqual", () => {
  const bytes = (values: number[]): Uint8Array<ArrayBuffer> => new Uint8Array(values);

  it("is true only for byte-identical buffers", () => {
    expect(constantTimeEqual(bytes([1, 2, 3]), bytes([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(bytes([]), bytes([]))).toBe(true);
    expect(constantTimeEqual(bytes([1, 2, 3]), bytes([1, 2, 4]))).toBe(false);
    // Differs at the FIRST byte: an early-returning comparison still answers false,
    // which is why the result alone cannot tell the two implementations apart — the
    // fold-in of the difference is what this asserts behaviourally.
    expect(constantTimeEqual(bytes([9, 2, 3]), bytes([1, 2, 3]))).toBe(false);
    expect(constantTimeEqual(bytes([1, 2, 3]), bytes([1, 2, 3, 0]))).toBe(false);
  });

  it("refuses a full-prefix match of a different length", () => {
    // The classic length bug: a comparison that walks the shorter buffer and stops
    // would call these equal.
    expect(constantTimeEqual(bytes([1, 2, 3]), bytes([1, 2]))).toBe(false);
    expect(constantTimeEqual(bytes([1, 2]), bytes([1, 2, 3]))).toBe(false);
    expect(constantTimeEqual(bytes([]), bytes([0]))).toBe(false);
  });

  fcTest.prop([
    fc.uint8Array({ minLength: 0, maxLength: 64 }),
    fc.uint8Array({ minLength: 0, maxLength: 64 }),
  ])(
    "agrees with a straightforward comparison for arbitrary buffers",
    (a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>) => {
      const expected = a.length === b.length && a.every((byte, index) => byte === b[index]);
      expect(constantTimeEqual(a, b)).toBe(expected);
    },
  );
});

describe("sha256 / hmacSha256", () => {
  it("digests to 32 bytes and is stable", async () => {
    const first = await sha256("kajianq");
    const second = await sha256(new TextEncoder().encode("kajianq"));
    expect(first.length).toBe(32);
    expect(toHex(first)).toBe(toHex(second));
    // A different input is a different digest: the fingerprint is not a constant.
    expect(toHex(first)).not.toBe(toHex(await sha256("kajianq ")));
  });

  it("keys the HMAC: same message, different key, different signature", async () => {
    const keyA = await sha256("a");
    const keyB = await sha256("b");
    const signatureA = await hmacSha256(keyA, "message");
    expect(toHex(signatureA)).not.toBe(toHex(await hmacSha256(keyB, "message")));
    expect(toHex(signatureA)).not.toBe(toHex(await hmacSha256(keyA, "message!")));
    expect(signatureA.length).toBe(32);
  });
});

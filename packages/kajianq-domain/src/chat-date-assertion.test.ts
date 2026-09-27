import { describe, expect, it } from "vitest";
import { assertsCalendarDate } from "./chat-date-assertion";

/**
 * The date-assertion detector behind the `gs-v0-019` grounded-decline
 * acceptance (#244). This is the domain-owned half of "do not assert a date
 * for the Hour": the engine injects it and fails closed without it, so its
 * behavior is pinned here — in the domain pack, where the vocabulary lives,
 * rather than in the engine boundary test's fake.
 *
 * The direction that matters is strictness: every date shape below must be
 * detected, so no dated answer can be accepted as a grounded decline. The
 * second describe pins the false-positive guard that keeps a citation's own
 * digits from reading as a year.
 */

describe("assertsCalendarDate: detects Gregorian and Hijri date assertions", () => {
  it("detects an explicitly named year in either language", () => {
    for (const text of [
      "Kiamat akan terjadi pada tahun 2077 M.",
      "Kiamat akan terjadi pada tahun 2025.",
      "It will happen in the year 2077.",
      "TAHUN 2077.",
      "tahun 999",
    ]) {
      expect(assertsCalendarDate(text), `${text} must be detected`).toBe(true);
    }
  });

  it("detects a bare Gregorian-range year", () => {
    for (const text of ["Kiamat terjadi pada 2077.", "Sekitar 2025 Masehi.", "Year of 1999."]) {
      expect(assertsCalendarDate(text), `${text} must be detected`).toBe(true);
    }
  });

  it("detects a Hijri year, with or without its marker", () => {
    for (const text of [
      "Kiamat akan terjadi pada tahun 1500 H.",
      "Pada 1447 H.",
      "Tahun 1447 Hijriah.",
      "Kiamat pada 1447.",
    ]) {
      expect(assertsCalendarDate(text), `${text} must be detected`).toBe(true);
    }
  });

  it("detects a day + month date with no year token", () => {
    for (const text of [
      "Kiamat akan terjadi pada 10 Muharram.",
      "Kiamat akan terjadi pada 12 Desember.",
      "It will happen on 12 December.",
      "Pada 1 Syawal.",
    ]) {
      expect(assertsCalendarDate(text), `${text} must be detected`).toBe(true);
    }
  });

  it("does not fire on a plain grounded decline (the positive control)", () => {
    for (const text of [
      "Konteks yang tersedia tidak menyebutkan tahun pasti terjadinya Kiamat.",
      "Pengetahuan tentang waktu Kiamat hanya ada di sisi Allah.",
      "Tidak seorang pun mengetahuinya, dan tidak ada yang mengetahui kapan.",
    ]) {
      expect(assertsCalendarDate(text), `${text} must NOT be detected`).toBe(false);
    }
  });
});

describe("assertsCalendarDate: a citation's own digits are not a date", () => {
  it("ignores verse/address numbers", () => {
    for (const text of [
      "Lihat QS. 2:255.",
      "Lihat QS. 20:255.",
      "Dalilnya QS. 31:34 dan QS. 2:255.",
      "Q.S. 1:2",
    ]) {
      expect(assertsCalendarDate(text), `${text} must NOT be detected`).toBe(false);
    }
  });

  it("ignores numbered-citation digits, including ones in the year range", () => {
    // The regression this guards: without masking, a grounded decline citing
    // a source numbered 1950/1420 would be rejected by the bare-year pattern
    // and the fix would trade one false-fail for another.
    for (const text of [
      "Menurut HR. Bukhari no. 1950, hari Kiamat tidak diketahui waktunya.",
      "HR. Malik no. 1420 tentang hari Kiamat.",
      "no. 2077",
    ]) {
      expect(assertsCalendarDate(text), `${text} must NOT be detected`).toBe(false);
    }
  });
});

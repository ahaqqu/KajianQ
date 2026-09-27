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

  // Thermos A1: the compact renderings. The trailing `\b` this file used to
  // carry could not match a year run followed by a calendar suffix (`2077M`),
  // and `tahun\s+` could not match the no-space form (`tahun2077`) — five
  // dated answers passed the gate for real. Each shape is pinned here, where
  // the vocabulary lives, so the miss cannot come back.
  it("detects a compact suffixed year (no space before the calendar marker)", () => {
    for (const text of [
      "Kiamat akan terjadi pada tahun 2077M.",
      "Kiamat akan terjadi pada tahun 1500H.",
      "Kiamat akan terjadi pada 1447H.",
      "Sebagian riwayat menyebut 2077M.",
      "Kiamat pada 2077M",
      "Pada 1500H.",
    ]) {
      expect(assertsCalendarDate(text), `${text} must be detected`).toBe(true);
    }
  });

  it("detects an explicit year with no space after the marker", () => {
    for (const text of [
      "Kiamat akan terjadi pada tahun2077.",
      "tahun2077",
      "TAHUN2077",
      "It will happen in year2077.",
    ]) {
      expect(assertsCalendarDate(text), `${text} must be detected`).toBe(true);
    }
  });

  it("still refuses to read a longer digit run as a year", () => {
    // The lookahead that catches `2077M` must not turn a 5-digit figure into a
    // year: `12000` is not a date assertion.
    for (const text of ["Korpus memuat 12000 riwayat.", "Nomor urut 12077."]) {
      expect(assertsCalendarDate(text), `${text} must NOT be detected`).toBe(false);
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

  // Thermos A2: the Hijri vocabulary gaps (the `Rabiul`-prefixed pattern's
  // `\b` could never match `Rabiulawal`, and months like `Jumadilawal` and
  // `Dzulqadah` were absent) and the word-order hole (a recognised month name
  // before the day still escaped).
  it("detects the Hijri month spellings a corpus actually contains", () => {
    for (const text of [
      "Kiamat akan terjadi pada 12 Rabiulawal.",
      "Kiamat akan terjadi pada 12 Rabiul Awal.",
      "Kiamat akan terjadi pada 12 Rabi'ul Awal.",
      "Kiamat akan terjadi pada 1 Muharam.",
      "Kiamat akan terjadi pada 1 Muharram.",
      "Kiamat akan terjadi pada 15 Jumadilawal.",
      "Kiamat akan terjadi pada 15 Jumadil Awal.",
      "Kiamat akan terjadi pada 4 Rabiulakhir.",
      "Kiamat akan terjadi pada 10 Dzulqadah.",
      "Kiamat akan terjadi pada 10 Zulkaidah.",
      "Kiamat akan terjadi pada 10 Dzulqa'dah.",
      "Kiamat akan terjadi pada 10 Dzulhijjah.",
      "Kiamat akan terjadi pada 10 Zulhijah.",
      "Kiamat akan terjadi pada 15 Sya'ban.",
      "Kiamat akan terjadi pada 1 Ramadhan.",
      "Kiamat akan terjadi pada 1 Romadhon.",
      "Kiamat akan terjadi pada 1 Safar.",
      "Kiamat akan terjadi pada 27 Rajab.",
    ]) {
      expect(assertsCalendarDate(text), `${text} must be detected`).toBe(true);
    }
  });

  it("detects a month name written BEFORE the day, in every vocabulary", () => {
    for (const text of [
      "It will happen on December 12.",
      "It will happen on December 12, 2077.",
      "Kiamat akan terjadi pada Desember 12.",
      "Kiamat akan terjadi pada Rabiulawal 12.",
      "Kiamat akan terjadi pada Rabiul Awal 12.",
      "Kiamat akan terjadi pada Muharram 10.",
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

  // Thermos A3: the kitab page references the product's own kitab grammar
  // renders (`chat-citation-validator.ts`) are reference numbers, not years.
  it("ignores kitab page/volume references in the year range", () => {
    for (const text of [
      "Lihat Al-Umm, Imam Syafi'i, Jilid 8, Hal. 1447.",
      "Jilid 8, Hal. 1447",
      "Hal. 2050",
      "Hal. 1950 tentang hari Kiamat.",
    ]) {
      expect(assertsCalendarDate(text), `${text} must NOT be detected`).toBe(false);
    }
  });

  // Thermos A3, recorded trade: the compact hadith form (`HR. <collection>
  // <n>`, no `no.`) is NOT masked — it is not one of the product's citation
  // grammars, and a mask loose enough to catch it could swallow a real date
  // ("HR. Ahmad menyebutkan 1447"). Pinned so the trade stays a decision: if
  // this test fails after a mask change, revisit the module comment's A3
  // paragraph and the PR's residual statement together.
  it("still reads a compact hadith number in the year range as a date (recorded trade)", () => {
    for (const text of ["HR. Bukhari 1950", "HR. Muslim 1447"]) {
      expect(assertsCalendarDate(text), `${text} is the recorded over-strict case`).toBe(true);
    }
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { isWithinBusinessHours } from "../js/hours-utils.js";

// 2024-01-01 = Senin. 03:00 UTC = 10:00 WIB (UTC+7) hari yang sama.
const MON_10AM_WIB = new Date("2024-01-01T03:00:00Z");
// 2024-01-01 16:30 UTC = 2024-01-01 23:30 WIB (masih Senin).
const MON_1130PM_WIB = new Date("2024-01-01T16:30:00Z");
// 2024-01-01 23:30 UTC = 2024-01-02 06:30 WIB (nyebrang ke Selasa).
const TUE_630AM_WIB = new Date("2024-01-01T23:30:00Z");

const businessHours = {
  enabled: true,
  days: ["mon", "tue", "wed", "thu", "fri"],
  start: "09:00",
  end: "17:00"
};

test("isWithinBusinessHours: fitur nonaktif selalu online apa pun jamnya", () => {
  assert.equal(isWithinBusinessHours({ enabled: false }, MON_1130PM_WIB), true);
  assert.equal(isWithinBusinessHours(null, MON_1130PM_WIB), true);
  assert.equal(isWithinBusinessHours(undefined, MON_1130PM_WIB), true);
});

test("isWithinBusinessHours: dalam jam & hari kerja -> online", () => {
  assert.equal(isWithinBusinessHours(businessHours, MON_10AM_WIB), true);
});

test("isWithinBusinessHours: hari yang sama tapi di luar jam -> offline", () => {
  assert.equal(isWithinBusinessHours(businessHours, MON_1130PM_WIB), false);
});

test("isWithinBusinessHours: hari tidak ada di daftar hari buka -> offline", () => {
  // TUE_630AM_WIB itu Selasa jam 06:30, sebelum jam buka -- tapi tesnya
  // spesifik soal HARI: Selasa tidak dicentang admin sama sekali.
  const weekdaysOnlyExceptTuesday = { ...businessHours, days: ["mon", "wed", "thu", "fri"] };
  assert.equal(isWithinBusinessHours(weekdaysOnlyExceptTuesday, TUE_630AM_WIB), false);
});

test("isWithinBusinessHours: konversi UTC->WIB benar-benar dipakai (nyebrang tanggal)", () => {
  // TUE_630AM_WIB secara UTC masih tanggal 1 Jan (Senin), tapi di WIB sudah
  // masuk 2 Jan (Selasa) jam 06:30 -- sebelum jam buka 09:00, jadi offline.
  assert.equal(isWithinBusinessHours(businessHours, TUE_630AM_WIB), false);
});

test("isWithinBusinessHours: batas jam buka inklusif, batas jam tutup eksklusif", () => {
  const exactStart = new Date("2024-01-01T02:00:00Z"); // 09:00 WIB persis
  const exactEnd = new Date("2024-01-01T10:00:00Z"); // 17:00 WIB persis
  assert.equal(isWithinBusinessHours(businessHours, exactStart), true);
  assert.equal(isWithinBusinessHours(businessHours, exactEnd), false);
});

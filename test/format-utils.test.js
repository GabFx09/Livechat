import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDurationShort } from "../js/format-utils.js";

test("formatDurationShort: di bawah 1 menit -> detik", () => {
  assert.equal(formatDurationShort(45000), "45 dtk");
  assert.equal(formatDurationShort(0), "0 dtk");
});

test("formatDurationShort: di bawah 1 jam -> menit", () => {
  assert.equal(formatDurationShort(12 * 60 * 1000), "12 mnt");
});

test("formatDurationShort: 1 jam pas tanpa sisa menit", () => {
  assert.equal(formatDurationShort(60 * 60 * 1000), "1 jam");
});

test("formatDurationShort: jam + menit sisa", () => {
  assert.equal(formatDurationShort(2 * 60 * 60 * 1000 + 5 * 60 * 1000), "2 jam 5 mnt");
});

test("formatDurationShort: pembulatan detik ke menit pas di ambang 60", () => {
  assert.equal(formatDurationShort(59500), "1 mnt");
});

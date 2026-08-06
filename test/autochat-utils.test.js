import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAutochatOptions, formatAutochatOptionsForTextarea } from "../js/autochat-utils.js";

test("parseAutochatOptions: baris polos jadi tombol tanpa balasan", () => {
  const { options, optionReplies } = parseAutochatOptions("Info Produk\nLainnya");
  assert.deepEqual(options, ["Info Produk", "Lainnya"]);
  assert.deepEqual(optionReplies, {});
});

test("parseAutochatOptions: format Label :: Balasan kepisah dengan benar", () => {
  const { options, optionReplies } = parseAutochatOptions("Info Produk :: Boleh sebutkan produknya?");
  assert.deepEqual(options, ["Info Produk"]);
  assert.deepEqual(optionReplies, { "Info Produk": "Boleh sebutkan produknya?" });
});

test("parseAutochatOptions: cuma titik dua PERTAMA yang jadi pemisah", () => {
  const { optionReplies } = parseAutochatOptions("Jam Buka :: Kami buka 09:00 :: 17:00 WIB");
  assert.equal(optionReplies["Jam Buka"], "Kami buka 09:00 :: 17:00 WIB");
});

test("parseAutochatOptions: baris kosong/whitespace diabaikan", () => {
  const { options } = parseAutochatOptions("Info Produk\n\n   \nLainnya");
  assert.deepEqual(options, ["Info Produk", "Lainnya"]);
});

test("parseAutochatOptions: label kosong sebelum :: bikin baris itu diabaikan total", () => {
  const { options, optionReplies } = parseAutochatOptions(" :: Balasan tanpa label\nInfo Produk");
  assert.deepEqual(options, ["Info Produk"]);
  assert.deepEqual(optionReplies, {});
});

test("parseAutochatOptions: :: tanpa isi balasan tetap jadi tombol polos", () => {
  const { options, optionReplies } = parseAutochatOptions("Lainnya ::   ");
  assert.deepEqual(options, ["Lainnya"]);
  assert.deepEqual(optionReplies, {});
});

test("parseAutochatOptions: input kosong/undefined balik struktur kosong", () => {
  assert.deepEqual(parseAutochatOptions(""), { options: [], optionReplies: {} });
  assert.deepEqual(parseAutochatOptions(undefined), { options: [], optionReplies: {} });
});

test("formatAutochatOptionsForTextarea: kebalikan dari parseAutochatOptions (round-trip)", () => {
  const raw = "Info Produk :: Boleh sebutkan produknya?\nLainnya";
  const { options, optionReplies } = parseAutochatOptions(raw);
  assert.equal(formatAutochatOptionsForTextarea(options, optionReplies), raw);
});

test("formatAutochatOptionsForTextarea: input kosong balik string kosong", () => {
  assert.equal(formatAutochatOptionsForTextarea([], {}), "");
  assert.equal(formatAutochatOptionsForTextarea(undefined, undefined), "");
});

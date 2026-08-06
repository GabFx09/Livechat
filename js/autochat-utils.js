// Logika murni (parsing string) di balik textarea "Pilihan Bantuan &
// Balasan Otomatis" di Pengaturan > Auto-Chat, dipisah dari admin.js supaya
// bisa dites langsung tanpa perlu Firebase/DOM -- lihat
// test/autochat-utils.test.js.

// Tiap baris di textarea boleh format "Label" saja (tombol polos) atau
// "Label :: Balasan" (tombol yang begitu diklik dapat balasan otomatis).
// Dipisah pas titik dua ganda PERTAMA saja, biar balasan yang isinya "::"
// lagi di tengah kalimat tidak ikut kepotong.
export function parseAutochatOptions(raw) {
  const options = [];
  const optionReplies = {};
  (raw || "").split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const sepIndex = trimmed.indexOf("::");
    if (sepIndex === -1) {
      options.push(trimmed);
      return;
    }
    const label = trimmed.slice(0, sepIndex).trim();
    const reply = trimmed.slice(sepIndex + 2).trim();
    if (!label) return;
    options.push(label);
    if (reply) optionReplies[label] = reply;
  });
  return { options, optionReplies };
}

// Kebalikan dari parseAutochatOptions -- dipakai buat isi ulang textarea
// pas buka halaman Pengaturan > Auto-Chat dari data yang sudah tersimpan.
export function formatAutochatOptionsForTextarea(options, optionReplies) {
  return (options || [])
    .map((label) => {
      const reply = (optionReplies || {})[label];
      return reply ? `${label} :: ${reply}` : label;
    })
    .join("\n");
}

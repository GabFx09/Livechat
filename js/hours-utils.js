// Logika murni jam operasional, dipisah dari customer.js supaya bisa dites
// tanpa perlu DOM/Firebase -- lihat test/hours-utils.test.js. widget.js
// punya salinan mandiri dari logika yang sama (bukan modul ES, dibuat buat
// ditempel apa adanya di website pihak ketiga), jadi kalau logikanya
// berubah di sini, ingat sesuaikan juga di widget.js.
const WIB_DAY_CODES = { Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" };

// bh = { enabled, days, start, end } (lihat businessHours di customer.js).
// now dibuat bisa di-override (default: waktu sekarang) supaya gampang dites
// dengan tanggal/jam tertentu tanpa mocking Date global.
export function isWithinBusinessHours(bh, now = new Date()) {
  if (!bh || !bh.enabled) return true;
  const days = Array.isArray(bh.days) ? bh.days : [];

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;

  const today = WIB_DAY_CODES[get("weekday")];
  if (!days.includes(today)) return false;

  const nowMinutes = parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10);
  const [startH, startM] = (bh.start || "00:00").split(":").map(Number);
  const [endH, endM] = (bh.end || "23:59").split(":").map(Number);
  return nowMinutes >= startH * 60 + startM && nowMinutes < endH * 60 + endM;
}

// Format angka murni, dipisah dari admin.js supaya bisa dites tanpa perlu
// DOM/Firebase -- lihat test/format-utils.test.js.
export function formatDurationShort(ms) {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return totalSeconds + " dtk";
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return totalMinutes + " mnt";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours + " jam" + (minutes ? " " + minutes + " mnt" : "");
}

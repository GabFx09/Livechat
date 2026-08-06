// Konfigurasi dari Firebase Console
// (Project settings > General > Your apps > SDK setup and configuration).
// Lihat README.md untuk langkah lengkapnya.
export const firebaseConfig = {
  apiKey: "AIzaSyCmrrJNI0HofJlPaXwWJwMGZuUobhAXzbk",
  authDomain: "livechat-saya.firebaseapp.com",
  projectId: "livechat-saya",
  storageBucket: "livechat-saya.firebasestorage.app",
  messagingSenderId: "47824287496",
  appId: "1:47824287496:web:b39cc34886dfa1c140debd"
};

// Site key reCAPTCHA v3 buat Firebase App Check (proteksi anti-bot/spam,
// tetap gratis di Spark plan). Ambil dari Firebase Console > Build >
// App Check > Apps > daftarkan app ini dengan provider reCAPTCHA v3
// (Firebase yang bikinkan site key-nya, tinggal disalin ke sini). Lihat
// README.md untuk langkah lengkap + kenapa jangan langsung nyalain
// "Enforce" sebelum yakin token-nya jalan normal. Dibiarkan placeholder
// = App Check otomatis dilewati (app tetap jalan seperti biasa), bukan
// bikin error.
export const RECAPTCHA_V3_SITE_KEY = "PASTE_RECAPTCHA_V3_SITE_KEY_HERE";

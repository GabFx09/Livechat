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
// tetap gratis di Spark plan). Didaftarkan lewat Firebase Console >
// Security > App Check > Apps, situs reCAPTCHA-nya dibuat di
// google.com/recaptcha/admin (site key di sini, secret key ditempel di
// App Check, BUKAN di kode -- secret key tidak boleh publik). Lihat
// README.md untuk langkah lengkap + kenapa jangan langsung nyalain
// "Enforce" sebelum yakin token-nya jalan normal.
export const RECAPTCHA_V3_SITE_KEY = "6Lfa73ctAAAAAEktz1HR1a5GeYoYrI4m0VcWBNZ0";

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  initializeFirestore,
  doc,
  setDoc,
  getDoc,
  collection,
  query,
  orderBy,
  onSnapshot,
  addDoc,
  serverTimestamp,
  increment,
  arrayUnion
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import {
  initializeAppCheck,
  ReCaptchaV3Provider
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app-check.js";
import {
  getDatabase,
  ref as rtdbRef,
  set as rtdbSet,
  onDisconnect,
  serverTimestamp as rtdbServerTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js";
import { firebaseConfig, RECAPTCHA_V3_SITE_KEY } from "./firebase-config.js";
import { compressImageFile, showImageLightbox, showImageSendConfirm } from "./image-utils.js";
import { renderTextWithLinks } from "./text-utils.js";
import { isWithinBusinessHours } from "./hours-utils.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// autoDetectLongPolling: sebagian jaringan (firewall kantor, beberapa
// operator seluler, proxy) memblokir koneksi streaming (WebChannel) bawaan
// Firestore tanpa error yang jelas -- ini bikin SDK otomatis pindah ke
// long-polling biasa kalau streaming tidak jalan, tanpa perlu deteksi manual.
const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
// Presence (online/offline) lewat Realtime Database, bukan Firestore --
// lihat catatan lengkap di startPresence() di bawah. rtdb null kalau
// databaseURL belum di-setup di firebase-config.js, supaya tetap jalan
// (fallback ke heartbeat Firestore lama) walau RTDB belum di-provision.
const rtdb = firebaseConfig.databaseURL ? getDatabase(app) : null;

// Lewati App Check kalau site key belum di-setup admin (lihat
// firebase-config.js) -- app tetap jalan normal, cuma tanpa proteksi
// anti-bot tambahan itu.
if (RECAPTCHA_V3_SITE_KEY && !RECAPTCHA_V3_SITE_KEY.startsWith("PASTE_")) {
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(RECAPTCHA_V3_SITE_KEY),
    isTokenAutoRefreshEnabled: true
  });
} else {
  console.warn("Firebase App Check belum di-setup (RECAPTCHA_V3_SITE_KEY masih placeholder). Lihat README.md.");
}

// Terima workspace ID dari query string (?w=ID) ATAU dari URL bersih
// (/ID/, dilayani lewat trik 404.html karena GitHub Pages tidak mendukung
// URL dinamis native). Query string diprioritaskan kalau ada.
function extractWorkspaceIdFromPath() {
  const segments = window.location.pathname.split("/").filter(Boolean);
  const BASE_SEGMENTS = 0; // situs ini di-host di root domain custom, tanpa segmen dasar
  if (segments.length <= BASE_SEGMENTS) return null;
  const last = segments[segments.length - 1];
  if (last === "index.html" || last === "404.html") return null;
  return last;
}

// Bukan const -- bisa dikoreksi di resolveWorkspaceDataFast() kalau ternyata
// ID di URL ini cuma versi huruf-kecil dari ID asli (lihat catatan di sana).
let workspaceId =
  new URLSearchParams(window.location.search).get("w") || extractWorkspaceIdFromPath();

let currentUser = null; // { uid, name }
// Snapshot customers/{uid} yang sudah diambil init() -- dipakai ulang oleh
// klik "Mulai Chat" (lihat startBtn) supaya gak nge-getDoc dokumen yang
// sama dua kali (satu di init(), satu lagi begitu diklik) cuma buat ngecek
// isNewCustomer, yang nambah 1 round-trip ke Firestore sebelum chat-nya
// kebuka.
let initialCustomerSnap = null;
let workspaceBrandName = null;
let autoGreetingEnabled = false;
let autoGreetingMessage = "";
let autoGreetingOptions = [];
let autoGreetingOptionReplies = {};
let businessHours = null; // { enabled, days, start, end, offlineMessage } | null = fitur nonaktif
let sessionActive = false; // false = belum chat, atau sesi dihapus admin & belum mulai ulang
let unsubMessages = null;
let unsubCustomerDoc = null;
let presenceIntervalId = null;

const authBrandIconEl = document.getElementById("auth-brand-icon");
const loadingScreen = document.getElementById("loading-screen");
const workspaceErrorScreen = document.getElementById("workspace-error-screen");
const loginScreen = document.getElementById("login-screen");
const chatScreen = document.getElementById("chat-screen");
const nameInput = document.getElementById("name-input");
const hpCheckInput = document.getElementById("hp-check");
const startBtn = document.getElementById("start-btn");
const startError = document.getElementById("start-error");
const chatHeader = document.getElementById("chat-header");
const messagesEl = document.getElementById("messages");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const imageInput = document.getElementById("image-input");
const sessionEndedBanner = document.getElementById("session-ended-banner");
const hoursOfflineBanner = document.getElementById("hours-offline-banner");
const hoursOfflineBannerLogin = document.getElementById("hours-offline-banner-login");
const brandNameEls = document.querySelectorAll("[data-brand-name]");

function wsPath(...segments) {
  return ["workspaces", workspaceId, ...segments];
}

// Kunci tanggal (YYYY-MM-DD) berdasarkan WIB, dipakai untuk mengelompokkan
// counter statistik harian di dashboard admin.
function todayKeyWIB() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function bumpStat(field) {
  setDoc(doc(db, ...wsPath("stats", todayKeyWIB())), { [field]: increment(1) }, { merge: true }).catch(() => {});
}

// Satu-satunya titik yang boleh memicu signInAnonymously, supaya init() (yang
// jalan otomatis saat halaman dibuka) dan tombol "Mulai Chat" (diklik user)
// tidak pernah balapan membuat dua sesi anonim berbeda di saat bersamaan.
let signInPromise = null;
function ensureSignedIn() {
  if (!signInPromise) {
    signInPromise = auth.currentUser
      ? Promise.resolve(auth.currentUser)
      : signInAnonymously(auth).then((cred) => cred.user);
  }
  return signInPromise;
}

function showStartError(message) {
  startError.textContent = message;
  startError.classList.remove("hidden");
}

function applyBrandName(name) {
  workspaceBrandName = name;
  document.title = name;
  brandNameEls.forEach((el) => {
    el.textContent = name;
  });
}

function applyHeaderLogo(dataUrl) {
  if (!authBrandIconEl || !dataUrl) return;
  authBrandIconEl.innerHTML = "";
  const img = document.createElement("img");
  img.src = dataUrl;
  img.alt = "";
  img.className = "auth-brand-icon-img";
  authBrandIconEl.appendChild(img);
}

function applyThemeColor(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  document.documentElement.style.setProperty("--accent", hex);
}

// Cache branding di localStorage (per workspace) supaya kunjungan
// BERIKUTNYA dari browser yang sama bisa langsung tampil branding asli
// sejak awal (bukan kedipan biru/"Customer Service" default dulu baru
// ganti) -- lihat init(). Selalu ditimpa ulang tiap kali data asli dari
// Firestore selesai diambil, jadi kalau admin ganti branding, kunjungan
// berikutnya tetap ke-refresh (cache cuma mempercepat tampilan AWAL, bukan
// sumber kebenaran).
const BRAND_CACHE_PREFIX = "lc_brand_";

function loadCachedBranding() {
  try {
    const raw = localStorage.getItem(BRAND_CACHE_PREFIX + workspaceId);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function saveCachedBranding(brandName, themeColor, headerLogoBase64) {
  try {
    localStorage.setItem(
      BRAND_CACHE_PREFIX + workspaceId,
      JSON.stringify({ brandName: brandName || null, themeColor: themeColor || null, headerLogoBase64: headerLogoBase64 || null })
    );
  } catch (err) {
    // localStorage penuh/diblokir (mis. mode privat) -- gak krusial, abaikan
  }
}

function updateOfflineBanners() {
  const online = isWithinBusinessHours(businessHours);
  const message = (businessHours && businessHours.offlineMessage) ||
    "Tim kami sedang tidak online saat ini. Silakan tinggalkan pesan, kami akan balas begitu online kembali.";

  [hoursOfflineBanner, hoursOfflineBannerLogin].forEach((el) => {
    if (!el) return;
    if (online) {
      el.classList.add("hidden");
    } else {
      el.textContent = "🌙 " + message;
      el.classList.remove("hidden");
    }
  });
}

// Ambil IP & perkiraan lokasi dari layanan lookup publik (tanpa perlu izin
// browser, beda dengan navigator.geolocation). Dipakai admin saja untuk
// konteks tambahan. Coba ipapi.co dulu, kalau gagal/diblokir (mis. oleh
// ad-blocker) coba ipwho.is sebagai cadangan, gagal-diamkan kalau dua-duanya
// tidak bisa diakses supaya tidak menghalangi customer chat.
async function fetchVisitorInfo() {
  try {
    const res = await fetch("https://ipapi.co/json/");
    if (res.ok) {
      const data = await res.json();
      if (!data.error && data.ip) {
        return { ip: data.ip, city: data.city || null, region: data.region || null, country: data.country_name || null };
      }
    }
  } catch (err) {
    // lanjut coba layanan cadangan
  }

  try {
    const res = await fetch("https://ipwho.is/");
    if (res.ok) {
      const data = await res.json();
      if (data.success !== false && data.ip) {
        return { ip: data.ip, city: data.city || null, region: data.region || null, country: data.country || null };
      }
    }
  } catch (err) {
    // kedua layanan gagal
  }

  return null;
}

async function captureVisitorInfo(uid) {
  const info = await fetchVisitorInfo();
  if (!info) {
    console.warn("Gagal mengambil info IP/lokasi customer (layanan lookup tidak bisa diakses).");
    return;
  }
  try {
    await setDoc(doc(db, ...wsPath("customers", uid)), info, { merge: true });
  } catch (err) {
    console.error("Gagal menyimpan info IP/lokasi:", err);
  }
}

function formatTimeWIB(timestamp) {
  if (!timestamp || !timestamp.toDate) return "";
  return (
    timestamp.toDate().toLocaleTimeString("id-ID", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Jakarta"
    }) + " WIB"
  );
}

function formatDateWIB(timestamp) {
  if (!timestamp || !timestamp.toDate) return "";
  return timestamp.toDate().toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Jakarta"
  });
}

function createDateDivider(label) {
  const div = document.createElement("div");
  div.className = "date-divider";
  div.textContent = label;
  return div;
}

function renderMessage(m) {
  const div = document.createElement("div");
  div.className = "message " + (m.sender === "customer" ? "mine" : "theirs");

  const senderRow = document.createElement("div");
  senderRow.className = "sender-row";

  if (m.sender === "admin" && m.senderPhoto) {
    const avatar = document.createElement("img");
    avatar.className = "msg-avatar";
    avatar.src = m.senderPhoto;
    senderRow.appendChild(avatar);
  }

  const senderLabel = document.createElement("span");
  senderLabel.className = "sender";
  senderLabel.textContent = m.sender === "customer" ? "Anda" : m.senderName || workspaceBrandName || "Customer Service";
  senderRow.appendChild(senderLabel);

  if (m.edited) {
    const editedBadge = document.createElement("span");
    editedBadge.className = "edited-badge";
    editedBadge.textContent = "(diedit)";
    senderRow.appendChild(editedBadge);
  }

  div.appendChild(senderRow);

  if (m.type === "image" && m.imageBase64) {
    const img = document.createElement("img");
    img.className = "chat-image";
    img.src = m.imageBase64;
    img.addEventListener("click", () => showImageLightbox(m.imageBase64));
    div.appendChild(img);
  } else if (m.type === "options" && Array.isArray(m.options) && m.options.length) {
    const p = document.createElement("p");
    p.textContent = m.text || "Silakan pilih salah satu:";
    div.appendChild(p);

    const limitReached = optionSelectCount >= OPTION_SELECT_LIMIT;

    const optWrap = document.createElement("div");
    optWrap.className = "option-buttons";
    m.options.forEach((opt) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "option-btn";
      btn.textContent = opt;
      btn.disabled = limitReached;
      btn.addEventListener("click", () => selectOption(opt));
      optWrap.appendChild(btn);
    });
    div.appendChild(optWrap);

    if (limitReached) {
      const hint = document.createElement("p");
      hint.className = "option-limit-hint";
      hint.textContent = "Batas pemilihan menu bantuan tercapai. Ketik pesan langsung untuk melanjutkan.";
      div.appendChild(hint);
    }
  } else {
    const p = document.createElement("p");
    renderTextWithLinks(p, m.text || "");
    div.appendChild(p);
  }

  const timeEl = document.createElement("span");
  timeEl.className = "msg-time";
  timeEl.textContent = formatTimeWIB(m.timestamp);
  div.appendChild(timeEl);

  return div;
}

let knownAdminInfo = null;

function updateChatHeader() {
  chatHeader.innerHTML = "";
  if (knownAdminInfo && knownAdminInfo.photo) {
    const avatar = document.createElement("img");
    avatar.className = "header-avatar";
    avatar.src = knownAdminInfo.photo;
    chatHeader.appendChild(avatar);
  }
  const span = document.createElement("span");
  span.className = "chat-header-title";
  span.textContent = (knownAdminInfo && knownAdminInfo.name) || workspaceBrandName || "Customer Service";
  chatHeader.appendChild(span);
}

function enterChat(uid, name) {
  sessionActive = true;
  currentUser = { uid, name };
  loginScreen.classList.add("hidden");
  chatScreen.classList.remove("hidden");
  updateChatHeader();
  listenMessages();
  listenSessionAlive(uid);
  startPresenceHeartbeat();
}

// Kalau admin menghapus dokumen customers/{uid} ini (tombol "Hapus Semua
// Chat"), dokumennya lenyap dari Firestore -- listener di bawah nangkep itu
// realtime dan langsung mengunci sesi di sisi customer, bukan cuma pas
// reload halaman berikutnya.
function listenSessionAlive(uid) {
  if (unsubCustomerDoc) unsubCustomerDoc();
  unsubCustomerDoc = onSnapshot(doc(db, ...wsPath("customers", uid)), (snap) => {
    if (!snap.exists()) handleSessionDeleted();
  });
}

// Sengaja TIDAK melempar customer balik ke layar login -- tetap di layar
// chat (biar riwayat pesan yg sempat kebaca tetap kelihatan), tapi form
// dikunci total dan dikasih keterangan "sesi telah habis". Supaya bisa chat
// lagi, customer harus benar-benar tutup tab & buka ulang link-nya (itu yang
// bikin sesi baru dari nol), bukan cuma klik tombol di halaman yang sama.
function handleSessionDeleted() {
  if (!sessionActive) return; // sudah ditangani / belum pernah mulai chat
  sessionActive = false;
  if (rtdb) goOfflineRtdb();

  if (unsubMessages) unsubMessages();
  if (unsubCustomerDoc) unsubCustomerDoc();
  if (presenceIntervalId) clearInterval(presenceIntervalId);
  unsubMessages = null;
  unsubCustomerDoc = null;
  presenceIntervalId = null;

  messageInput.disabled = true;
  imageInput.disabled = true;
  messageForm.classList.add("locked");
  sessionEndedBanner.classList.remove("hidden");
}

// Presence (online/offline), diutamakan lewat Realtime Database:
// onDisconnect() bikin server RTDB sendiri yang nandain offline begitu
// koneksi putus (tab ditutup, internet mati, dll), tanpa perlu nulis
// berkala dari klien. Fallback ke heartbeat Firestore lama (setDoc tiap 30
// detik) kalau rtdb null (databaseURL belum di-setup, lihat
// firebase-config.js). Ini gantinya heartbeat 10-detik lama yang jadi
// sumber tulisan/bacaan Firestore terbesar dan bikin kuota gratis harian
// jebol pas 50 customer aktif bareng -- RTDB dihitung dari
// bandwidth/penyimpanan, bukan per operasi, jadi jauh lebih murah untuk
// pola tulis sesering ini (lihat memory 2026-08-09).
const PRESENCE_HEARTBEAT_MS = 30000; // dipakai fallback Firestore saja

function rtdbPresenceRef(uid) {
  return rtdbRef(rtdb, `presence/${workspaceId}/${uid}`);
}

// Bikin sekali di sini, dipakai baik oleh payload online maupun offline
// (langsung & lewat onDisconnect) -- supaya ubah bentuk datanya nanti cukup
// di satu tempat, gak keselip di salah satu dari 3 titik yang sebelumnya
// masing-masing punya literal sendiri.
function presencePayload(online) {
  return { online, name: currentUser.name, lastActiveAt: rtdbServerTimestamp() };
}

function goOnlineRtdb() {
  if (!rtdb || !currentUser || !sessionActive) return;
  const presRef = rtdbPresenceRef(currentUser.uid);
  // Didaftarkan ulang tiap kali balik online -- RTDB otomatis membatalkan
  // onDisconnect lama begitu koneksi socket-nya putus, jadi ini aman
  // dipanggil berulang tanpa numpuk.
  onDisconnect(presRef).set(presencePayload(false));
  rtdbSet(presRef, presencePayload(true)).catch(() => {});
}

function goOfflineRtdb() {
  if (!rtdb || !currentUser) return;
  rtdbSet(rtdbPresenceRef(currentUser.uid), presencePayload(false)).catch(() => {});
}

function sendHeartbeat() {
  if (!currentUser || !sessionActive || document.visibilityState !== "visible") return;
  setDoc(
    doc(db, ...wsPath("customers", currentUser.uid)),
    { lastActiveAt: serverTimestamp() },
    { merge: true }
  ).catch(() => {});
}

// Begitu tab di-background/ditutup, langsung tandai offline (bukan nunggu
// heartbeat basi) supaya admin lihat statusnya berubah nyaris seketika lewat
// realtime listener, bukan lewat threshold basi di admin.js.
function sendOfflineSignal() {
  if (!currentUser || !sessionActive) return;
  setDoc(
    doc(db, ...wsPath("customers", currentUser.uid)),
    { lastActiveAt: null },
    { merge: true }
  ).catch(() => {});
}

// Listener visibilitychange/pagehide didaftarkan sekali di scope modul (bukan
// tiap enterChat) supaya tidak numpuk kalau customer mulai sesi baru lagi
// setelah sesi lamanya dihapus admin, tanpa reload halaman.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (rtdb) goOnlineRtdb();
    else sendHeartbeat();
  } else if (rtdb) {
    goOfflineRtdb();
  } else {
    sendOfflineSignal();
  }
});
window.addEventListener("pagehide", () => {
  if (rtdb) goOfflineRtdb();
  else sendOfflineSignal();
});

function startPresenceHeartbeat() {
  if (rtdb) {
    goOnlineRtdb();
    return;
  }
  if (presenceIntervalId) clearInterval(presenceIntervalId);
  sendHeartbeat();
  presenceIntervalId = setInterval(sendHeartbeat, PRESENCE_HEARTBEAT_MS);
}

function listenMessages() {
  if (unsubMessages) unsubMessages();
  const q = query(
    collection(db, ...wsPath("chats", currentUser.uid, "messages")),
    orderBy("timestamp", "asc")
  );
  unsubMessages = onSnapshot(q, (snap) => {
    messagesEl.innerHTML = "";
    let latestAdminInfo = null;
    let lastDate = null;
    snap.forEach((docSnap) => {
      const m = docSnap.data();
      const dateLabel = formatDateWIB(m.timestamp);
      if (dateLabel && dateLabel !== lastDate) {
        messagesEl.appendChild(createDateDivider(dateLabel));
        lastDate = dateLabel;
      }
      messagesEl.appendChild(renderMessage(m));
      if (m.sender === "admin") {
        latestAdminInfo = { name: m.senderName, photo: m.senderPhoto };
      }
    });
    if (latestAdminInfo) {
      knownAdminInfo = latestAdminInfo;
      updateChatHeader();
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

async function touchCustomerDoc(lastMessage) {
  await setDoc(
    doc(db, ...wsPath("customers", currentUser.uid)),
    {
      name: currentUser.name,
      lastMessage,
      lastMessageAt: serverTimestamp(),
      lastSender: "customer",
      unreadCount: increment(1),
      archived: false,
      archivedAt: null,
      expireAt: null,
      typingDraft: null
    },
    { merge: true }
  );
}

function indexSearchText(text) {
  if (!text || !currentUser) return;
  setDoc(
    doc(db, ...wsPath("customers", currentUser.uid)),
    { searchText: arrayUnion(text) },
    { merge: true }
  ).catch(() => {});
}

// SATU-SATUNYA titik yang boleh addDoc ke chats/{uid}/messages, dipakai baik
// buat pesan customer beneran maupun pesan bot (sapaan/menu/balasan
// otomatis). Kalau messageData ada field `text`, otomatis ikut terindeks ke
// searchText -- jadi nambah jenis pesan baru nanti tidak akan lagi
// kelewatan diindeks kayak yang sempat kejadian di fitur auto-chat
// (searchText cuma keisi lewat touchCustomerDoc, padahal pesan bot tidak
// pernah lewat situ). Preview "pesan terakhir" di sidebar admin (lastMessage/
// lastMessageAt/lastSender) juga selalu disamakan di sini dengan alasan yang
// sama -- sapaan/menu/balasan otomatis lewat writeMessage() langsung, bukan
// touchCustomerDoc(), jadi tanpa ini previewnya nyangkut di pesan sebelumnya
// (mis. masih nunjukin label pilihan yang diklik customer, padahal sudah
// disusul balasan otomatis).
async function writeMessage(uid, messageData) {
  await addDoc(collection(db, ...wsPath("chats", uid, "messages")), messageData);
  if (messageData.text) indexSearchText(messageData.text);

  const preview =
    messageData.type === "image" ? "📷 Gambar" : messageData.type === "options" ? "📋 Menu pilihan" : messageData.text || "";
  setDoc(
    doc(db, ...wsPath("customers", uid)),
    { lastMessage: preview, lastMessageAt: serverTimestamp(), lastSender: messageData.sender },
    { merge: true }
  ).catch(() => {});
}

// Kirim draf ketikan customer ke admin secara real-time (di-debounce supaya
// tidak menulis ke Firestore di setiap ketukan tombol).
let typingDebounceTimer = null;
function updateTypingDraft(text) {
  if (!currentUser || !sessionActive) return;
  clearTimeout(typingDebounceTimer);
  typingDebounceTimer = setTimeout(() => {
    if (!currentUser || !sessionActive) return;
    setDoc(
      doc(db, ...wsPath("customers", currentUser.uid)),
      { typingDraft: text.trim() ? text : null },
      { merge: true }
    ).catch(() => {});
  }, 400);
}

messageInput.addEventListener("input", () => {
  updateTypingDraft(messageInput.value);
});

// Dipakai baik oleh form kirim pesan biasa maupun tombol pilihan bantuan
// (lihat renderMessage type "options") -- keduanya butuh urutan addDoc ->
// touchCustomerDoc -> bumpStat yang persis sama.
async function sendTextMessage(text) {
  if (!text || !currentUser || !sessionActive) return;

  try {
    await writeMessage(currentUser.uid, {
      sender: "customer",
      type: "text",
      text,
      timestamp: serverTimestamp()
    });
  } catch (err) {
    console.error("Gagal addDoc ke chats/" + currentUser.uid + "/messages:", err);
    alert("Gagal mengirim pesan (tulis chat): " + err.code + " - " + err.message);
    return;
  }

  try {
    await touchCustomerDoc(text);
  } catch (err) {
    console.error("Gagal setDoc ke customers/" + currentUser.uid + ":", err);
    alert("Gagal mengirim pesan (update profil customer): " + err.code + " - " + err.message);
    return;
  }

  bumpStat("messageCount");
  bumpStat("customerMessageCount");
}

// Customer cuma boleh pakai tombol pilihan bantuan maksimal 2x per sesi chat
// (supaya tidak dipakai spam auto-reply berulang-ulang) -- dihitung dari
// field optionSelectCount di dokumen customers/{uid}, jadi batasnya tetap
// berlaku walau halaman di-reload, bukan cuma variabel in-memory.
const OPTION_SELECT_LIMIT = 2;
let optionSelectCount = 0;

// Diklik dari tombol pilihan bantuan (lihat renderMessage type "options").
// Kirim pilihannya sebagai pesan customer biasa dulu, lalu kalau admin sudah
// nyetel balasan otomatis buat pilihan itu (Pengaturan > Auto-Chat), susulkan
// balasannya dengan jeda singkat.
async function selectOption(opt) {
  if (!currentUser || !sessionActive || optionSelectCount >= OPTION_SELECT_LIMIT) return;

  // Dinaikkan duluan secara synchronous (sebelum await apa pun) supaya
  // klik ganda yang nyaris bersamaan tidak bisa dua-duanya lolos dari guard
  // di atas.
  optionSelectCount++;
  setDoc(
    doc(db, ...wsPath("customers", currentUser.uid)),
    { optionSelectCount: increment(1) },
    { merge: true }
  ).catch(() => {});

  await sendTextMessage(opt);

  const reply = autoGreetingOptionReplies[opt];
  if (!reply || !currentUser || !sessionActive) return;

  setTimeout(() => {
    if (!currentUser || !sessionActive) return;
    writeMessage(currentUser.uid, {
      sender: "admin",
      type: "text",
      text: reply,
      optionLabel: opt,
      autoReply: true,
      timestamp: serverTimestamp()
    }).catch(() => {});
  }, 800);
}

messageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  messageInput.value = "";
  await sendTextMessage(text);
});

// Dipakai baik oleh input file (klik ikon 🖼️) maupun paste screenshot
// (Ctrl+V) langsung di kolom pesan -- lihat listener "paste" di bawah.
async function sendImageFile(file) {
  if (!file || !currentUser || !sessionActive) return;

  let dataUrl;
  try {
    dataUrl = await compressImageFile(file, { maxDimension: 1200, maxDataUrlLength: 700000 });
  } catch (err) {
    alert(err.message || "Gagal memproses gambar.");
    return;
  }

  // Kasih preview dulu sebelum beneran kekirim ke chat -- jangan langsung
  // nyelonong begitu file dipilih/di-paste, customer bisa batal.
  const confirmed = await showImageSendConfirm(dataUrl);
  if (!confirmed || !sessionActive) return;

  try {
    await writeMessage(currentUser.uid, {
      sender: "customer",
      type: "image",
      imageBase64: dataUrl,
      timestamp: serverTimestamp()
    });
    await touchCustomerDoc("📷 Gambar");
    bumpStat("messageCount");
    bumpStat("customerMessageCount");
  } catch (err) {
    alert(err.message || "Gagal mengirim gambar.");
  }
}

imageInput.addEventListener("change", async () => {
  const file = imageInput.files[0];
  imageInput.value = "";
  await sendImageFile(file);
});

// Ctrl+V screenshot/gambar langsung di kolom pesan -- tidak perlu klik ikon
// 🖼️ dulu. clipboardData.items cuma keisi kalau clipboard-nya beneran ada
// gambar (mis. hasil screenshot), jadi paste teks biasa tetap jalan normal.
messageInput.addEventListener("paste", (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;

  const imageItem = Array.from(items).find((item) => item.type.startsWith("image/"));
  if (!imageItem) return;

  e.preventDefault();
  const file = imageItem.getAsFile();
  if (file) sendImageFile(file);
});


startBtn.addEventListener("click", async () => {
  // Honeypot: field ini disembunyikan lewat CSS (bukan hidden), jadi
  // pengguna asli tidak mungkin ngisi. Kalau kesisi, diam-diam berhenti di
  // sini tanpa pesan error apa pun -- bot auto-fill biasanya tidak
  // membedakan ini dari field beneran.
  if (hpCheckInput && hpCheckInput.value) return;

  const name = nameInput.value.trim();
  if (!name) {
    showStartError("Username tidak boleh kosong.");
    return;
  }

  startBtn.disabled = true;
  startError.classList.add("hidden");

  try {
    const user = await ensureSignedIn();
    // Dipakai ulang dari init() (lihat initialCustomerSnap) kalau ada --
    // fallback getDoc cuma buat jaga-jaga kalau entah kenapa belum keisi.
    const existingSnap = initialCustomerSnap || (await getDoc(doc(db, ...wsPath("customers", user.uid))));
    const isNewCustomer = !existingSnap.exists();
    optionSelectCount = isNewCustomer ? 0 : existingSnap.data().optionSelectCount || 0;

    const initialUpdate = {
      name,
      lastMessage: "",
      lastMessageAt: serverTimestamp(),
      lastSender: null
    };
    // Dulu field ini cuma keisi pas pertama kali diarsipkan -- jadi
    // dokumen customer lama/baru-mulai-chat sempat gak punya field
    // `archived` sama sekali. Set eksplisit di sini (bukan cuma di
    // touchCustomerDoc/archiveCustomer) supaya ke depan query admin bisa
    // aman pakai where("archived","==",...) tanpa diam-diam kelewat
    // dokumen yang field-nya belum pernah keisi.
    if (isNewCustomer) initialUpdate.archived = false;
    // Cuma dicatat sekali di awal sesi baru -- dipakai admin.js buat hitung
    // "waktu respon pertama" (lihat recordFirstResponseIfNeeded). Kalau
    // customer lama, jangan sampai ke-reset dan bikin metriknya salah.
    if (isNewCustomer) initialUpdate.firstCustomerMessageAt = serverTimestamp();

    await setDoc(doc(db, ...wsPath("customers", user.uid)), initialUpdate, { merge: true });
    if (isNewCustomer) bumpStat("newCustomers");
    enterChat(user.uid, name);
    captureVisitorInfo(user.uid);

    if (isNewCustomer && autoGreetingEnabled) {
      if (autoGreetingMessage) {
        writeMessage(user.uid, {
          sender: "admin",
          type: "text",
          text: autoGreetingMessage,
          timestamp: serverTimestamp(),
          autoGreeting: true
        }).catch(() => {});
      }

      // Menyusul sapaan dengan jeda singkat (kesan "bot lagi ngetik"),
      // supaya tidak numpuk 2 pesan dalam 1 detik yang sama.
      if (autoGreetingOptions.length > 0) {
        setTimeout(() => {
          writeMessage(user.uid, {
            sender: "admin",
            type: "options",
            options: autoGreetingOptions,
            timestamp: serverTimestamp(),
            autoGreeting: true
          }).catch(() => {});
        }, 900);
      }
    }
  } catch (err) {
    showStartError("Gagal memulai chat: " + err.message);
    startBtn.disabled = false;
  }
});

nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") startBtn.click();
});

// Ambil terus coba lagi kalau gagal (WiFi/data seluler yang putus sesaat) --
// dipakai terpisah oleh alur branding maupun alur auto-rejoin di bawah,
// masing-masing retry sendiri-sendiri.
async function withRetries(fn, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      console.error(`Percobaan ${attempt}/${maxAttempts} gagal:`, err);
      if (attempt === maxAttempts) return null;
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
    }
  }
}

// Ambil dokumen workspace/workspaceSlugs lewat REST API Firestore langsung
// (fetch mentah), BUKAN lewat SDK (getDoc) -- persis pola yang sudah lama
// dipakai widget.js buat hal yang sama. SDK Firestore/Auth di sini selalu
// nunggu App Check ngambil token reCAPTCHA v3 dulu sebelum request-nya
// beneran ditembak (berlaku ke SEMUA panggilan lewat SDK, termasuk yang
// rule-nya publik kayak dokumen ini) -- itu ternyata jadi bottleneck utama
// yang masih nyisa walau sudah dipisah dari sign-in. Kedua koleksi ini
// (workspaces, workspaceSlugs) memang allow-read-if-true di
// firestore.rules, jadi fetch mentah tanpa App Check tetap sah/diizinkan
// server, cuma lompat App Check yang gak perlu-perlu amat buat baca data
// yang toh sudah publik.
function unwrapFirestoreValue(v) {
  if (!v) return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("arrayValue" in v) return ((v.arrayValue.values) || []).map(unwrapFirestoreValue);
  if ("mapValue" in v) {
    const out = {};
    const fields = (v.mapValue && v.mapValue.fields) || {};
    for (const k in fields) out[k] = unwrapFirestoreValue(fields[k]);
    return out;
  }
  if ("nullValue" in v) return null;
  return undefined;
}

async function fetchFirestoreDocRest(...pathSegments) {
  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    firebaseConfig.projectId +
    "/databases/(default)/documents/" +
    pathSegments.map(encodeURIComponent).join("/");
  const res = await fetch(url);
  if (res.status === 404) return null; // dokumennya emang belum ada, bukan error
  if (!res.ok) throw new Error("Firestore REST fetch gagal (" + res.status + ")");
  const json = await res.json();
  if (!json || !json.fields) return null;
  const out = {};
  for (const k in json.fields) out[k] = unwrapFirestoreValue(json.fields[k]);
  return out;
}

async function resolveWorkspaceDataFast() {
  let wsData = await fetchFirestoreDocRest("workspaces", workspaceId);
  if (!wsData) {
    // ID workspace asli case-sensitive, tapi sebagian CMS/website
    // perusahaan otomatis mengubah URL yang ditempel jadi huruf kecil
    // semua (dianggap "slug") -- kalau ID persis tidak ketemu, coba tabel
    // alias huruf-kecil (dibuat otomatis tiap admin login, lihat admin.js
    // ensureWorkspaceSlug) sebelum benar-benar menyerah.
    const slugData = await fetchFirestoreDocRest("workspaceSlugs", workspaceId.toLowerCase());
    if (slugData && slugData.workspaceId) {
      workspaceId = slugData.workspaceId;
      wsData = await fetchFirestoreDocRest("workspaces", workspaceId);
    }
  }
  return wsData;
}

function applyWorkspaceData(wsData) {
  if (!wsData) return;
  if (wsData.brandName) applyBrandName(wsData.brandName);
  if (wsData.themeColor) applyThemeColor(wsData.themeColor);
  if (wsData.headerLogoBase64) applyHeaderLogo(wsData.headerLogoBase64);
  saveCachedBranding(wsData.brandName, wsData.themeColor, wsData.headerLogoBase64);
  autoGreetingEnabled = !!wsData.autoGreetingEnabled;
  autoGreetingMessage = wsData.autoGreetingMessage || "";
  autoGreetingOptions = Array.isArray(wsData.autoGreetingOptions) ? wsData.autoGreetingOptions : [];
  autoGreetingOptionReplies =
    wsData.autoGreetingOptionReplies && typeof wsData.autoGreetingOptionReplies === "object"
      ? wsData.autoGreetingOptionReplies
      : {};
  businessHours = {
    enabled: !!wsData.businessHoursEnabled,
    days: Array.isArray(wsData.businessHoursDays) ? wsData.businessHoursDays : [],
    start: wsData.businessHoursStart || "09:00",
    end: wsData.businessHoursEnd || "17:00",
    offlineMessage: wsData.offlineMessage || ""
  };
  updateOfflineBanners();
  // Status online/offline murni soal jam berjalan, bukan nunggu event
  // Firestore -- dicek ulang tiap menit supaya banner-nya akurat kalau
  // customer buka halaman ini lama (mis. pas jam kerja lagi mepet).
  setInterval(updateOfflineBanners, 60000);
}

// Dua alur ini ditembak BERSAMAAN dan SALING GAK NUNGGU, bukan satu
// sesudah yang lain:
// - Branding (dokumen workspace) diambil lewat REST langsung
//   (resolveWorkspaceDataFast), gak lewat SDK -- lihat catatan panjang di
//   situ soal kenapa. onBrandingSettled dipanggil begitu ini selesai
//   (berhasil ATAU akhirnya menyerah) -- dipakai init() buat nunggu
//   branding asli (kalau sempat) sebelum form ditampilkan, lihat GRACE_MS
//   di sana.
// - Auto-rejoin BUTUH uid (hasil sign-in lewat SDK) buat tahu dokumen
//   customer mana yang harus dicek, jadi tetap lewat jalur SDK+App Check
//   biasa -- tapi ini gak lagi menahan branding supaya nongol bareng.
function loadInitialDataInBackground(onBrandingSettled) {
  withRetries(async () => {
    const wsData = await resolveWorkspaceDataFast();
    applyWorkspaceData(wsData);
  }).finally(() => {
    if (onBrandingSettled) onBrandingSettled();
  });

  withRetries(async () => {
    const user = await ensureSignedIn();
    const customerSnap = await getDoc(doc(db, ...wsPath("customers", user.uid)));
    initialCustomerSnap = customerSnap;
    // Auto rejoin kalau browser ini sudah pernah chat sebelumnya -- TAPI
    // cuma kalau customer belum keburu mulai sesi baru sendiri lewat form
    // yang sudah kelihatan duluan (lihat sessionActive di enterChat()).
    // Kalau sudah, jangan diapa-apain lagi di sini -- sesi yang lagi
    // jalan itu yang menang, bukan hasil auto-rejoin yang telat datang.
    if (!sessionActive && customerSnap.exists() && customerSnap.data().name) {
      optionSelectCount = customerSnap.data().optionSelectCount || 0;
      enterChat(user.uid, customerSnap.data().name);
      captureVisitorInfo(user.uid);
    }
  });
}

function init() {
  if (!workspaceId) {
    loadingScreen.classList.add("hidden");
    workspaceErrorScreen.classList.remove("hidden");
    return;
  }

  // Kalau browser ini pernah buka workspace ini sebelumnya, pakai branding
  // dari cache (lihat loadCachedBranding) -- branding-nya sudah pasti
  // benar, jadi form langsung ditampilkan seketika, gak perlu nunggu apa
  // pun lagi.
  const cached = loadCachedBranding();
  if (cached) {
    if (cached.brandName) applyBrandName(cached.brandName);
    if (cached.themeColor) applyThemeColor(cached.themeColor);
    if (cached.headerLogoBase64) applyHeaderLogo(cached.headerLogoBase64);
  }

  let revealed = false;
  function revealLoginScreen() {
    if (revealed) return;
    revealed = true;
    loadingScreen.classList.add("hidden");
    loginScreen.classList.remove("hidden");
  }

  if (cached) {
    revealLoginScreen();
  } else {
    // Kunjungan pertama (belum ada cache) -- kasih jeda SINGKAT buat nunggu
    // branding asli kebaca dulu sebelum form ditampilkan, supaya customer
    // tidak sempat lihat branding default (biru/"Customer Service") sama
    // sekali kalau jaringannya cukup cepat. GRACE_MS cuma jaring pengaman
    // kalau lambat/gagal -- form tetap ditampilkan (branding default) biar
    // customer tidak macet nunggu selamanya, sama seperti sebelumnya.
    const GRACE_MS = 1200;
    setTimeout(revealLoginScreen, GRACE_MS);
  }

  loadInitialDataInBackground(revealLoginScreen);
}

init();

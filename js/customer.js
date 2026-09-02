import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc,
  setDoc,
  getDoc,
  getDocs,
  runTransaction,
  collection,
  query,
  orderBy,
  limit,
  startAfter,
  onSnapshot,
  addDoc,
  serverTimestamp,
  increment,
  Timestamp
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import {
  initializeAppCheck,
  ReCaptchaV3Provider
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app-check.js";
import {
  getDatabase,
  ref as rtdbRef,
  set as rtdbSet,
  remove as rtdbRemove,
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
// localCache: riwayat chat yang pernah dimuat di browser ini kesimpan di
// IndexedDB, jadi buka ulang/refresh halaman chat yang sama bisa langsung
// tampil dari cache sambil sync di belakang, bukan nunggu round-trip network
// lagi dari nol. Multi tab manager buat jaga-jaga customer buka >1 tab --
// kalau IndexedDB/persistence tidak didukung browser-nya, otomatis fallback
// ke cache di-memori biasa (tidak crash).
const db = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true,
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
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
// Sama seperti sisi admin (lihat MESSAGES_PAGE_SIZE di admin.js) -- customer
// langganan lama bisa punya ribuan pesan, load & render SEMUANYA tiap buka/
// refresh chat makin lama makin berat. Cuma MESSAGES_PAGE_SIZE pesan terbaru
// yang live; lebih lama dimuat sesuai kebutuhan (scroll ke atas) lewat
// loadOlderMessages(), lihat listenMessages().
const MESSAGES_PAGE_SIZE = 40;
// Full-rebuild (buka chat baru, atau edit/hapus pesan tengah histori) yang
// langsung nge-render semua MESSAGES_PAGE_SIZE bubble sekaligus secara
// sinkron bisa makan 1-2 detik di riwayat panjang & banyak gambar base64 --
// selama itu browser tidak sempat menggambar apa pun (layar kelihatan hitam
// kosong sesaat). Cuma INITIAL_VISIBLE_MESSAGES pesan terbaru yang dirender
// sinkron (langsung muncul cepat), sisanya menyusul di frame berikutnya
// lewat renderMessagesProgressively() supaya tidak nge-block first paint.
const INITIAL_VISIBLE_MESSAGES = 20;
let liveRenderToken = 0; // dicek deferred head-chunk renderMessagesProgressively() sebelum nempel, biar aman dari race kalau chat sudah di-render ulang duluan
// Di-set true tepat sebelum customer kirim pesan sendiri (teks/gambar) --
// kalau lagi scroll ke atas baca histori lama terus kirim pesan baru,
// pesannya sendiri harus tetap kelihatan (ikut discroll ke bawah) biarpun
// posisi scroll saat itu jauh dari bawah. Sama persis dengan admin.js.
let forceScrollToBottomNext = false;
let oldestLoadedMessageTimestamp = null; // cursor buat loadOlderMessages()
let oldestRenderedDateLabel = null; // date-divider paling atas yg lagi tampil, buat cegah dobel di sambungan
let olderBoundaryDateLabel = null; // tanggal pesan TERBARU dari batch older pertama yg dimuat (batas sama live window)
let allOlderMessagesLoaded = false;
let loadingOlderMessages = false;
let messagesOlderEl = null; // wrapper (display:contents) buat pesan lama hasil loadOlderMessages()
let messagesLiveEl = null; // wrapper (display:contents) buat MESSAGES_PAGE_SIZE pesan terbaru (live listener)
let messagesLoadingOlderEl = null; // indikator kecil "Memuat pesan lama..." di atas messagesOlderEl

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
const spamLockBanner = document.getElementById("spam-lock-banner");
const DEFAULT_MESSAGE_PLACEHOLDER = messageInput.placeholder;
const hoursOfflineBanner = document.getElementById("hours-offline-banner");
const hoursOfflineBannerLogin = document.getElementById("hours-offline-banner-login");
const brandNameEls = document.querySelectorAll("[data-brand-name]");

function wsPath(...segments) {
  return ["workspaces", workspaceId, ...segments];
}

// Memastikan workspaceId sudah pasti versi yang benar (bukan alias huruf
// kecil, lihat resolveWorkspaceDataFast) sebelum kode manapun membangun
// wsPath() buat nulis dokumen customer/chat. Dulu ini gak dijamin -- ada
// race condition: kalau sign-in (App Check/reCAPTCHA) atau klik "Masuk"
// duluan selesai daripada koreksi ID ini, dokumen customer/chat baru kadung
// tertulis ke workspace ID yang salah huruf dan jadi tak terlihat admin
// manapun. Memo (bukan dipanggil ulang tiap kali) supaya cuma nembak REST
// fetch-nya sekali walau dipanggil dari beberapa tempat.
let workspaceResolvedPromise = null;
function resolveWorkspaceIdOnce() {
  if (!workspaceResolvedPromise) {
    workspaceResolvedPromise = withRetries(async () => {
      const wsData = await resolveWorkspaceDataFast();
      applyWorkspaceData(wsData);
    });
  }
  return workspaceResolvedPromise;
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

// stats/{tanggal} dulu 1 dokumen per hari ditulis oleh SEMUA customer+admin
// tiap kali ada pesan -- jadi titik rebutan tulis kalau banyak orang kirim
// pesan bersamaan (Firestore mulai kena contention di atas ~1 tulis/detik
// per dokumen). Sekarang dipecah ke STATS_SHARD_COUNT dokumen per hari
// (ID "{tanggal}_{0..9}"), tiap bumpStat pilih 1 pecahan acak -- openStats()
// di admin.js yang menjumlahkan semua pecahan itu pas ditampilkan.
const STATS_SHARD_COUNT = 10;
function statsShardKey() {
  return `${todayKeyWIB()}_${Math.floor(Math.random() * STATS_SHARD_COUNT)}`;
}

function bumpStat(field) {
  setDoc(doc(db, ...wsPath("stats", statsShardKey())), { [field]: increment(1) }, { merge: true }).catch(() => {});
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

// Bangun sekumpulan pesan (ascending) jadi 1 fragment, sisipkan date-divider
// tiap kali tanggalnya berubah. precedingDateLabel = tanggal pesan yang
// SUDAH tampil tepat sebelum batch ini (kalau ada) -- dipakai supaya
// divider pertama batch ini tidak dobel kalau tanggalnya sama dengan yang
// di sambungan (lihat pemakaiannya di listenMessages()/loadOlderMessages()).
// Sama persis dengan admin.js -- lihat catatan panjang di sana soal kenapa
// paginasi ini ada, disalin (bukan di-share modul) karena customer.js dan
// admin.js punya renderMessage() dengan signature beda (customer.js gak
// perlu messageId, gak ada tombol edit/hapus di sisi customer).
function buildMessagesFragment(docs, precedingDateLabel) {
  const fragment = document.createDocumentFragment();
  let lastDate = precedingDateLabel || null;
  let firstDateLabel = null;
  docs.forEach((docSnap) => {
    const m = docSnap.data();
    const dateLabel = formatDateWIB(m.timestamp);
    if (firstDateLabel === null) firstDateLabel = dateLabel;
    if (dateLabel && dateLabel !== lastDate) {
      fragment.appendChild(createDateDivider(dateLabel));
      lastDate = dateLabel;
    }
    fragment.appendChild(renderMessage(m, docSnap.id));
  });
  return { fragment, firstDateLabel, lastDateLabel: lastDate };
}

// Full-rebuild messagesLiveEl tanpa nge-block first paint (lihat catatan di
// INITIAL_VISIBLE_MESSAGES) -- pecah docs (ascending) jadi 2: "tail" (paling
// baru, INITIAL_VISIBLE_MESSAGES pesan) langsung dirender sinkron karena itu
// yang memang jadi fokus begitu chat dibuka, "head" (sisanya, lebih lama)
// dirender di frame browser berikutnya lalu ditempel di ATAS tanpa bikin
// scroll "loncat" (teknik sama seperti loadOlderMessages()). Sama persis
// dengan admin.js, disalin bukan di-share modul (lihat catatan di
// buildMessagesFragment() soal kenapa).
function renderMessagesProgressively(docs, precedingDateLabel) {
  const token = ++liveRenderToken;
  const targetLiveEl = messagesLiveEl;
  targetLiveEl.innerHTML = "";

  const hasHead = docs.length > INITIAL_VISIBLE_MESSAGES;
  const tailDocs = hasHead ? docs.slice(-INITIAL_VISIBLE_MESSAGES) : docs;
  const headDocs = hasHead ? docs.slice(0, docs.length - INITIAL_VISIBLE_MESSAGES) : [];

  const headLastDateLabel = headDocs.length
    ? formatDateWIB(headDocs[headDocs.length - 1].data().timestamp)
    : precedingDateLabel;
  const { fragment: tailFragment } = buildMessagesFragment(tailDocs, headLastDateLabel);
  targetLiveEl.appendChild(tailFragment);

  if (!hasHead) return;

  requestAnimationFrame(() => {
    if (token !== liveRenderToken || targetLiveEl !== messagesLiveEl) return;
    const { fragment: headFragment } = buildMessagesFragment(headDocs, precedingDateLabel);
    const prevScrollHeight = messagesEl.scrollHeight;
    const prevScrollTop = messagesEl.scrollTop;
    targetLiveEl.prepend(headFragment);
    messagesEl.scrollTop = messagesEl.scrollHeight - prevScrollHeight + prevScrollTop;
  });
}

// Tempel 1 bubble pesan baru di ujung bawah messagesLiveEl TANPA menyentuh
// bubble lain -- dipakai listenMessages() (lihat catatan di sana) supaya 1
// pesan baru masuk tidak memaksa SEMUA bubble di window (termasuk <img>
// base64 yang bisa ratusan KB tiap gambar) ke-decode ulang oleh browser.
// dataset.dateLabel (diisi renderMessage()) dipakai baca "tanggal terakhir
// yang lagi tampil" langsung dari DOM, tanpa perlu state terpisah. Sama
// persis dengan admin.js, disalin bukan di-share modul (lihat catatan di
// buildMessagesFragment() soal kenapa).
function appendLiveMessage(m, messageId) {
  const dateLabel = formatDateWIB(m.timestamp);
  const lastChild = messagesLiveEl.lastElementChild;
  const lastDateLabel = !lastChild
    ? null
    : lastChild.classList.contains("date-divider")
      ? lastChild.textContent
      : lastChild.dataset.dateLabel;
  if (dateLabel && dateLabel !== lastDateLabel) messagesLiveEl.appendChild(createDateDivider(dateLabel));
  messagesLiveEl.appendChild(renderMessage(m, messageId));
}

function renderMessage(m, messageId) {
  const div = document.createElement("div");
  div.className = "message " + (m.sender === "customer" ? "mine" : "theirs");
  div.dataset.messageId = messageId;
  div.dataset.dateLabel = formatDateWIB(m.timestamp);

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

// existingData (opsional): dokumen customers/{uid} yang sudah ada SEBELUM
// enterChat dipanggil. Dipakai buat memulihkan state anti-spam dari sesi
// sebelumnya supaya tetap berlaku walau halaman di-reload / ganti tab (bukan
// cuma variabel in-memory yang hilang):
//  - lockedUntil  -> masa kunci spam "pesan berulang" yang masih jalan
//  - repeatText/repeatCount/repeatWindowStart -> counter pesan-berulang, biar
//    customer tidak bisa nol-in counter dengan reload tiap 3-4 pesan sebelum
//    pesan ke-5 sempat menyalakan lock (lihat nextRepeatFields).
function enterChat(uid, name, existingData = null) {
  sessionActive = true;
  currentUser = { uid, name };
  loginScreen.classList.add("hidden");
  chatScreen.classList.remove("hidden");
  updateChatHeader();
  listenMessages();
  listenSessionAlive(uid);
  startPresenceHeartbeat();

  if (lastSeenIntervalId) clearInterval(lastSeenIntervalId);
  lastSeenIntervalId = setInterval(refreshLastSeen, LAST_SEEN_REFRESH_MS);

  if (existingData) {
    const winMs = existingData.repeatWindowStart ? existingData.repeatWindowStart.toMillis() : 0;
    if (winMs && Date.now() - winMs <= REPEAT_WINDOW_MS) {
      repeatText = existingData.repeatText || null;
      repeatCount = existingData.repeatCount || 0;
      repeatWindowStartMs = winMs;
    }

    const lockedUntilMs = existingData.lockedUntil ? existingData.lockedUntil.toMillis() : 0;
    if (lockedUntilMs > Date.now()) {
      spamLockedUntilMs = lockedUntilMs;
      triggerSpamLock(false);
    }
  }
}

// Kalau admin menghapus dokumen customers/{uid} ini (tombol "Hapus Semua
// Chat"), dokumennya lenyap dari Firestore -- listener di bawah nangkep itu
// realtime dan langsung mengunci sesi di sisi customer, bukan cuma pas
// reload halaman berikutnya.
function listenSessionAlive(uid) {
  if (unsubCustomerDoc) unsubCustomerDoc();
  unsubCustomerDoc = onSnapshot(doc(db, ...wsPath("customers", uid)), (snap) => {
    if (!snap.exists()) {
      handleSessionDeleted();
      return;
    }
    const data = snap.data();
    // Kalau lock spam "pesan berulang" dinyalakan dari tab / perangkat lain
    // (atau langsung server-side lewat customerNotRepeatSpamming), ikut kunci
    // form di tab ini juga -- jangan sampai satu tab masih bisa lanjut ngirim
    // padahal instance lain milik customer yang sama sudah kena.
    const lockedUntilMs = data.lockedUntil ? data.lockedUntil.toMillis() : 0;
    if (lockedUntilMs > Date.now() && lockedUntilMs > spamLockedUntilMs) {
      spamLockedUntilMs = lockedUntilMs;
      triggerSpamLock(false);
    }
    // Kalau admin meng-edit nama customer selagi sesi jalan, ikut update di
    // sini supaya currentUser.name (dipakai presencePayload dsb) tidak basi.
    const docName = data.name;
    if (docName && currentUser && docName !== currentUser.name) {
      currentUser.name = docName;
      if (rtdb) goOnlineRtdb();
    }
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
  if (lastSeenIntervalId) clearInterval(lastSeenIntervalId);
  unsubMessages = null;
  unsubCustomerDoc = null;
  presenceIntervalId = null;
  lastSeenIntervalId = null;

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

// Cuma dipakai buat payload ONLINE sekarang -- offline direpresentasikan
// dengan MENGHAPUS entrinya (lihat goOnlineRtdb/goOfflineRtdb di bawah),
// bukan nulis {online:false}. Sebelumnya tiap customer yang PERNAH mampir
// nyisain 1 entri permanen di presence/{workspaceId} (gak pernah dihapus,
// cuma ditandain false) -- makin lama makin numpuk (skala ~1500
// customer/hari, lihat memory 2026-08-09), dan listenPresence() admin.js
// nge-download ULANG SELURUH node itu tiap ada 1 perubahan APAPUN di
// dalamnya, jadi ini beban yang terus membesar seiring waktu, bukan cuma
// pas rame. isCustomerOnline() di admin.js sudah cukup treat "entri gak
// ada" sama dengan "offline" (presenceMap.get(uid) balik undefined), jadi
// aman dihapus total.
function presencePayload() {
  return { online: true, name: currentUser.name, lastActiveAt: rtdbServerTimestamp() };
}

function goOnlineRtdb() {
  if (!rtdb || !currentUser || !sessionActive) return;
  const presRef = rtdbPresenceRef(currentUser.uid);
  // Didaftarkan ulang tiap kali balik online -- RTDB otomatis membatalkan
  // onDisconnect lama begitu koneksi socket-nya putus, jadi ini aman
  // dipanggil berulang tanpa numpuk.
  onDisconnect(presRef).remove();
  rtdbSet(presRef, presencePayload()).catch(() => {});
}

function goOfflineRtdb() {
  if (!rtdb || !currentUser) return;
  rtdbRemove(rtdbPresenceRef(currentUser.uid)).catch(() => {});
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

  messagesEl.innerHTML = "";
  oldestLoadedMessageTimestamp = null;
  oldestRenderedDateLabel = null;
  olderBoundaryDateLabel = null;
  allOlderMessagesLoaded = false;
  loadingOlderMessages = false;
  forceScrollToBottomNext = false;

  // messagesOlderEl/messagesLiveEl pakai display:contents (lihat CSS) --
  // anak-anaknya tetap kena layout flex #messages persis kayak sebelum ada
  // wrapper ini, cuma buat batesin mana yang boleh disentuh
  // loadOlderMessages() vs listener live di bawah.
  messagesLoadingOlderEl = document.createElement("div");
  messagesLoadingOlderEl.className = "messages-loading-older hidden";
  messagesLoadingOlderEl.textContent = "Memuat pesan lama...";
  messagesOlderEl = document.createElement("div");
  messagesOlderEl.style.display = "contents";
  messagesLiveEl = document.createElement("div");
  messagesLiveEl.style.display = "contents";
  messagesEl.appendChild(messagesLoadingOlderEl);
  messagesEl.appendChild(messagesOlderEl);
  messagesEl.appendChild(messagesLiveEl);

  // Sama seperti admin.js: onSnapshot() di bawah baru dapat data pertama
  // setelah round-trip ke server -- tanpa placeholder ini #messages kosong
  // total selama itu (bukan cuma ikon 💬 punya .messages:empty, karena 3
  // wrapper di atas bikin elemen ini technically tidak :empty), kelihatan
  // kayak "chat-nya gelap dulu". Dibuang otomatis begitu snapshot pertama
  // datang.
  const messagesLoadingInitialEl = document.createElement("div");
  messagesLoadingInitialEl.className = "messages-loading-initial";
  messagesLoadingInitialEl.textContent = "Memuat percakapan...";
  messagesEl.appendChild(messagesLoadingInitialEl);

  // Cuma MESSAGES_PAGE_SIZE pesan terbaru yang live -- langganan lama
  // dengan ribuan pesan dulu di-load & di-render SEMUA sekaligus tiap
  // dibuka/refresh, makin lama makin berat. Pesan lebih lama dimuat sesuai
  // kebutuhan lewat loadOlderMessages() (dipicu scroll ke atas).
  const q = query(
    collection(db, ...wsPath("chats", currentUser.uid, "messages")),
    orderBy("timestamp", "desc"),
    limit(MESSAGES_PAGE_SIZE)
  );
  unsubMessages = onSnapshot(q, (snap) => {
    if (messagesLoadingInitialEl.isConnected) messagesLoadingInitialEl.remove();

    const docs = snap.docs.slice().reverse();
    const wasNearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
    const forceScrollToBottom = forceScrollToBottomNext;
    forceScrollToBottomNext = false;

    let latestAdminInfo = null;
    docs.forEach((docSnap) => {
      const m = docSnap.data();
      if (m.sender === "admin") latestAdminInfo = { name: m.senderName, photo: m.senderPhoto };
    });
    // Jarang, tapi mungkin: MESSAGES_PAGE_SIZE pesan terbaru semuanya dari customer sendiri
    // (belum dibalas admin sama sekali dalam rentang itu) -- coba cari lagi
    // di batch pesan lama yang sudah dimuat lewat loadOlderMessages(),
    // supaya header "sedang chat dengan siapa" tidak kosong tanpa alasan.
    if (!latestAdminInfo && knownAdminInfo) latestAdminInfo = knownAdminInfo;

    // Sama seperti admin.js: rebuild penuh tiap snapshot bikin lag di chat
    // dengan riwayat panjang & banyak gambar (semua <img> base64 ke-decode
    // ulang meski tidak berubah) -- tempel/copot 1 bubble saja buat kasus
    // paling umum (1 pesan baru, kadang dibarengi 1 pesan lama kegeser
    // keluar window). Selain itu (edit pesan, atau lagi baca histori lama)
    // tetap rebuild penuh.
    const changes = snap.docChanges();
    const removedChange = changes.find((c) => c.type === "removed");
    // "removed" bisa berarti pesan tertua kegeser keluar window (aman
    // dipatch) ATAU admin hapus 1 pesan di TENGAH riwayat dari sisi admin
    // (listener ini ikut kebagian event yang sama) -- kalau dipatch parsial
    // padahal bukan yang tertua, divider tanggal bisa jadi yatim di tengah
    // list. Aman cuma kalau bubble yang kehapus itu pesan tertua yang lagi
    // tampil (elemen pertama, atau tepat sesudah divider tanggal).
    const removedEl = removedChange
      ? messagesLiveEl.querySelector(`[data-message-id="${CSS.escape(removedChange.doc.id)}"]`)
      : null;
    const removedIsOldest =
      !removedChange ||
      !removedEl ||
      messagesLiveEl.firstElementChild === removedEl ||
      (messagesLiveEl.firstElementChild &&
        messagesLiveEl.firstElementChild.classList.contains("date-divider") &&
        messagesLiveEl.firstElementChild.nextElementSibling === removedEl);
    const canPatchIncrementally =
      messagesLiveEl.childElementCount > 0 &&
      messagesOlderEl.childElementCount === 0 &&
      changes.length > 0 &&
      changes.every((c) => c.type === "added" || c.type === "removed") &&
      changes.filter((c) => c.type === "added").length <= 1 &&
      changes.filter((c) => c.type === "removed").length <= 1 &&
      removedIsOldest;

    if (canPatchIncrementally) {
      const prevOldestRenderedDateLabel = oldestRenderedDateLabel;
      if (removedEl) removedEl.remove();
      changes
        .filter((c) => c.type === "added")
        .forEach((c) => appendLiveMessage(c.doc.data(), c.doc.id));

      const newOldestDateLabel = docs.length > 0 ? formatDateWIB(docs[0].data().timestamp) : null;
      if (
        messagesLiveEl.firstElementChild &&
        messagesLiveEl.firstElementChild.classList.contains("date-divider") &&
        messagesLiveEl.firstElementChild.textContent === prevOldestRenderedDateLabel &&
        prevOldestRenderedDateLabel !== newOldestDateLabel
      ) {
        messagesLiveEl.firstElementChild.remove();
      }
    } else {
      renderMessagesProgressively(docs, olderBoundaryDateLabel);
    }

    if (docs.length > 0) {
      oldestLoadedMessageTimestamp = docs[0].data().timestamp;
      if (!messagesOlderEl.firstElementChild) oldestRenderedDateLabel = formatDateWIB(docs[0].data().timestamp);
    }
    if (docs.length < MESSAGES_PAGE_SIZE) allOlderMessagesLoaded = true;

    if (latestAdminInfo) {
      knownAdminInfo = latestAdminInfo;
      updateChatHeader();
    }
    // Nempel ke bawah kalau customer memang lagi di dekat bawah (jangan
    // diseret paksa tiap pesan ADMIN baru masuk kalau lagi scroll ke atas
    // baca histori lama) -- ATAU kalau ini pesan sendiri yang baru saja
    // dikirim (forceScrollToBottom), pesannya sendiri harus tetap kelihatan
    // biarpun posisi scroll lagi jauh dari bawah.
    if (wasNearBottom || forceScrollToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

// Dipicu scroll ke atas (lihat listener di bawah) -- ambil MESSAGES_PAGE_SIZE
// pesan berikutnya yang lebih lama dari oldestLoadedMessageTimestamp, sekali
// baca (bukan listener live -- pesan lama jarang berubah) lalu ditempel di
// ATAS tanpa bikin scroll "loncat". Sama persis dengan versi admin.js.
async function loadOlderMessages() {
  if (loadingOlderMessages || allOlderMessagesLoaded || !oldestLoadedMessageTimestamp || !currentUser) return;
  const uid = currentUser.uid;
  loadingOlderMessages = true;
  messagesLoadingOlderEl.classList.remove("hidden");
  try {
    const q = query(
      collection(db, ...wsPath("chats", uid, "messages")),
      orderBy("timestamp", "desc"),
      startAfter(oldestLoadedMessageTimestamp),
      limit(MESSAGES_PAGE_SIZE)
    );
    const snap = await getDocs(q);
    if (!currentUser || uid !== currentUser.uid) return; // sesi sudah ganti selagi nunggu

    if (snap.empty) {
      allOlderMessagesLoaded = true;
      return;
    }

    const docs = snap.docs.slice().reverse();
    const lastBatchDateLabel = formatDateWIB(docs[docs.length - 1].data().timestamp);

    // Kalau tanggal pesan TERBARU di batch ini sama dengan divider paling
    // atas yang lagi tampil, divider lama itu jadi dobel -- buang.
    if (oldestRenderedDateLabel && lastBatchDateLabel === oldestRenderedDateLabel) {
      const firstChild = messagesOlderEl.firstElementChild || messagesLiveEl.firstElementChild;
      if (firstChild && firstChild.classList.contains("date-divider")) firstChild.remove();
    }

    const { fragment, firstDateLabel } = buildMessagesFragment(docs, null);
    const prevScrollHeight = messagesEl.scrollHeight;
    const prevScrollTop = messagesEl.scrollTop;
    messagesOlderEl.prepend(fragment);
    messagesEl.scrollTop = messagesEl.scrollHeight - prevScrollHeight + prevScrollTop;

    oldestLoadedMessageTimestamp = docs[0].data().timestamp;
    oldestRenderedDateLabel = firstDateLabel;
    if (olderBoundaryDateLabel === null) olderBoundaryDateLabel = lastBatchDateLabel;
    if (docs.length < MESSAGES_PAGE_SIZE) allOlderMessagesLoaded = true;
  } catch (err) {
    console.error("Gagal memuat pesan lama:", err);
  } finally {
    loadingOlderMessages = false;
    messagesLoadingOlderEl.classList.add("hidden");
  }
}

messagesEl.addEventListener("scroll", () => {
  if (messagesEl.scrollTop < 60) loadOlderMessages();
});

// Anti-spam ringan gaya WhatsApp (lihat penjelasan lengkap di firestore.rules
// customerNotSpamming()): yang dibatasi cuma LEDAKAN (>=5 pesan customer
// dalam 3 detik), bukan jeda kaku antar-pesan. Dilacak di memory (bukan baca
// balik dokumen Firestore tiap kirim) karena instance ini satu-satunya yang
// nulis field ini buat customer yang bersangkutan dalam sesi ybs.
const BURST_WINDOW_MS = 3000;
let burstWindowStartMs = 0;
let burstCount = 0;

function nextBurstFields() {
  const now = Date.now();
  const isNewWindow = now - burstWindowStartMs > BURST_WINDOW_MS;
  if (isNewWindow) {
    burstWindowStartMs = now;
    burstCount = 1;
    return { burstWindowStart: serverTimestamp(), burstCount: 1 };
  }
  burstCount++;
  return { burstCount };
}

// Anti-spam tambahan: customer yang kirim 5 pesan PERSIS SAMA dalam 10 detik
// dianggap spam (bukan sekadar ledakan pesan apa pun kayak burst di atas) --
// sesi langsung dikunci REPEAT_LOCKOUT_MS dan customer tidak bisa kirim apa-apa
// sampai masa kunci itu habis (lihat triggerSpamLock). Sama seperti burst,
// dilacak in-memory karena instance ini satu-satunya penulis field ini buat
// customer ybs dalam sesi ini. lockedUntil ditulis sebagai Timestamp beneran
// (bukan serverTimestamp() sentinel) supaya bisa dipakai perbandingan
// request.time > lockedUntil di firestore.rules.
const REPEAT_LIMIT = 5;
const REPEAT_WINDOW_MS = 10000;
const SPAM_LOCKOUT_MS = 5 * 60 * 1000;
let repeatText = null;
let repeatWindowStartMs = 0;
let repeatCount = 0;
let spamLockedUntilMs = 0;

// Kunci "lagi mengirim" -- pesan customer dikirim satu per satu. Tanpa ini,
// Enter yang ditahan / submit beruntun / klik ganda bikin beberapa
// sendTextMessage() jalan PARALEL: semuanya lolos guard spamLockedUntilMs
// secara sinkron SEBELUM pesan ke-5 sempat menyalakan lock, jadi 10+ pesan
// sama bisa tembus sebelum sesi kekunci. Dengan serialisasi ini, counter
// pesan-berulang naik urut dan lock nyala tepat waktu.
let sendInFlight = false;

function nextRepeatFields(text) {
  const now = Date.now();
  // Ambang 10 detik dihitung dari pesan SAMA yang TERAKHIR, bukan yang
  // pertama -- dulu repeatWindowStartMs cuma di-set pas ganti teks, jadi
  // customer yang nge-drip pesan sama tiap ~9 detik tidak pernah kena
  // (pesan ke-2 sudah lewat 10 detik dari pesan ke-1 -> counter reset).
  const isSameRepeat = text === repeatText && now - repeatWindowStartMs <= REPEAT_WINDOW_MS;
  if (isSameRepeat) {
    repeatCount++;
  } else {
    repeatText = text;
    repeatCount = 1;
  }
  repeatWindowStartMs = now;

  // repeatText/repeatCount/repeatWindowStart ikut ditulis ke dokumen customer
  // (dulu cuma in-memory) supaya rule customerNotRepeatSpamming di
  // firestore.rules bisa menegakkan batas ini server-side. repeatCount dinaikin
  // pakai increment() pas teksnya sama beruntun -- jadi customer yang reload
  // halaman / buka tab kedua buat nol-in counter in-memory tetap ke-hitung di
  // server dan pesan ke-6 yang persis sama (dalam 10 detik) ditolak. Pas teks
  // berubah / window kedaluwarsa, di-set absolut ke 1.
  const repeatFields = isSameRepeat
    ? { repeatText: text, repeatCount: increment(1), repeatWindowStart: serverTimestamp() }
    : { repeatText: text, repeatCount: 1, repeatWindowStart: serverTimestamp() };

  if (repeatCount >= REPEAT_LIMIT) {
    spamLockedUntilMs = now + SPAM_LOCKOUT_MS;
    repeatText = null;
    repeatCount = 0;
    return { ...repeatFields, lockedUntil: Timestamp.fromMillis(spamLockedUntilMs) };
  }
  return repeatFields;
}

let spamLockIntervalId = null;

function updateSpamLockCountdown() {
  const remainingMs = spamLockedUntilMs - Date.now();
  if (remainingMs <= 0) {
    clearInterval(spamLockIntervalId);
    spamLockIntervalId = null;
    spamLockedUntilMs = 0;
    messageInput.disabled = false;
    imageInput.disabled = false;
    messageInput.placeholder = DEFAULT_MESSAGE_PLACEHOLDER;
    messageForm.classList.remove("locked");
    spamLockBanner.classList.add("hidden");
    return;
  }
  const remainingSec = Math.ceil(remainingMs / 1000);
  const mm = Math.floor(remainingSec / 60);
  const ss = String(remainingSec % 60).padStart(2, "0");
  const countdownText = `${mm}:${ss}`;
  spamLockBanner.textContent = `⏳ Chat dikunci sementara karena pesan berulang (spam). Anda bisa chat lagi dalam ${countdownText}.`;
  messageInput.placeholder = `Terkunci -- coba lagi dalam ${countdownText}`;
}

// Dipanggil begitu terdeteksi 5 pesan sama beruntun (lihat nextRepeatFields),
// dan juga dipanggil ulang di enterChat() kalau customer reload halaman
// selagi masih dalam masa kunci. Beda dari handleSessionDeleted (yang
// permanen sampai tab ditutup ulang), ini otomatis lepas sendiri begitu
// SPAM_LOCKOUT_MS habis -- form TIDAK sampai disembunyikan/reset, cuma
// dikunci sementara.
//
// isFreshTrigger cuma true kalau kunci ini BARU KEJADIAN dari aksi customer
// barusan (bukan hasil restore lockedUntil pas reload halaman) -- dipakai
// buat nembak alert() SEKALI biar customer yang gak merhatiin banner/kolom
// chat yang keredupkan tetap pasti dapat keterangan jelas kenapa tiba-tiba
// gak bisa ngirim, tanpa ngulang alert itu tiap kali dia reload selagi masih
// dikunci.
function triggerSpamLock(isFreshTrigger) {
  messageInput.disabled = true;
  imageInput.disabled = true;
  messageForm.classList.add("locked");
  spamLockBanner.classList.remove("hidden");
  updateSpamLockCountdown();
  if (spamLockIntervalId) clearInterval(spamLockIntervalId);
  spamLockIntervalId = setInterval(updateSpamLockCountdown, 1000);
  if (isFreshTrigger) {
    alert(
      "Anda mengirim pesan yang sama 5x berturut-turut dalam waktu singkat. " +
      "Untuk mencegah spam, kolom chat dikunci sementara selama 5 menit."
    );
  }
}

// repeatFields dihitung pemanggil (nextRepeatFields) dan cuma diisi buat
// pesan TEKS -- kiriman gambar lewat sini dengan lastMessage "📷 Gambar" yang
// selalu identik, jadi kalau ikut dihitung, customer yang kirim 5 foto
// (mis. foto produk/struk) kena kunci "pesan berulang" 5 menit padahal
// gambarnya beda-beda. Burst limit (5 pesan/3 detik) tetap berlaku buat
// gambar lewat nextBurstFields().
async function touchCustomerDoc(lastMessage, repeatFields = {}) {
  await setDoc(
    doc(db, ...wsPath("customers", currentUser.uid)),
    {
      // `name` SENGAJA tidak ditulis di sini. Dokumen customer selalu sudah
      // punya nama sebelum pesan pertama bisa dikirim (diisi startChat /
      // auto-rejoin), dan menulisnya ulang tiap pesan bikin edit nama dari
      // sisi admin ke-timpa balik ke nama lama yang diketik customer tiap
      // kali customer lanjut chat -- persis keluhan "nama balik lagi".
      lastMessage,
      lastMessageAt: serverTimestamp(),
      lastSender: "customer",
      unreadCount: increment(1),
      archived: false,
      archivedAt: null,
      expireAt: null,
      typingDraft: null,
      ...nextBurstFields(),
      ...repeatFields
    },
    { merge: true }
  );
  if (spamLockedUntilMs > Date.now()) triggerSpamLock(true);
}

const SEARCH_TEXT_MAX_ENTRIES = 200;

// Dibatasi ke entri terbaru (bukan arrayUnion tanpa batas) supaya chat yang
// berumur panjang (bulanan) tidak bikin field searchText tumbuh tanpa henti
// -- lihat catatan sama di admin.js (indexSearchText).
async function indexSearchText(text) {
  if (!text || !currentUser) return;
  const customerRef = doc(db, ...wsPath("customers", currentUser.uid));
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(customerRef);
      const existing = Array.isArray(snap.data()?.searchText) ? snap.data().searchText : [];
      const next = [...existing, text].slice(-SEARCH_TEXT_MAX_ENTRIES);
      tx.set(customerRef, { searchText: next }, { merge: true });
    });
  } catch (err) {
    // Best-effort, sama seperti sebelumnya (arrayUnion + .catch(() => {})).
  }
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
  if (!text || !currentUser || !sessionActive || spamLockedUntilMs > Date.now()) return;
  if (sendInFlight) return;
  sendInFlight = true;

  try {
    try {
      forceScrollToBottomNext = true;
      await writeMessage(currentUser.uid, {
        sender: "customer",
        type: "text",
        text,
        timestamp: serverTimestamp()
      });
    } catch (err) {
      forceScrollToBottomNext = false;
      console.error("Gagal addDoc ke chats/" + currentUser.uid + "/messages:", err);
      alert("Gagal mengirim pesan (tulis chat): " + err.code + " - " + err.message);
      return;
    }

    try {
      await touchCustomerDoc(text, nextRepeatFields(text));
    } catch (err) {
      console.error("Gagal setDoc ke customers/" + currentUser.uid + ":", err);
      alert("Gagal mengirim pesan (update profil customer): " + err.code + " - " + err.message);
      return;
    }

    bumpStat("messageCount");
    bumpStat("customerMessageCount");
  } finally {
    sendInFlight = false;
  }
}

// Customer cuma boleh pakai tombol pilihan bantuan maksimal 2x per sesi chat
// (supaya tidak dipakai spam auto-reply berulang-ulang) -- dihitung dari
// field optionSelectCount di dokumen customers/{uid}, jadi batasnya tetap
// berlaku walau halaman di-reload, bukan cuma variabel in-memory.
const OPTION_SELECT_LIMIT = 2;
let optionSelectCount = 0;

// Kalau customer sempat TIDAK aktif minimal 2 jam sebelum balik lagi (tutup
// tab/reload lama kemudian), dianggap "sesi baru" khusus buat menu bantuan
// ini: optionSelectCount di-reset ke 0 dan pesan menu pilihan dikirim ulang
// (lihat sendAutoGreetingOptions) -- TIDAK menghapus riwayat chat, nama,
// atau apa pun lain, cuma limit menu bantuannya saja. lastSeenAt yang belum
// pernah ada sama sekali (customer lama dari sebelum fitur ini di-deploy)
// sengaja TIDAK dianggap sebagai gap -- baru mulai dilacak dari kunjungan
// ini, biar tidak tiba-tiba nge-blast ulang menu ke semua customer existing
// begitu fitur ini baru rilis.
const SESSION_GAP_MS = 2 * 60 * 60 * 1000; // 2 jam
let lastSeenIntervalId = null;

function sessionShouldReset(data) {
  if (!data || !data.lastSeenAt) return false;
  return Date.now() - data.lastSeenAt.toMillis() >= SESSION_GAP_MS;
}

// Kirim ulang pesan "menu pilihan" (sama persis bentuknya dengan yang
// dikirim auto-rejoin/mulai chat pertama kali) -- dipanggil baik dari
// isNewCustomer (sapaan pertama) maupun dari reset gap 2 jam di atas.
function sendAutoGreetingOptions(uid) {
  if (!autoGreetingEnabled || autoGreetingOptions.length === 0) return;
  // Jeda singkat (kesan "bot lagi ngetik"), sama seperti sapaan pertama --
  // supaya tidak numpuk pesan dalam 1 detik yang sama.
  setTimeout(() => {
    writeMessage(uid, {
      sender: "admin",
      type: "options",
      options: autoGreetingOptions,
      timestamp: serverTimestamp(),
      autoGreeting: true
    }).catch(() => {});
  }, 900);
}

// lastSeenAt cuma ditulis ulang pas sesi mulai/rejoin DAN berkala tiap
// LAST_SEEN_REFRESH_MS selama tab tetap aktif -- kalau cuma ditulis pas
// mulai sesi, customer yang buka tab terus-menerus selama berjam-jam lalu
// nutup sebentar akan salah kena reset (gap dihitung dari waktu MULAI sesi,
// bukan waktu TERAKHIR beneran aktif). 10 menit dipilih karena longgar buat
// ambang 2 jam di atas (meleset maksimal ~10 menit dari batas sebenarnya
// masih wajar), sambil tetap jauh lebih murah dari heartbeat Firestore lama
// yang tiap 10-30 detik (lihat catatan PRESENCE_HEARTBEAT_MS).
const LAST_SEEN_REFRESH_MS = 10 * 60 * 1000;

function refreshLastSeen() {
  if (!currentUser || !sessionActive) return;
  setDoc(
    doc(db, ...wsPath("customers", currentUser.uid)),
    { lastSeenAt: serverTimestamp() },
    { merge: true }
  ).catch(() => {});
}

// Diklik dari tombol pilihan bantuan (lihat renderMessage type "options").
// Kirim pilihannya sebagai pesan customer biasa dulu, lalu kalau admin sudah
// nyetel balasan otomatis buat pilihan itu (Pengaturan > Auto-Chat), susulkan
// balasannya dengan jeda singkat.
async function selectOption(opt) {
  if (!currentUser || !sessionActive || optionSelectCount >= OPTION_SELECT_LIMIT || spamLockedUntilMs > Date.now()) return;

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
  // Kalau masih ada kiriman jalan, JANGAN kosongkan input -- biarkan teksnya
  // tetap di kolom biar customer tinggal Enter lagi, bukan hilang begitu saja
  // (submit beruntun selagi sendTextMessage() belum kelar).
  if (sendInFlight) return;
  messageInput.value = "";
  await sendTextMessage(text);
});

// Dipakai baik oleh input file (klik ikon 🖼️) maupun paste screenshot
// (Ctrl+V) langsung di kolom pesan -- lihat listener "paste" di bawah.
async function sendImageFile(file) {
  if (!file || !currentUser || !sessionActive || spamLockedUntilMs > Date.now()) return;

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
    forceScrollToBottomNext = true;
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
    forceScrollToBottomNext = false;
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
    const [user] = await Promise.all([ensureSignedIn(), resolveWorkspaceIdOnce()]);
    // Dipakai ulang dari init() (lihat initialCustomerSnap) kalau ada --
    // fallback getDoc cuma buat jaga-jaga kalau entah kenapa belum keisi.
    const existingSnap = initialCustomerSnap || (await getDoc(doc(db, ...wsPath("customers", user.uid))));
    const isNewCustomer = !existingSnap.exists();
    const existingData = isNewCustomer ? null : existingSnap.data();
    const sessionReset = !isNewCustomer && sessionShouldReset(existingData);
    optionSelectCount = isNewCustomer || sessionReset ? 0 : existingData.optionSelectCount || 0;

    const initialUpdate = {
      lastSeenAt: serverTimestamp()
    };
    // Nama cuma ditulis buat customer baru (atau dokumen lama yang entah
    // kenapa belum punya nama). Buat customer lama yang namanya sudah ada,
    // JANGAN di-timpa nama yang baru diketik di form -- kalau admin sempat
    // meng-edit namanya, ketikan customer di sini (mis. reload lalu "Masuk"
    // lagi) akan mengembalikannya ke nama lama.
    if (isNewCustomer || !existingData?.name) initialUpdate.name = name;
    // Cuma diinisialisasi kosong buat customer BARU -- dulu 3 field ini
    // ditulis tanpa syarat di sini, jadi kalau customer LAMA sempat
    // nyampe form ini (race: loadInitialDataInBackground() punya
    // auto-rejoin sendiri yang jalan di background, tapi kalau customer
    // ngetik nama & klik "Masuk" duluan sebelum auto-rejoin itu selesai,
    // form ini yang kepanggil) -- lastMessage/lastSender ke-timpa jadi
    // kosong/null dan lastMessageAt ke-refresh ke waktu SEKARANG, padahal
    // history chat aslinya (subkoleksi messages) sama sekali gak berubah.
    // Efeknya: sidebar admin nunjukin baris "kosong" dengan jam terbaru
    // buat customer yang sebenarnya udah lama chat.
    if (isNewCustomer) {
      initialUpdate.lastMessage = "";
      initialUpdate.lastMessageAt = serverTimestamp();
      initialUpdate.lastSender = null;
    }
    if (sessionReset) initialUpdate.optionSelectCount = 0;
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
    // Nama yang dipakai sesi = nama tersimpan (bisa jadi sudah di-edit admin)
    // kalau customer lama, bukan yang baru diketik di form.
    enterChat(user.uid, existingData?.name || name, existingData || null);
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

      sendAutoGreetingOptions(user.uid);
    }
    if (sessionReset) sendAutoGreetingOptions(user.uid);
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

// Dua alur ini ditembak BERSAMAAN, bukan satu sesudah yang lain -- tapi
// keduanya tetap menunggu resolveWorkspaceIdOnce() lebih dulu sebelum
// membangun wsPath() (lihat catatan di situ):
// - Branding (dokumen workspace) diambil lewat REST langsung
//   (resolveWorkspaceDataFast), gak lewat SDK -- lihat catatan panjang di
//   situ soal kenapa. onBrandingSettled dipanggil begitu ini selesai
//   (berhasil ATAU akhirnya menyerah) -- dipakai init() buat nunggu
//   branding asli (kalau sempat) sebelum form ditampilkan, lihat GRACE_MS
//   di sana.
// - Auto-rejoin BUTUH uid (hasil sign-in lewat SDK) buat tahu dokumen
//   customer mana yang harus dicek, jadi tetap lewat jalur SDK+App Check
//   biasa, ditembak paralel sama sign-in -- tapi ini gak lagi menahan
//   branding supaya nongol bareng.
function loadInitialDataInBackground(onBrandingSettled) {
  const workspaceResolved = resolveWorkspaceIdOnce();

  workspaceResolved.finally(() => {
    if (onBrandingSettled) onBrandingSettled();
  });

  withRetries(async () => {
    const [user] = await Promise.all([ensureSignedIn(), workspaceResolved]);
    const customerSnap = await getDoc(doc(db, ...wsPath("customers", user.uid)));
    initialCustomerSnap = customerSnap;
    // Auto rejoin kalau browser ini sudah pernah chat sebelumnya -- TAPI
    // cuma kalau customer belum keburu mulai sesi baru sendiri lewat form
    // yang sudah kelihatan duluan (lihat sessionActive di enterChat()).
    // Kalau sudah, jangan diapa-apain lagi di sini -- sesi yang lagi
    // jalan itu yang menang, bukan hasil auto-rejoin yang telat datang.
    if (!sessionActive && customerSnap.exists() && customerSnap.data().name) {
      const data = customerSnap.data();
      const sessionReset = sessionShouldReset(data);
      optionSelectCount = sessionReset ? 0 : data.optionSelectCount || 0;
      enterChat(user.uid, data.name, data);
      captureVisitorInfo(user.uid);

      const seenUpdate = { lastSeenAt: serverTimestamp() };
      if (sessionReset) seenUpdate.optionSelectCount = 0;
      setDoc(doc(db, ...wsPath("customers", user.uid)), seenUpdate, { merge: true }).catch(() => {});

      if (sessionReset) sendAutoGreetingOptions(user.uid);
    }
  });
}

// Meta viewport (maximum-scale/user-scalable) sering diabaikan Safari iOS
// & sebagian browser Android demi aksesibilitas, jadi pinch-zoom & double-tap
// zoom perlu diblok manual di sini biar layout chat tidak bisa "diperkecil".
function preventZoomGestures() {
  document.addEventListener("touchmove", (e) => {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });

  document.addEventListener("gesturestart", (e) => e.preventDefault());

  let lastTouchEnd = 0;
  document.addEventListener("touchend", (e) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });
}
preventZoomGestures();

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

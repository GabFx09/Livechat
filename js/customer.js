import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore,
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
import { firebaseConfig } from "./firebase-config.js";
import { compressImageFile, showImageLightbox } from "./image-utils.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Terima workspace ID dari query string (?w=ID) ATAU dari URL bersih
// (/Livechat/ID/, dilayani lewat trik 404.html karena GitHub Pages tidak
// mendukung URL dinamis native). Query string diprioritaskan kalau ada.
function extractWorkspaceIdFromPath() {
  const segments = window.location.pathname.split("/").filter(Boolean);
  const BASE_SEGMENTS = 1; // situs ini di-host di /Livechat/, 1 segmen dasar
  if (segments.length <= BASE_SEGMENTS) return null;
  const last = segments[segments.length - 1];
  if (last === "index.html" || last === "404.html") return null;
  return last;
}

const workspaceId =
  new URLSearchParams(window.location.search).get("w") || extractWorkspaceIdFromPath();

let currentUser = null; // { uid, name }
let workspaceBrandName = null;
let autoGreetingEnabled = false;
let autoGreetingMessage = "";
let autoGreetingOptions = [];
let sessionActive = false; // false = belum chat, atau sesi dihapus admin & belum mulai ulang
let unsubMessages = null;
let unsubCustomerDoc = null;
let presenceIntervalId = null;

const loadingScreen = document.getElementById("loading-screen");
const workspaceErrorScreen = document.getElementById("workspace-error-screen");
const loginScreen = document.getElementById("login-screen");
const chatScreen = document.getElementById("chat-screen");
const nameInput = document.getElementById("name-input");
const startBtn = document.getElementById("start-btn");
const startError = document.getElementById("start-error");
const chatHeader = document.getElementById("chat-header");
const messagesEl = document.getElementById("messages");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const imageInput = document.getElementById("image-input");
const sessionEndedBanner = document.getElementById("session-ended-banner");
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

function applyThemeColor(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  document.documentElement.style.setProperty("--accent", hex);
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

    const optWrap = document.createElement("div");
    optWrap.className = "option-buttons";
    m.options.forEach((opt) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "option-btn";
      btn.textContent = opt;
      btn.addEventListener("click", () => sendTextMessage(opt));
      optWrap.appendChild(btn);
    });
    div.appendChild(optWrap);
  } else {
    const p = document.createElement("p");
    p.textContent = m.text || "";
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

// Kirim lastActiveAt tiap 10 detik selagi tab chat ini sedang aktif/terlihat,
// dipakai admin utk menandai customer online/offline di admin.js (lihat
// isCustomerOnline). Tidak dikirim saat tab di-background supaya statusnya
// jujur mencerminkan customer masih benar-benar di halaman chat.
const PRESENCE_HEARTBEAT_MS = 10000;
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
    sendHeartbeat();
  } else {
    sendOfflineSignal();
  }
});
window.addEventListener("pagehide", sendOfflineSignal);

function startPresenceHeartbeat() {
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

async function touchCustomerDoc(lastMessage, searchableText) {
  const update = {
    name: currentUser.name,
    lastMessage,
    lastMessageAt: serverTimestamp(),
    lastSender: "customer",
    unreadCount: increment(1),
    archived: false,
    archivedAt: null,
    expireAt: null,
    typingDraft: null
  };
  if (searchableText) {
    update.searchText = arrayUnion(searchableText);
  }
  await setDoc(doc(db, ...wsPath("customers", currentUser.uid)), update, { merge: true });
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
    await addDoc(collection(db, ...wsPath("chats", currentUser.uid, "messages")), {
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
    await touchCustomerDoc(text, text);
  } catch (err) {
    console.error("Gagal setDoc ke customers/" + currentUser.uid + ":", err);
    alert("Gagal mengirim pesan (update profil customer): " + err.code + " - " + err.message);
    return;
  }

  bumpStat("messageCount");
  bumpStat("customerMessageCount");
}

messageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  messageInput.value = "";
  await sendTextMessage(text);
});

imageInput.addEventListener("change", async () => {
  const file = imageInput.files[0];
  imageInput.value = "";
  if (!file || !currentUser || !sessionActive) return;

  try {
    const dataUrl = await compressImageFile(file, { maxDimension: 1200, maxDataUrlLength: 700000 });
    await addDoc(collection(db, ...wsPath("chats", currentUser.uid, "messages")), {
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
});

startBtn.addEventListener("click", async () => {
  const name = nameInput.value.trim();
  if (!name) {
    showStartError("Username tidak boleh kosong.");
    return;
  }

  startBtn.disabled = true;
  startError.classList.add("hidden");

  try {
    const user = await ensureSignedIn();
    const existingSnap = await getDoc(doc(db, ...wsPath("customers", user.uid)));
    const isNewCustomer = !existingSnap.exists();

    await setDoc(
      doc(db, ...wsPath("customers", user.uid)),
      {
        name,
        lastMessage: "",
        lastMessageAt: serverTimestamp(),
        lastSender: null
      },
      { merge: true }
    );
    if (isNewCustomer) bumpStat("newCustomers");
    enterChat(user.uid, name);
    captureVisitorInfo(user.uid);

    if (isNewCustomer && autoGreetingEnabled) {
      if (autoGreetingMessage) {
        addDoc(collection(db, ...wsPath("chats", user.uid, "messages")), {
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
          addDoc(collection(db, ...wsPath("chats", user.uid, "messages")), {
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

async function init() {
  if (!workspaceId) {
    loadingScreen.classList.add("hidden");
    workspaceErrorScreen.classList.remove("hidden");
    return;
  }

  try {
    const user = await ensureSignedIn();
    const wsSnap = await getDoc(doc(db, ...wsPath()));
    if (wsSnap.exists()) {
      const wsData = wsSnap.data();
      if (wsData.brandName) applyBrandName(wsData.brandName);
      if (wsData.themeColor) applyThemeColor(wsData.themeColor);
      autoGreetingEnabled = !!wsData.autoGreetingEnabled;
      autoGreetingMessage = wsData.autoGreetingMessage || "";
      autoGreetingOptions = Array.isArray(wsData.autoGreetingOptions) ? wsData.autoGreetingOptions : [];
    }

    // Auto rejoin kalau browser ini sudah pernah chat sebelumnya.
    const customerSnap = await getDoc(doc(db, ...wsPath("customers", user.uid)));
    if (customerSnap.exists() && customerSnap.data().name) {
      enterChat(user.uid, customerSnap.data().name);
      captureVisitorInfo(user.uid);
    } else {
      loginScreen.classList.remove("hidden");
    }
  } catch (err) {
    console.error("Gagal memuat workspace:", err);
    loginScreen.classList.remove("hidden");
  } finally {
    loadingScreen.classList.add("hidden");
  }
}

init();

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  initializeFirestore,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  addDoc,
  serverTimestamp,
  arrayUnion,
  increment,
  where,
  documentId
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import {
  initializeAppCheck,
  ReCaptchaV3Provider
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app-check.js";
import { firebaseConfig, RECAPTCHA_V3_SITE_KEY } from "./firebase-config.js";
import {
  compressImageFile,
  compressImageOrPassthroughGif,
  showImageLightbox,
  showImageSendConfirm
} from "./image-utils.js";
import { renderTextWithLinks } from "./text-utils.js";
import { parseAutochatOptions, formatAutochatOptionsForTextarea } from "./autochat-utils.js";
import { formatDurationShort } from "./format-utils.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Lihat catatan di customer.js: hindari koneksi streaming Firestore yang
// bisa diblokir diam-diam di beberapa jaringan.
const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });

if (RECAPTCHA_V3_SITE_KEY && !RECAPTCHA_V3_SITE_KEY.startsWith("PASTE_")) {
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(RECAPTCHA_V3_SITE_KEY),
    isTokenAutoRefreshEnabled: true
  });
} else {
  console.warn("Firebase App Check belum di-setup (RECAPTCHA_V3_SITE_KEY masih placeholder). Lihat README.md.");
}

let currentAdmin = null; // { uid, email, name, photo, workspaceId, workspaceName }
let activeCustomerUid = null;
let activeCustomerName = "";
let unsubMessages = null;
let lastKnownTimestamps = new Map();
let customersInitialLoadDone = false;
let customersDataMap = new Map();
let currentListView = "active"; // "active" (Open) | "all" | "archived"
let searchQuery = "";
let autoArchiveIntervalId = null;
let presenceIntervalId = null;

const AUTO_ARCHIVE_MS = 30 * 60 * 1000; // 30 menit tanpa pesan baru -> otomatis diarsipkan

// Customer dianggap online kalau lastActiveAt (heartbeat dari widget/customer.js
// tiap 30 detik selagi tab-nya aktif) masih dalam 70 detik terakhir (2x
// interval heartbeat + jeda jaringan). Ini cuma fallback (koneksi putus/tab
// crash) -- kasus normal (tab ditutup/dipindah) sudah langsung ketahuan
// offline lewat sendOfflineSignal() di customer.js.
const PRESENCE_ONLINE_MS = 70 * 1000;

function isCustomerOnline(data) {
  if (!data || !data.lastActiveAt) return false;
  return Date.now() - data.lastActiveAt.toMillis() < PRESENCE_ONLINE_MS;
}

function wsPath(...segments) {
  return ["workspaces", currentAdmin.workspaceId, ...segments];
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

function dateKeyDaysAgoWIB(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function bumpStat(field) {
  setDoc(doc(db, ...wsPath("stats", todayKeyWIB())), { [field]: increment(1) }, { merge: true }).catch(() => {});
}

function bumpStatBy(field, amount) {
  setDoc(doc(db, ...wsPath("stats", todayKeyWIB())), { [field]: increment(amount) }, { merge: true }).catch(() => {});
}

// Dipanggil tiap admin kirim balasan. Kalau ini balasan PERTAMA buat
// percakapan ybs (customer doc belum punya firstResponseAt, tapi sudah
// punya firstCustomerMessageAt dari sesi customer.js), catat selisih
// waktunya ke stats harian buat kartu "Respon Pertama" di dashboard.
function recordFirstResponseIfNeeded(uid) {
  const data = customersDataMap.get(uid);
  if (!data || !data.firstCustomerMessageAt || data.firstResponseAt) return;
  const deltaMs = Date.now() - data.firstCustomerMessageAt.toMillis();
  if (deltaMs < 0) return;
  setDoc(doc(db, ...wsPath("customers", uid)), { firstResponseAt: serverTimestamp() }, { merge: true }).catch(() => {});
  bumpStatBy("firstResponseTotalMs", deltaMs);
  bumpStat("firstResponseCount");
}

const loadingScreen = document.getElementById("loading-screen");
const loginScreen = document.getElementById("login-screen");
const appScreen = document.getElementById("app-screen");
const emailInput = document.getElementById("email-input");
const passwordInput = document.getElementById("password-input");
const loginBtn = document.getElementById("login-btn");
const loginError = document.getElementById("login-error");
const adminEmailEl = document.getElementById("admin-email");
const sidebarAvatarEl = document.getElementById("sidebar-avatar");
const customerListEl = document.getElementById("customer-list");
const messagesEl = document.getElementById("messages");
const typingPreviewEl = document.getElementById("typing-preview");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const imageInput = document.getElementById("image-input");
const chatHeaderText = document.getElementById("chat-header-text");
const chatHeaderStatus = document.getElementById("chat-header-status");
const infoToggleBtn = document.getElementById("info-toggle-btn");
const infoCloseBtn = document.getElementById("info-close-btn");
const customerPanel = document.getElementById("customer-panel");
const customerPanelBody = document.getElementById("customer-panel-body");
const tabActiveBtn = document.getElementById("tab-active-btn");
const tabAllBtn = document.getElementById("tab-all-btn");
const tabArchivedBtn = document.getElementById("tab-archived-btn");
const railUnreadBadge = document.getElementById("rail-unread-badge");
const customerSearchInput = document.getElementById("customer-search-input");

const settingsBtn = document.getElementById("settings-btn");
const settingsProfileView = document.getElementById("settings-profile-view");
const settingsAppearanceView = document.getElementById("settings-appearance-view");
const settingsAutochatView = document.getElementById("settings-autochat-view");
const settingsHistoryView = document.getElementById("settings-history-view");
const settingsHoursView = document.getElementById("settings-hours-view");
const avatarPreview = document.getElementById("avatar-preview");
const photoInput = document.getElementById("photo-input");
const displayNameInput = document.getElementById("display-name-input");
const settingsSaveBtn = document.getElementById("settings-save-btn");
const settingsError = document.getElementById("settings-error");
const settingsLogoutBtn = document.getElementById("settings-logout-btn");

const appearanceBrandInput = document.getElementById("appearance-brand-input");
const appearanceColorInput = document.getElementById("appearance-color-input");
const appearanceColorText = document.getElementById("appearance-color-text");
const appearanceIconInput = document.getElementById("appearance-icon-input");
const bubbleImagePreview = document.getElementById("bubble-image-preview");
const bubbleImageInput = document.getElementById("bubble-image-input");
const bubbleImageRemoveBtn = document.getElementById("bubble-image-remove-btn");
const appearanceAnimationSelect = document.getElementById("appearance-animation-select");
const headerLogoPreview = document.getElementById("header-logo-preview");
const headerLogoInput = document.getElementById("header-logo-input");
const headerLogoRemoveBtn = document.getElementById("header-logo-remove-btn");
const proactiveEnabledInput = document.getElementById("proactive-enabled-input");
const proactiveTextInput = document.getElementById("proactive-text-input");
const proactiveDelayInput = document.getElementById("proactive-delay-input");
const appearanceSaveBtn = document.getElementById("appearance-save-btn");
const appearanceError = document.getElementById("appearance-error");

const autochatEnabledInput = document.getElementById("autochat-enabled-input");
const autochatMessageInput = document.getElementById("autochat-message-input");
const autochatOptionsInput = document.getElementById("autochat-options-input");
const autochatSaveBtn = document.getElementById("autochat-save-btn");
const autochatError = document.getElementById("autochat-error");

const historyLogList = document.getElementById("history-log-list");
const historyLogEmpty = document.getElementById("history-log-empty");
const historyDetailOverlay = document.getElementById("history-detail-overlay");
const historyDetailTitle = document.getElementById("history-detail-title");
const historyDetailMessages = document.getElementById("history-detail-messages");
const historyDetailCloseBtn = document.getElementById("history-detail-close-btn");
const historyDetailExportBtn = document.getElementById("history-detail-export-btn");

const hoursEnabledInput = document.getElementById("hours-enabled-input");
const hoursDayCheckboxes = document.querySelectorAll(".hours-day-checkbox");
const hoursStartInput = document.getElementById("hours-start-input");
const hoursEndInput = document.getElementById("hours-end-input");
const hoursOfflineMessageInput = document.getElementById("hours-offline-message-input");
const hoursSaveBtn = document.getElementById("hours-save-btn");
const hoursError = document.getElementById("hours-error");

const savedRepliesBtn = document.getElementById("saved-replies-btn");
const savedRepliesOverlay = document.getElementById("saved-replies-overlay");
const savedRepliesList = document.getElementById("saved-replies-list");
const savedReplyForm = document.getElementById("saved-reply-form");
const savedReplyInput = document.getElementById("saved-reply-input");
const savedRepliesCloseBtn = document.getElementById("saved-replies-close-btn");
const replySuggestionsEl = document.getElementById("reply-suggestions");

const statsBtn = document.getElementById("stats-btn");
const statsView = document.getElementById("stats-view");
const statsBackBtn = document.getElementById("stats-back-btn");
const statsTodayCount = document.getElementById("stats-today-count");
const statsYesterdayCount = document.getElementById("stats-yesterday-count");
const statsTodayNewCustomers = document.getElementById("stats-today-new-customers");
const statsTotalCustomers = document.getElementById("stats-total-customers");
const statsOpenCustomers = document.getElementById("stats-open-customers");
const statsResponseTime = document.getElementById("stats-response-time");
const statsDeltaEl = document.getElementById("stats-delta");
const statsChartEl = document.getElementById("stats-chart");
const statsChartTotal = document.getElementById("stats-chart-total");
const statsAxisStart = document.getElementById("stats-axis-start");

let unsubSavedReplies = null;
let savedRepliesCache = [];
let suggestionMatches = [];
let suggestionIndex = -1;

let pendingPhotoDataUrl = null;
// undefined = tidak diubah (pertahankan nilai lama), null = mau dihapus
// (kembali ke emoji/tanpa logo), string = gambar baru yang mau disimpan.
let pendingBubbleImageDataUrl = undefined;
let pendingHeaderLogoDataUrl = undefined;

// --- Suara notifikasi ---
let audioCtx = null;

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

function playNotificationSound() {
  if (!audioCtx || audioCtx.state !== "running") return;
  const ctx = audioCtx;
  const now = ctx.currentTime;
  [880, 1320].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + i * 0.12);
    gain.gain.exponentialRampToValueAtTime(0.2, now + i * 0.12 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + i * 0.12);
    osc.stop(now + i * 0.12 + 0.2);
  });
}

// Belum bisa kirim email/push notification beneran tanpa Cloud Functions
// (Blaze plan), tapi selama tab admin masih kebuka (walau di-minimize/pindah
// tab lain), Notification API browser tetap bisa munculin popup OS -- lebih
// kuat dari sekadar judul tab berkedip yang sudah ada.
let notificationPermissionRequested = false;
function requestNotificationPermission() {
  if (!currentAdmin || notificationPermissionRequested) return;
  if (!("Notification" in window) || Notification.permission !== "default") return;
  notificationPermissionRequested = true;
  Notification.requestPermission();
}

function showDesktopNotification(names) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  // Tab lagi kebuka & difokus -> admin sudah pasti lihat chat-nya langsung,
  // popup OS di sini cuma bakal ganggu.
  if (document.visibilityState === "visible" && document.hasFocus()) return;

  const title = names.length === 1 ? `Pesan baru dari ${names[0]}` : `Pesan baru dari ${names.length} customer`;
  const body =
    names.length <= 3 ? names.join(", ") : names.slice(0, 3).join(", ") + `, +${names.length - 3} lagi`;

  let notif;
  try {
    notif = new Notification(title, { body, tag: "livechat-new-message" });
  } catch (err) {
    return; // beberapa browser (mis. sebagian mobile) tidak support constructor ini
  }
  notif.onclick = () => {
    window.focus();
    notif.close();
  };
}

// Browser mengunci audio sampai ada interaksi pengguna. Selain saat klik
// tombol "Masuk", kita juga buka lewat interaksi pertama apa pun di halaman
// (penting untuk kasus admin sudah otomatis login lewat sesi tersimpan).
function unlockAudioOnFirstInteraction() {
  ensureAudio();
  requestNotificationPermission();
}
document.addEventListener("click", unlockAudioOnFirstInteraction);
document.addEventListener("keydown", unlockAudioOnFirstInteraction);

function isSettingsOpen() {
  return (
    !settingsProfileView.classList.contains("hidden") ||
    !settingsAppearanceView.classList.contains("hidden") ||
    !settingsAutochatView.classList.contains("hidden") ||
    !settingsHistoryView.classList.contains("hidden") ||
    !settingsHoursView.classList.contains("hidden")
  );
}

// Pindah chat customer dengan Alt + panah atas/bawah (panah polos dipakai
// untuk navigasi saran saved replies di kolom pesan).
document.addEventListener("keydown", (e) => {
  if (!currentAdmin) return;
  if (!e.altKey) return;
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  if (isSettingsOpen()) return;

  const entries = getVisibleCustomerEntries();
  if (entries.length === 0) return;

  let index = entries.findIndex((entry) => entry.uid === activeCustomerUid);
  if (e.key === "ArrowDown") {
    index = index === -1 ? 0 : Math.min(index + 1, entries.length - 1);
  } else {
    index = index === -1 ? 0 : Math.max(index - 1, 0);
  }

  e.preventDefault();
  const next = entries[index];
  openCustomer(next.uid, next.name);
});

// Alt + Enter mengarsipkan/memulihkan percakapan yang sedang dibuka.
document.addEventListener("keydown", (e) => {
  if (!currentAdmin) return;
  if (!e.altKey || e.key !== "Enter") return;
  if (isSettingsOpen()) return;
  if (!activeCustomerUid || !customersDataMap.has(activeCustomerUid)) return;

  e.preventDefault();
  const data = customersDataMap.get(activeCustomerUid);
  toggleArchive(activeCustomerUid, !data.archived);
});

// Ctrl+/ (atau Cmd+/ di Mac) kapan saja membuka panel Saved Replies.
document.addEventListener("keydown", (e) => {
  if (!currentAdmin) return;
  if (!(e.ctrlKey || e.metaKey) || e.key !== "/") return;
  e.preventDefault();

  if (savedRepliesOverlay.classList.contains("hidden")) {
    openSavedReplies();
  } else {
    savedRepliesOverlay.classList.add("hidden");
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !savedRepliesOverlay.classList.contains("hidden")) {
    savedRepliesOverlay.classList.add("hidden");
  }
  if (e.key === "Escape" && !historyDetailOverlay.classList.contains("hidden")) {
    historyDetailOverlay.classList.add("hidden");
  }
  if (e.key === "Escape" && !statsView.classList.contains("hidden")) {
    navigateTo("open");
  }
  if (e.key === "Escape" && isSettingsOpen()) {
    navigateTo("open");
  }
});

savedRepliesBtn.addEventListener("click", () => {
  openSavedReplies();
});

savedRepliesCloseBtn.addEventListener("click", () => {
  savedRepliesOverlay.classList.add("hidden");
});

savedReplyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = savedReplyInput.value.trim();
  if (!text || !currentAdmin) return;
  savedReplyInput.value = "";
  try {
    await addDoc(collection(db, ...wsPath("admins", currentAdmin.uid, "savedReplies")), {
      text,
      createdAt: serverTimestamp()
    });
  } catch (err) {
    alert("Gagal menyimpan saved reply: " + err.message);
  }
});

function showLoginError(message) {
  loginError.textContent = message;
  loginError.classList.remove("hidden");
}

const CUSTOMER_AVATAR_COLORS = [
  "#4f9fe0",
  "#e05f8f",
  "#f0a84e",
  "#8f6fe0",
  "#5fcf8f",
  "#e0745f",
  "#4fd0c0",
  "#c77fe0"
];

function colorForId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return CUSTOMER_AVATAR_COLORS[hash % CUSTOMER_AVATAR_COLORS.length];
}

function createPersonIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
  );
  svg.appendChild(path);
  return svg;
}

function renderAvatar(el, photo, name) {
  if (photo) {
    el.style.backgroundImage = `url(${photo})`;
    el.textContent = "";
  } else {
    el.style.backgroundImage = "";
    el.textContent = (name || currentAdmin?.email || "?").trim().charAt(0).toUpperCase();
  }
}

// Bikin alias huruf-kecil kalau belum ada, supaya link customer yang
// ditempel di website perusahaan (yang kadang otomatis diubah jadi huruf
// kecil semua oleh CMS-nya) tetap bisa nemuin workspace ini -- lihat
// firestore.rules (workspaceSlugs) & customer.js (loadInitialData).
// Diam-diam gagal kalau errror (mis. lagi offline), dicoba lagi login berikutnya.
async function ensureWorkspaceSlug(workspaceId) {
  try {
    const slugRef = doc(db, "workspaceSlugs", workspaceId.toLowerCase());
    const slugSnap = await getDoc(slugRef);
    if (!slugSnap.exists()) {
      await setDoc(slugRef, { workspaceId });
    }
  } catch (err) {
    // tidak krusial, dicoba lagi login berikutnya
  }
}

async function enterDashboard(uid, email, workspaceId, adminData = {}) {
  ensureAudio();
  currentAdmin = {
    uid,
    email,
    workspaceId,
    workspaceName: null,
    name: adminData.name || email,
    photo: adminData.photo || null
  };
  adminEmailEl.textContent = currentAdmin.name;
  renderAvatar(sidebarAvatarEl, currentAdmin.photo, currentAdmin.name);
  loginScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");

  try {
    const wsSnap = await getDoc(doc(db, ...wsPath()));
    if (wsSnap.exists()) {
      const wsData = wsSnap.data();
      currentAdmin.workspaceName = wsData.name || null;
      currentAdmin.workspaceBrandName = wsData.brandName || wsData.name || "";
      currentAdmin.workspaceThemeColor = wsData.themeColor || "#5b8cff";
      currentAdmin.workspaceBubbleIcon = wsData.bubbleIcon || "💬";
      currentAdmin.workspaceBubbleImage = wsData.bubbleImageBase64 || null;
      currentAdmin.workspaceHeaderLogo = wsData.headerLogoBase64 || null;
      currentAdmin.workspaceBubbleAnimation = wsData.bubbleAnimation || "none";
      currentAdmin.proactiveGreetingEnabled = !!wsData.proactiveGreetingEnabled;
      currentAdmin.proactiveGreetingText = wsData.proactiveGreetingText || "";
      currentAdmin.proactiveGreetingDelay = wsData.proactiveGreetingDelay || 4;
      currentAdmin.autoGreetingEnabled = !!wsData.autoGreetingEnabled;
      currentAdmin.autoGreetingMessage = wsData.autoGreetingMessage || "";
      currentAdmin.autoGreetingOptions = Array.isArray(wsData.autoGreetingOptions) ? wsData.autoGreetingOptions : [];
      currentAdmin.autoGreetingOptionReplies =
        wsData.autoGreetingOptionReplies && typeof wsData.autoGreetingOptionReplies === "object"
          ? wsData.autoGreetingOptionReplies
          : {};
      currentAdmin.businessHoursEnabled = !!wsData.businessHoursEnabled;
      currentAdmin.businessHoursDays = Array.isArray(wsData.businessHoursDays) ? wsData.businessHoursDays : [];
      currentAdmin.businessHoursStart = wsData.businessHoursStart || "09:00";
      currentAdmin.businessHoursEnd = wsData.businessHoursEnd || "17:00";
      currentAdmin.offlineMessage = wsData.offlineMessage || "";
      if (currentAdmin.workspaceName) document.title = currentAdmin.workspaceName + " - Admin";
    }
  } catch (err) {
    // biarkan, tidak krusial
  }

  ensureWorkspaceSlug(workspaceId);

  listenCustomers();
  listenSavedReplies();

  if (autoArchiveIntervalId) clearInterval(autoArchiveIntervalId);
  autoArchiveIntervalId = setInterval(checkAutoArchive, 60000);

  // Status online/offline butuh dicek ulang berkala juga (bukan cuma pas ada
  // snapshot baru), karena berlalunya waktu sendiri tidak memicu snapshot.
  if (presenceIntervalId) clearInterval(presenceIntervalId);
  presenceIntervalId = setInterval(() => {
    renderCustomerList();
    updateChatHeaderPresence();
  }, 5000);

  applyRoute();
}

function listenSavedReplies() {
  if (unsubSavedReplies) unsubSavedReplies();
  const q = query(
    collection(db, ...wsPath("admins", currentAdmin.uid, "savedReplies")),
    orderBy("createdAt", "asc")
  );
  unsubSavedReplies = onSnapshot(q, (snap) => {
    savedRepliesList.innerHTML = "";
    savedRepliesCache = [];

    if (snap.empty) {
      const empty = document.createElement("li");
      empty.className = "saved-reply-empty";
      empty.textContent = "Belum ada saved reply. Tambahkan di bawah.";
      savedRepliesList.appendChild(empty);
      return;
    }

    snap.forEach((docSnap) => {
      const data = docSnap.data();
      savedRepliesCache.push({ id: docSnap.id, text: data.text });

      const li = document.createElement("li");
      li.className = "saved-reply-item";

      const textEl = document.createElement("span");
      textEl.className = "saved-reply-text";
      textEl.textContent = data.text;
      li.addEventListener("click", () => {
        messageInput.value = data.text;
        autoResizeMessageInput();
        savedRepliesOverlay.classList.add("hidden");
        messageInput.focus();
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "saved-reply-delete-btn";
      deleteBtn.title = "Hapus";
      deleteBtn.textContent = "🗑";
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteDoc(doc(db, ...wsPath("admins", currentAdmin.uid, "savedReplies", docSnap.id))).catch(() => {});
      });

      li.appendChild(textEl);
      li.appendChild(deleteBtn);
      savedRepliesList.appendChild(li);
    });
  });
}

function openSavedReplies() {
  savedRepliesOverlay.classList.remove("hidden");
  savedReplyInput.focus();
}

// --- Dashboard Statistik ---

function formatShortDateWIB(dateKey) {
  // dateKey = "YYYY-MM-DD" -> "5 Agu"
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString("id-ID", { day: "numeric", month: "short", timeZone: "UTC" });
}

async function openStats() {
  appScreen.classList.add("hidden");
  statsView.classList.remove("hidden");
  statsChartEl.innerHTML = "";
  statsTodayCount.textContent = "…";
  statsYesterdayCount.textContent = "…";
  statsTodayNewCustomers.textContent = "…";
  statsDeltaEl.textContent = "";

  let openCount = 0;
  customersDataMap.forEach((data) => {
    if (!data.archived) openCount += 1;
  });
  statsTotalCustomers.textContent = String(customersDataMap.size);
  statsOpenCustomers.textContent = String(openCount);

  const DAYS = 30;
  const startKey = dateKeyDaysAgoWIB(DAYS - 1);
  const todayKey = todayKeyWIB();

  // Kunci tanggal format YYYY-MM-DD urut leksikografis sama dengan urut
  // kronologis, jadi range query pakai documentId() bisa dipakai langsung
  // tanpa perlu 30x getDoc terpisah.
  const byDate = new Map();
  try {
    const q = query(
      collection(db, ...wsPath("stats")),
      where(documentId(), ">=", startKey),
      where(documentId(), "<=", todayKey)
    );
    const snap = await getDocs(q);
    snap.forEach((docSnap) => byDate.set(docSnap.id, docSnap.data()));
  } catch (err) {
    console.error("Gagal memuat statistik:", err);
  }

  let firstResponseTotalMs = 0;
  let firstResponseCount = 0;
  byDate.forEach((data) => {
    firstResponseTotalMs += data.firstResponseTotalMs || 0;
    firstResponseCount += data.firstResponseCount || 0;
  });
  statsResponseTime.textContent =
    firstResponseCount > 0 ? formatDurationShort(firstResponseTotalMs / firstResponseCount) : "-";

  const days = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const key = dateKeyDaysAgoWIB(i);
    const data = byDate.get(key) || {};
    days.push({ key, messageCount: data.messageCount || 0, newCustomers: data.newCustomers || 0 });
  }

  const today = days[days.length - 1];
  const yesterday = days[days.length - 2] || { messageCount: 0 };

  statsTodayCount.textContent = String(today.messageCount);
  statsYesterdayCount.textContent = String(yesterday.messageCount);
  statsTodayNewCustomers.textContent = String(today.newCustomers);

  const diff = today.messageCount - yesterday.messageCount;
  if (diff > 0) {
    statsDeltaEl.textContent = "▲ " + diff + " dari kemarin";
    statsDeltaEl.className = "stats-delta up";
  } else if (diff < 0) {
    statsDeltaEl.textContent = "▼ " + Math.abs(diff) + " dari kemarin";
    statsDeltaEl.className = "stats-delta down";
  } else {
    statsDeltaEl.textContent = "Sama seperti kemarin";
    statsDeltaEl.className = "stats-delta flat";
  }

  const total = days.reduce((sum, d) => sum + d.messageCount, 0);
  statsChartTotal.textContent = "(" + total + " pesan)";
  statsAxisStart.textContent = formatShortDateWIB(days[0].key);

  const maxCount = Math.max(1, ...days.map((d) => d.messageCount));
  statsChartEl.innerHTML = "";
  days.forEach((d, i) => {
    const wrap = document.createElement("div");
    wrap.className = "stats-bar-wrap" + (i === days.length - 1 ? " is-today" : "");

    const bar = document.createElement("div");
    bar.className = "stats-bar";
    bar.style.height = Math.max(2, Math.round((d.messageCount / maxCount) * 100)) + "%";

    const tooltip = document.createElement("div");
    tooltip.className = "stats-bar-tooltip";
    tooltip.textContent = formatShortDateWIB(d.key) + ": " + d.messageCount + " pesan";

    wrap.appendChild(tooltip);
    wrap.appendChild(bar);
    statsChartEl.appendChild(wrap);
  });
}

statsBtn.addEventListener("click", () => navigateTo("stats"));
statsBackBtn.addEventListener("click", () => navigateTo("open"));

// --- Saran otomatis saved replies saat mengetik di kolom pesan ---

function findSuggestionMatches(value) {
  const typed = value.trim().toLowerCase();
  if (typed.length < 3) return [];

  return savedRepliesCache
    .filter((reply) => {
      const lower = reply.text.toLowerCase();
      if (lower.includes(typed)) return true;
      return lower.split(/\s+/).some((word) => word.startsWith(typed));
    })
    .slice(0, 6);
}

function renderSuggestions() {
  replySuggestionsEl.innerHTML = "";

  if (suggestionMatches.length === 0) {
    replySuggestionsEl.classList.add("hidden");
    return;
  }

  suggestionMatches.forEach((reply, i) => {
    const item = document.createElement("div");
    item.className = "reply-suggestion-item" + (i === suggestionIndex ? " highlighted" : "");
    item.textContent = reply.text;
    // mousedown (bukan click) supaya terpilih sebelum blur menutup dropdown-nya
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      selectSuggestion(i);
    });
    replySuggestionsEl.appendChild(item);
  });

  replySuggestionsEl.classList.remove("hidden");
}

function selectSuggestion(index) {
  const reply = suggestionMatches[index];
  if (!reply) return;
  messageInput.value = reply.text;
  autoResizeMessageInput();
  closeSuggestions();
  messageInput.focus();
}

function closeSuggestions() {
  suggestionMatches = [];
  suggestionIndex = -1;
  replySuggestionsEl.classList.add("hidden");
  replySuggestionsEl.innerHTML = "";
}

// #message-input sekarang <textarea> (bukan <input>) supaya Shift+Enter bisa
// bikin baris baru -- tingginya menyesuaikan otomatis sampai batas CSS
// max-height, lewat di situ baru discroll. Dipanggil tiap 'input' DAN tiap
// value-nya diisi lewat kode (pilih saved reply/suggestion, dikosongkan
// habis kirim), soalnya set .value lewat JS tidak memicu event 'input'.
function autoResizeMessageInput() {
  messageInput.style.height = "auto";
  messageInput.style.height = messageInput.scrollHeight + "px";
}

messageInput.addEventListener("input", () => {
  autoResizeMessageInput();
  suggestionMatches = findSuggestionMatches(messageInput.value);
  suggestionIndex = suggestionMatches.length > 0 ? 0 : -1;
  renderSuggestions();
});

messageInput.addEventListener("keydown", (e) => {
  if (suggestionMatches.length > 0) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      suggestionIndex = (suggestionIndex + 1) % suggestionMatches.length;
      renderSuggestions();
      return;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      suggestionIndex = (suggestionIndex - 1 + suggestionMatches.length) % suggestionMatches.length;
      renderSuggestions();
      return;
    } else if (e.key === "Enter") {
      e.preventDefault();
      selectSuggestion(suggestionIndex);
      return;
    } else if (e.key === "Escape") {
      closeSuggestions();
      return;
    }
  }

  // Enter polos = kirim (textarea bawaan cuma bikin baris baru terus, tidak
  // pernah submit form sendiri), Shift+Enter = baris baru seperti biasa.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    messageForm.requestSubmit();
  }
});

messageInput.addEventListener("blur", () => {
  setTimeout(closeSuggestions, 100);
});

function oneYearFromNow() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d;
}

// Percakapan yang sudah 30 menit tanpa pesan baru (dari admin maupun
// customer) otomatis dipindah ke Arsip. Dicek tiap ada snapshot baru + tiap
// 60 detik (lewat setInterval), karena waktu berjalan tidak memicu snapshot.
function checkAutoArchive() {
  const now = Date.now();
  customersDataMap.forEach((data, uid) => {
    if (data.archived) return;
    if (!data.lastMessageAt) return;
    if (now - data.lastMessageAt.toMillis() >= AUTO_ARCHIVE_MS) {
      setDoc(
        doc(db, ...wsPath("customers", uid)),
        { archived: true, archivedAt: serverTimestamp(), expireAt: oneYearFromNow() },
        { merge: true }
      ).catch(() => {});
    }
  });
}

// Nutup panel chat yang lagi kebuka (balik ke tampilan "Pilih customer di
// sebelah kiri") -- dipakai kalau chat yang lagi dibuka dihapus ATAU
// diarsipkan, supaya tidak ketinggalan nampilin chat yang sebenarnya sudah
// tidak ada lagi di daftar Open.
function closeActiveChat() {
  if (unsubMessages) unsubMessages();
  unsubMessages = null;
  activeCustomerUid = null;
  activeCustomerName = "";
  chatHeaderText.textContent = "Pilih customer di sebelah kiri";
  updateChatHeaderPresence();
  infoToggleBtn.classList.add("hidden");
  customerPanel.classList.add("hidden");
  messageForm.classList.add("hidden");
  messagesEl.innerHTML = "";
  typingPreviewEl.classList.add("hidden");
}

async function toggleArchive(uid, archived) {
  try {
    const update = archived
      ? { archived: true, archivedAt: serverTimestamp(), expireAt: oneYearFromNow() }
      : { archived: false, archivedAt: null, expireAt: null };
    await setDoc(doc(db, ...wsPath("customers", uid)), update, { merge: true });
    // Diarsipkan sementara chat ini yang lagi kebuka -> tutup panelnya,
    // soalnya begitu diarsipkan dia hilang dari daftar Open. Dipulihkan
    // (un-archive) sengaja TIDAK ikut nutup, biar admin bisa lanjut chat.
    if (archived && uid === activeCustomerUid) {
      closeActiveChat();
    }
  } catch (err) {
    alert("Gagal mengubah status arsip: " + err.message);
  }
}

// limit(300): tanpa batas ini, tiap kali listener ini dipasang (login/buka
// dashboard) biayanya = 1 baca Firestore x SELURUH histori customer yang
// pernah ada (termasuk yang sudah diarsipkan sampai 1 tahun) -- makin lama
// dipakai makin berat. 300 lebih dari cukup untuk percakapan aktif (auto-
// archive 30 menit menjaga jumlah itu tetap kecil) + arsip beberapa bulan
// terakhir; kalau nanti histori arsipnya jauh lebih besar dari itu, chat
// paling lama tidak akan lagi kelihatan di tab Arsip/pencarian.
function listenCustomers() {
  const q = query(collection(db, ...wsPath("customers")), orderBy("lastMessageAt", "desc"), limit(300));
  onSnapshot(q, (snap) => {
    let shouldPlaySound = false;
    const newMessageNames = [];
    customersDataMap.clear();

    snap.forEach((docSnap) => {
      const uid = docSnap.id;
      const data = docSnap.data();
      if (!data.name) return;
      customersDataMap.set(uid, data);

      const waiting = data.lastSender === "customer";
      const newMillis = data.lastMessageAt ? data.lastMessageAt.toMillis() : 0;
      const prevMillis = lastKnownTimestamps.get(uid);

      if (customersInitialLoadDone && !data.archived && waiting && newMillis > (prevMillis || 0)) {
        shouldPlaySound = true;
        newMessageNames.push(data.name);
      }
      lastKnownTimestamps.set(uid, newMillis);
    });

    if (shouldPlaySound) {
      playNotificationSound();
      showDesktopNotification(newMessageNames);
    }
    customersInitialLoadDone = true;

    renderCustomerList();
    updateRailBadge();
    updateTypingPreview();
    checkAutoArchive();

    if (activeCustomerUid && customersDataMap.has(activeCustomerUid)) {
      renderCustomerPanel(customersDataMap.get(activeCustomerUid), activeCustomerUid);
    }
    updateChatHeaderPresence();
  });
}

function matchesSearch(data) {
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  if ((data.name || "").toLowerCase().includes(q)) return true;
  if (Array.isArray(data.searchText)) {
    return data.searchText.some((t) => (t || "").toLowerCase().includes(q));
  }
  return false;
}

function getVisibleCustomerEntries() {
  const entries = [];
  customersDataMap.forEach((data, uid) => {
    // Lagi nyari? Abaikan filter tab Aktif/Arsip -- customer maunya nemu
    // chat-nya, bukan dibatasi tab mana yang lagi kebuka (chat yang dicari
    // bisa saja sudah keburu ke-auto-archive).
    if (!searchQuery) {
      const isArchived = !!data.archived;
      if (currentListView === "archived" && !isArchived) return;
      if (currentListView === "active" && isArchived) return;
    }
    if (!matchesSearch(data)) return;
    entries.push({ uid, name: data.name });
  });
  return entries;
}

function updateChatHeaderPresence() {
  if (!chatHeaderStatus) return;
  const data = activeCustomerUid ? customersDataMap.get(activeCustomerUid) : null;
  if (!data) {
    chatHeaderStatus.textContent = "";
    chatHeaderStatus.className = "chat-header-status hidden";
    return;
  }
  const online = isCustomerOnline(data);
  chatHeaderStatus.textContent = online ? "Online" : "Offline";
  chatHeaderStatus.className = "chat-header-status " + (online ? "online" : "offline");
}

function updateTypingPreview() {
  const data = activeCustomerUid ? customersDataMap.get(activeCustomerUid) : null;
  const draft = data && data.typingDraft;

  if (!draft) {
    typingPreviewEl.classList.add("hidden");
    typingPreviewEl.innerHTML = "";
    return;
  }

  typingPreviewEl.innerHTML = "";
  const label = document.createElement("strong");
  label.textContent = "Sedang mengetik: ";
  typingPreviewEl.appendChild(label);
  typingPreviewEl.appendChild(document.createTextNode(draft));
  typingPreviewEl.classList.remove("hidden");
}

// --- Notifikasi di tab browser (judul + favicon bertitik merah) ---

const faviconLink = document.querySelector('link[rel="icon"]');

function buildFaviconDataUrl(hasBadge) {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");

  ctx.save();
  ctx.scale(32 / 24, 32 / 24);
  const bubble = new Path2D("M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z");
  ctx.fillStyle = "#D4AF37";
  ctx.fill(bubble);
  ctx.restore();

  if (hasBadge) {
    ctx.beginPath();
    ctx.arc(25, 8, 7, 0, Math.PI * 2);
    ctx.fillStyle = "#ff3b3b";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#0f1115";
    ctx.stroke();
  }

  return canvas.toDataURL("image/png");
}

function getBaseTitle() {
  return (currentAdmin && currentAdmin.workspaceName ? currentAdmin.workspaceName : "LiveChat") + " - Admin";
}

function updateTabNotification(count) {
  document.title = count > 0 ? "(" + (count > 99 ? "99+" : count) + ") " + getBaseTitle() : getBaseTitle();
  if (faviconLink) faviconLink.href = buildFaviconDataUrl(count > 0);
}

function updateRailBadge() {
  let total = 0;
  customersDataMap.forEach((data) => {
    if (data.archived) return;
    total += data.unreadCount || 0;
  });

  if (total > 0) {
    railUnreadBadge.textContent = total > 99 ? "99+" : String(total);
    railUnreadBadge.classList.remove("hidden");
  } else {
    railUnreadBadge.classList.add("hidden");
  }

  updateTabNotification(total);
}

function renderCustomerList() {
  customerListEl.innerHTML = "";

  customersDataMap.forEach((data, uid) => {
    const isArchived = !!data.archived;
    if (!searchQuery) {
      if (currentListView === "archived" && !isArchived) return;
      if (currentListView === "active" && isArchived) return;
    }
    if (!matchesSearch(data)) return;

    const unreadCount = data.unreadCount || 0;
    const waiting = unreadCount > 0;

    const li = document.createElement("li");
    li.className =
      "user-item customer-item" +
      (uid === activeCustomerUid ? " active" : "") +
      (waiting ? " waiting" : "");

    const avatar = document.createElement("div");
    avatar.className = "customer-avatar";
    avatar.style.backgroundColor = colorForId(uid);
    avatar.appendChild(createPersonIcon());

    const presenceDot = document.createElement("span");
    presenceDot.className = "presence-dot " + (isCustomerOnline(data) ? "online" : "offline");
    avatar.appendChild(presenceDot);

    li.appendChild(avatar);

    const info = document.createElement("div");
    info.className = "customer-info";

    const nameRow = document.createElement("div");
    nameRow.className = "name-row";
    const nameSpan = document.createElement("span");
    nameSpan.className = "customer-name-text";
    nameSpan.textContent = data.name;
    nameRow.appendChild(nameSpan);
    if (waiting) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = String(unreadCount);
      nameRow.appendChild(badge);
    }
    // Hasil pencarian bisa nyelip dari luar tab yang lagi kebuka (lihat
    // getVisibleCustomerEntries/renderCustomerList di atas) -- tag ini
    // ngasih tau kenapa chat yang diarsipkan muncul pas lagi di tab Aktif.
    if (searchQuery && isArchived && currentListView !== "archived") {
      const archivedTag = document.createElement("span");
      archivedTag.className = "badge archived-tag";
      archivedTag.textContent = "Arsip";
      nameRow.appendChild(archivedTag);
    }
    const timeSpan = document.createElement("span");
    timeSpan.className = "customer-time";
    timeSpan.textContent = formatListTimestamp(data.lastMessageAt);
    nameRow.appendChild(timeSpan);
    info.appendChild(nameRow);

    const preview = document.createElement("span");
    preview.className = "preview";
    preview.textContent = data.lastMessage || "";
    info.appendChild(preview);

    li.appendChild(info);

    li.addEventListener("click", () => openCustomer(uid, data.name));
    customerListEl.appendChild(li);
  });
}

function renderCustomerPanel(data, uid) {
  customerPanelBody.innerHTML = "";

  const fields = [
    { label: "Nama", value: data.name },
    { label: "Alamat IP", value: data.ip },
    { label: "Kota", value: data.city },
    { label: "Provinsi/Wilayah", value: data.region },
    { label: "Negara", value: data.country }
  ];

  fields.forEach(({ label, value }) => {
    const row = document.createElement("div");
    row.className = "detail-row";
    const labelEl = document.createElement("span");
    labelEl.className = "detail-label";
    labelEl.textContent = label;
    const valueEl = document.createElement("span");
    valueEl.className = "detail-value";
    valueEl.textContent = value || "-";
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    customerPanelBody.appendChild(row);
  });

  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.className = "archive-btn";
  exportBtn.textContent = "Ekspor Chat (.txt)";
  exportBtn.addEventListener("click", () => exportChatTranscript(uid, data.name, exportBtn));
  customerPanelBody.appendChild(exportBtn);

  const archiveBtn = document.createElement("button");
  archiveBtn.type = "button";
  archiveBtn.className = "archive-btn";
  archiveBtn.textContent = data.archived ? "Pulihkan dari Arsip" : "Arsipkan Percakapan";
  archiveBtn.addEventListener("click", () => toggleArchive(uid, !data.archived));
  customerPanelBody.appendChild(archiveBtn);

  const deleteAllBtn = document.createElement("button");
  deleteAllBtn.type = "button";
  deleteAllBtn.className = "archive-btn danger";
  deleteAllBtn.textContent = "Hapus Semua Chat";
  deleteAllBtn.addEventListener("click", () => deleteAllChat(uid, data.name));
  customerPanelBody.appendChild(deleteAllBtn);
}

// Hapus seluruh riwayat chat + dokumen profil customer. Dokumen customer ikut
// terhapus (bukan cuma pesannya) supaya customer.js tidak nemu sesi lama pas
// auto-rejoin (lihat init() di customer.js) dan dipaksa isi nama lagi -> sesi
// baru dari nol, sesuai permintaan. Isi percakapannya sendiri disalin dulu ke
// deletionLogs/{logId}/messages sebelum dihapus, supaya masih bisa dibuka
// lagi lewat Pengaturan > Riwayat walau chat aslinya sudah lenyap.
async function deleteAllChat(uid, name) {
  if (
    !confirm(
      `Hapus SEMUA chat dengan "${name}"? Customer akan kehilangan sesinya dan harus mulai chat baru. Tindakan ini tidak bisa dibatalkan.`
    )
  )
    return;

  try {
    const msgsSnap = await getDocs(collection(db, ...wsPath("chats", uid, "messages")));
    const logRef = doc(collection(db, ...wsPath("deletionLogs")));

    await setDoc(logRef, {
      customerId: uid,
      customerName: name,
      messageCount: msgsSnap.size,
      deletedBy: currentAdmin.uid,
      deletedByName: currentAdmin.name,
      deletedAt: serverTimestamp()
    });

    // Tiap pesan = 1 salin (ke arsip) + 1 hapus (dari chat asli) = 2 operasi,
    // jadi chunk-nya dikecilkan dari batas 500 operasi/batch Firestore.
    const CHUNK_SIZE = 200;
    for (let i = 0; i < msgsSnap.docs.length; i += CHUNK_SIZE) {
      const batch = writeBatch(db);
      msgsSnap.docs.slice(i, i + CHUNK_SIZE).forEach((docSnap) => {
        batch.set(doc(db, ...wsPath("deletionLogs", logRef.id, "messages", docSnap.id)), docSnap.data());
        batch.delete(docSnap.ref);
      });
      await batch.commit();
    }

    await deleteDoc(doc(db, ...wsPath("customers", uid)));

    if (uid === activeCustomerUid) {
      closeActiveChat();
    }
  } catch (err) {
    alert("Gagal menghapus chat: " + err.message);
  }
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function safeFileNamePart(text) {
  return (text || "customer").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "customer";
}

function messagesToTranscript(customerName, docs) {
  const lines = [`Riwayat Chat - ${customerName}`, `Diekspor: ${new Date().toLocaleString("id-ID")}`, ""];
  docs.forEach((docSnap) => {
    const m = docSnap.data();
    const who = m.sender === "admin" ? m.senderName || "Admin" : customerName;
    const when = formatDateWIB(m.timestamp) + " " + formatTimeWIB(m.timestamp);
    const content =
      m.type === "image" ? "[Gambar]" : Array.isArray(m.options) ? "[Menu pilihan: " + m.options.join(", ") + "]" : m.text || "";
    lines.push(`[${when}] ${who}: ${content}`);
  });
  return lines.join("\n");
}

async function exportChatTranscript(uid, name, triggerBtn) {
  if (triggerBtn) triggerBtn.disabled = true;
  try {
    const snap = await getDocs(
      query(collection(db, ...wsPath("chats", uid, "messages")), orderBy("timestamp", "asc"))
    );
    downloadTextFile(`chat-${safeFileNamePart(name)}-${Date.now()}.txt`, messagesToTranscript(name, snap.docs));
  } catch (err) {
    alert("Gagal mengekspor chat: " + err.message);
  } finally {
    if (triggerBtn) triggerBtn.disabled = false;
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

// Versi ringkas buat daftar customer di sidebar (mirip WhatsApp): jam kalau
// pesan terakhirnya hari ini, tanggal pendek kalau bukan -- supaya muat di
// ruang sempit di ujung kanan tiap baris.
function formatListTimestamp(timestamp) {
  if (!timestamp || !timestamp.toDate) return "";
  const date = timestamp.toDate();
  const dateKeyWIB = (d) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

  if (dateKeyWIB(date) === dateKeyWIB(new Date())) {
    return date.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Jakarta" });
  }
  return date.toLocaleDateString("id-ID", { day: "numeric", month: "short", timeZone: "Asia/Jakarta" });
}

function createDateDivider(label) {
  const div = document.createElement("div");
  div.className = "date-divider";
  div.textContent = label;
  return div;
}

function renderMessage(m, messageId) {
  const div = document.createElement("div");
  div.className = "message " + (m.sender === "admin" ? "mine" : "theirs");

  const isOwnMessage = m.sender === "admin" && m.senderId === currentAdmin.uid;

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
  senderLabel.textContent = m.sender === "admin" ? "Anda" : activeCustomerName;
  senderRow.appendChild(senderLabel);

  if (m.edited) {
    const editedBadge = document.createElement("span");
    editedBadge.className = "edited-badge";
    editedBadge.textContent = "(diedit)";
    senderRow.appendChild(editedBadge);
  }

  if (isOwnMessage) {
    const actions = document.createElement("span");
    actions.className = "msg-actions";

    if (m.type !== "image") {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "msg-action-btn";
      editBtn.title = "Edit pesan";
      editBtn.textContent = "✏";
      editBtn.addEventListener("click", () => startEditMessage(messageId, m.text || "", div));
      actions.appendChild(editBtn);
    }

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "msg-action-btn";
    deleteBtn.title = "Hapus pesan";
    deleteBtn.textContent = "🗑";
    deleteBtn.addEventListener("click", () => deleteMessage(messageId));
    actions.appendChild(deleteBtn);

    senderRow.appendChild(actions);
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
      const tag = document.createElement("span");
      tag.className = "option-btn option-tag";
      tag.textContent = opt;
      optWrap.appendChild(tag);
    });
    div.appendChild(optWrap);
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

function startEditMessage(messageId, currentText, bubbleEl) {
  const p = bubbleEl.querySelector("p");
  if (!p) return;

  const editWrap = document.createElement("div");
  editWrap.className = "edit-wrap";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "edit-input";
  input.value = currentText;

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "edit-save-btn";
  saveBtn.textContent = "Simpan";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "edit-cancel-btn";
  cancelBtn.textContent = "Batal";

  editWrap.appendChild(input);
  editWrap.appendChild(saveBtn);
  editWrap.appendChild(cancelBtn);
  p.replaceWith(editWrap);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  const cancel = () => editWrap.replaceWith(p);
  cancelBtn.addEventListener("click", cancel);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") cancel();
    if (e.key === "Enter") saveBtn.click();
  });

  saveBtn.addEventListener("click", async () => {
    const newText = input.value.trim();
    if (!newText || !activeCustomerUid) return;
    saveBtn.disabled = true;
    try {
      await updateDoc(doc(db, ...wsPath("chats", activeCustomerUid, "messages", messageId)), {
        text: newText,
        edited: true,
        editedAt: serverTimestamp()
      });
      indexSearchText(activeCustomerUid, newText);
      refreshLastMessagePreview(activeCustomerUid);
    } catch (err) {
      alert("Gagal menyimpan perubahan: " + err.message);
      saveBtn.disabled = false;
    }
  });
}

async function deleteMessage(messageId) {
  if (!activeCustomerUid) return;
  if (!confirm("Hapus pesan ini?")) return;
  try {
    await deleteDoc(doc(db, ...wsPath("chats", activeCustomerUid, "messages", messageId)));
    refreshLastMessagePreview(activeCustomerUid);
  } catch (err) {
    alert("Gagal menghapus pesan: " + err.message);
  }
}

function openCustomer(uid, name) {
  activeCustomerUid = uid;
  activeCustomerName = name;
  chatHeaderText.textContent = "Chat dengan " + name;
  updateChatHeaderPresence();
  infoToggleBtn.classList.remove("hidden");
  customerPanel.classList.remove("hidden");
  messageForm.classList.remove("hidden");
  messageInput.focus();

  if (customersDataMap.has(uid)) {
    renderCustomerPanel(customersDataMap.get(uid), uid);
  }

  if ((customersDataMap.get(uid)?.unreadCount || 0) > 0) {
    setDoc(doc(db, ...wsPath("customers", uid)), { unreadCount: 0 }, { merge: true }).catch(() => {});
  }

  renderCustomerList();
  updateTypingPreview();

  if (unsubMessages) unsubMessages();

  const q = query(
    collection(db, ...wsPath("chats", uid, "messages")),
    orderBy("timestamp", "asc")
  );
  unsubMessages = onSnapshot(q, (snap) => {
    messagesEl.innerHTML = "";
    let lastDate = null;
    snap.forEach((docSnap) => {
      const m = docSnap.data();
      const dateLabel = formatDateWIB(m.timestamp);
      if (dateLabel && dateLabel !== lastDate) {
        messagesEl.appendChild(createDateDivider(dateLabel));
        lastDate = dateLabel;
      }
      messagesEl.appendChild(renderMessage(m, docSnap.id));
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

async function touchCustomerDoc(lastMessage) {
  await setDoc(
    doc(db, ...wsPath("customers", activeCustomerUid)),
    {
      lastMessage,
      lastMessageAt: serverTimestamp(),
      lastSender: "admin",
      unreadCount: 0,
      archived: false,
      archivedAt: null,
      expireAt: null
    },
    { merge: true }
  );
}

// Dipanggil habis edit/hapus 1 pesan supaya preview "pesan terakhir" di
// daftar customer (sidebar) tidak ketinggalan nunjukin teks yang sudah
// diedit/dihapus -- beda dari touchCustomerDoc() yang khusus buat pesan BARU
// dari admin (reset unreadCount, buka arsip, dst), ini cuma nyamain preview
// dengan pesan yang BENERAN masih ada sekarang, tidak nyentuh field lain.
async function refreshLastMessagePreview(uid) {
  try {
    const snap = await getDocs(
      query(collection(db, ...wsPath("chats", uid, "messages")), orderBy("timestamp", "desc"), limit(1))
    );
    const last = snap.docs[0] && snap.docs[0].data();
    const preview = !last ? "" : last.type === "image" ? "📷 Gambar" : last.text || "";

    await setDoc(
      doc(db, ...wsPath("customers", uid)),
      {
        lastMessage: preview,
        lastMessageAt: last ? last.timestamp : null,
        lastSender: last ? last.sender : null
      },
      { merge: true }
    );
  } catch (err) {
    console.error("Gagal memperbarui preview pesan terakhir:", err);
  }
}

function indexSearchText(uid, text) {
  if (!text) return;
  setDoc(doc(db, ...wsPath("customers", uid)), { searchText: arrayUnion(text) }, { merge: true }).catch(() => {});
}

// SATU-SATUNYA titik yang boleh addDoc ke chats/{uid}/messages dari sisi
// admin. Kalau messageData ada field `text`, otomatis ikut terindeks ke
// searchText -- jenis pesan admin baru nanti tidak akan lagi kelewatan
// diindeks (lihat catatan yang sama di customer.js).
async function writeMessage(uid, messageData) {
  await addDoc(collection(db, ...wsPath("chats", uid, "messages")), messageData);
  if (messageData.text) indexSearchText(uid, messageData.text);
}

messageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !activeCustomerUid) return;
  messageInput.value = "";
  autoResizeMessageInput();

  try {
    await writeMessage(activeCustomerUid, {
      sender: "admin",
      senderId: currentAdmin.uid,
      type: "text",
      text,
      senderName: currentAdmin.name,
      senderPhoto: currentAdmin.photo || null,
      timestamp: serverTimestamp()
    });
    recordFirstResponseIfNeeded(activeCustomerUid);
    await touchCustomerDoc(text);
    bumpStat("messageCount");
    bumpStat("adminMessageCount");
  } catch (err) {
    alert("Gagal mengirim balasan: " + err.message);
  }
});

// Dipakai baik oleh input file (klik ikon 🖼️) maupun paste screenshot
// (Ctrl+V) langsung di kolom balas -- lihat listener "paste" di bawah.
async function sendImageFile(file) {
  if (!file || !activeCustomerUid) return;

  // Ditangkap di awal supaya kalau admin sempat pindah ke chat lain sementara
  // dialog konfirmasi masih terbuka, gambarnya tetap terkirim ke customer
  // yang dituju semula -- bukan ke chat yang lagi aktif pas tombol Kirim
  // diklik.
  const targetUid = activeCustomerUid;

  let dataUrl;
  try {
    dataUrl = await compressImageFile(file, { maxDimension: 1200, maxDataUrlLength: 700000 });
  } catch (err) {
    alert(err.message || "Gagal memproses gambar.");
    return;
  }

  // Kasih preview dulu sebelum beneran kekirim ke chat -- jangan langsung
  // nyelonong begitu file dipilih/di-paste, admin bisa batal.
  const confirmed = await showImageSendConfirm(dataUrl);
  if (!confirmed) return;

  // Dialognya bisa terbuka cukup lama -- kalau admin sempat pindah ke chat
  // lain sebelum klik Kirim, batalkan daripada nyasar terkirim ke customer
  // yang salah (touchCustomerDoc() di bawah cuma tahu activeCustomerUid
  // saat ini, bukan target semula).
  if (activeCustomerUid !== targetUid) {
    alert("Chat aktif sudah berpindah, gambar tidak dikirim. Silakan kirim ulang.");
    return;
  }

  try {
    await writeMessage(targetUid, {
      sender: "admin",
      senderId: currentAdmin.uid,
      type: "image",
      imageBase64: dataUrl,
      senderName: currentAdmin.name,
      senderPhoto: currentAdmin.photo || null,
      timestamp: serverTimestamp()
    });
    recordFirstResponseIfNeeded(targetUid);
    await touchCustomerDoc("📷 Gambar");
    bumpStat("messageCount");
    bumpStat("adminMessageCount");
  } catch (err) {
    alert(err.message || "Gagal mengirim gambar.");
  }
}

imageInput.addEventListener("change", async () => {
  const file = imageInput.files[0];
  imageInput.value = "";
  await sendImageFile(file);
});

// Ctrl+V screenshot/gambar langsung di kolom balas -- tidak perlu klik ikon
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

// Cari workspace tempat uid ini terdaftar sebagai admin, lewat penunjuk
// adminIndex/{uid} (dibuat manual oleh pemilik platform lewat Console).
async function resolveAdminWorkspace(uid) {
  const indexSnap = await getDoc(doc(db, "adminIndex", uid));
  if (!indexSnap.exists() || !indexSnap.data().workspaceId) return null;
  const workspaceId = indexSnap.data().workspaceId;

  const adminSnap = await getDoc(doc(db, "workspaces", workspaceId, "admins", uid));
  if (!adminSnap.exists()) return null;

  return { workspaceId, adminData: adminSnap.data() };
}

loginBtn.addEventListener("click", async () => {
  ensureAudio(); // buka/unlock audio di dalam gesture klik user
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  if (!email || !password) {
    showLoginError("Email dan password wajib diisi.");
    return;
  }

  loginBtn.disabled = true;
  loginError.classList.add("hidden");

  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const resolved = await resolveAdminWorkspace(cred.user.uid);
    if (!resolved) {
      await signOut(auth);
      showLoginError("Akun ini bukan admin workspace mana pun.");
      loginBtn.disabled = false;
      return;
    }
    await enterDashboard(cred.user.uid, cred.user.email, resolved.workspaceId, resolved.adminData);
  } catch (err) {
    showLoginError("Gagal masuk: " + err.message);
    loginBtn.disabled = false;
  }
});

passwordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loginBtn.click();
});

settingsLogoutBtn.addEventListener("click", async () => {
  if (unsubMessages) unsubMessages();
  if (unsubSavedReplies) unsubSavedReplies();
  if (autoArchiveIntervalId) {
    clearInterval(autoArchiveIntervalId);
    autoArchiveIntervalId = null;
  }
  if (presenceIntervalId) {
    clearInterval(presenceIntervalId);
    presenceIntervalId = null;
  }
  window.location.hash = "";
  await signOut(auth);
  currentAdmin = null;
  updateTabNotification(0);
  activeCustomerUid = null;
  activeCustomerName = "";
  lastKnownTimestamps.clear();
  customersDataMap.clear();
  customersInitialLoadDone = false;
  currentListView = "active";
  searchQuery = "";
  customerSearchInput.value = "";
  tabActiveBtn.classList.add("active");
  tabAllBtn.classList.remove("active");
  tabArchivedBtn.classList.remove("active");
  railUnreadBadge.classList.add("hidden");
  settingsProfileView.classList.add("hidden");
  settingsAppearanceView.classList.add("hidden");
  settingsAutochatView.classList.add("hidden");
  settingsHistoryView.classList.add("hidden");
  settingsHoursView.classList.add("hidden");
  savedRepliesOverlay.classList.add("hidden");
  statsView.classList.add("hidden");
  customerPanel.classList.add("hidden");
  infoToggleBtn.classList.add("hidden");
  appScreen.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  emailInput.value = "";
  passwordInput.value = "";
  loginBtn.disabled = false;
  sidebarAvatarEl.style.backgroundImage = "";
  sidebarAvatarEl.textContent = "";
});

customerSearchInput.addEventListener("input", () => {
  searchQuery = customerSearchInput.value.trim();
  renderCustomerList();
});

// --- Routing berbasis hash (#/open, #/all, #/archived, #/stats, #/settings)
// supaya tiap menu punya link sendiri, bisa di-refresh/bookmark/share. ---

function setListView(view) {
  currentListView = view;
  tabActiveBtn.classList.toggle("active", view === "active");
  tabAllBtn.classList.toggle("active", view === "all");
  tabArchivedBtn.classList.toggle("active", view === "archived");
  renderCustomerList();
}

function navigateTo(route) {
  if (window.location.hash === "#/" + route) {
    applyRoute();
  } else {
    window.location.hash = "#/" + route;
  }
}

function applyRoute() {
  if (!currentAdmin) return;

  const route = window.location.hash.replace(/^#\/?/, "") || "open";
  settingsProfileView.classList.add("hidden");
  settingsAppearanceView.classList.add("hidden");
  settingsAutochatView.classList.add("hidden");
  settingsHistoryView.classList.add("hidden");
  settingsHoursView.classList.add("hidden");
  statsView.classList.add("hidden");

  if (route === "settings" || route === "settings/profile") {
    openProfileSettings();
    return;
  }
  if (route === "settings/appearance") {
    openAppearanceSettings();
    return;
  }
  if (route === "settings/autochat") {
    openAutochatSettings();
    return;
  }
  if (route === "settings/history") {
    openHistorySettings();
    return;
  }
  if (route === "settings/hours") {
    openHoursSettings();
    return;
  }
  if (route === "stats") {
    openStats();
    return;
  }

  appScreen.classList.remove("hidden");
  const view = route === "open" ? "active" : route;
  if (view !== "active" && view !== "all" && view !== "archived") return;
  setListView(view);
}

window.addEventListener("hashchange", applyRoute);

tabActiveBtn.addEventListener("click", () => navigateTo("open"));
tabAllBtn.addEventListener("click", () => navigateTo("all"));
tabArchivedBtn.addEventListener("click", () => navigateTo("archived"));

infoToggleBtn.addEventListener("click", () => {
  customerPanel.classList.toggle("hidden");
});

infoCloseBtn.addEventListener("click", () => {
  customerPanel.classList.add("hidden");
});

// --- Pengaturan (nama tampilan & foto profil admin, appearance widget) ---

function openProfileSettings() {
  appScreen.classList.add("hidden");
  pendingPhotoDataUrl = null;
  displayNameInput.value = currentAdmin.name !== currentAdmin.email ? currentAdmin.name : "";
  renderAvatar(avatarPreview, currentAdmin.photo, currentAdmin.name);
  settingsError.classList.add("hidden");
  settingsProfileView.classList.remove("hidden");
}

function renderImagePreview(el, dataUrl, placeholderText) {
  if (dataUrl) {
    el.style.backgroundImage = `url(${dataUrl})`;
    el.textContent = "";
  } else {
    el.style.backgroundImage = "";
    el.textContent = placeholderText;
  }
}

function openAppearanceSettings() {
  appScreen.classList.add("hidden");
  appearanceBrandInput.value = currentAdmin.workspaceBrandName || "";
  appearanceColorInput.value = currentAdmin.workspaceThemeColor || "#5b8cff";
  appearanceColorText.value = currentAdmin.workspaceThemeColor || "#5b8cff";
  appearanceIconInput.value = currentAdmin.workspaceBubbleIcon || "💬";

  pendingBubbleImageDataUrl = undefined;
  pendingHeaderLogoDataUrl = undefined;
  renderImagePreview(bubbleImagePreview, currentAdmin.workspaceBubbleImage, "Emoji");
  renderImagePreview(headerLogoPreview, currentAdmin.workspaceHeaderLogo, "Tanpa logo");
  appearanceAnimationSelect.value = currentAdmin.workspaceBubbleAnimation || "none";

  proactiveEnabledInput.checked = !!currentAdmin.proactiveGreetingEnabled;
  proactiveTextInput.value = currentAdmin.proactiveGreetingText || "";
  proactiveDelayInput.value = currentAdmin.proactiveGreetingDelay || 4;

  appearanceError.classList.add("hidden");
  settingsAppearanceView.classList.remove("hidden");
}

function openAutochatSettings() {
  appScreen.classList.add("hidden");
  autochatEnabledInput.checked = !!currentAdmin.autoGreetingEnabled;
  autochatMessageInput.value = currentAdmin.autoGreetingMessage || "";
  autochatOptionsInput.value = formatAutochatOptionsForTextarea(
    currentAdmin.autoGreetingOptions,
    currentAdmin.autoGreetingOptionReplies
  );
  autochatError.classList.add("hidden");
  settingsAutochatView.classList.remove("hidden");
}

async function openHistorySettings() {
  appScreen.classList.add("hidden");
  settingsHistoryView.classList.remove("hidden");
  historyLogList.innerHTML = "";
  historyLogEmpty.classList.add("hidden");

  try {
    const q = query(collection(db, ...wsPath("deletionLogs")), orderBy("deletedAt", "desc"), limit(100));
    const snap = await getDocs(q);

    if (snap.empty) {
      historyLogEmpty.classList.remove("hidden");
      return;
    }

    snap.forEach((docSnap) => {
      const data = docSnap.data();
      const li = document.createElement("li");
      li.className = "history-log-item";

      const icon = document.createElement("span");
      icon.className = "history-log-icon";
      icon.textContent = "🗑";
      li.appendChild(icon);

      const body = document.createElement("div");
      body.className = "history-log-body";

      const title = document.createElement("span");
      title.className = "history-log-title";
      title.textContent = `Chat dengan "${data.customerName || "?"}" dihapus`;
      body.appendChild(title);

      const meta = document.createElement("span");
      meta.className = "history-log-meta";
      const when = formatDateWIB(data.deletedAt) + ", " + formatTimeWIB(data.deletedAt);
      meta.textContent =
        `Oleh ${data.deletedByName || "?"} • ${when} • ${data.messageCount ?? 0} pesan`;
      body.appendChild(meta);

      li.appendChild(body);
      li.addEventListener("click", () => openHistoryDetail(docSnap.id, data.customerName));
      historyLogList.appendChild(li);
    });
  } catch (err) {
    historyLogEmpty.textContent = "Gagal memuat riwayat: " + err.message;
    historyLogEmpty.classList.remove("hidden");
  }
}

function openHoursSettings() {
  appScreen.classList.add("hidden");
  hoursEnabledInput.checked = !!currentAdmin.businessHoursEnabled;
  const activeDays = currentAdmin.businessHoursDays || [];
  hoursDayCheckboxes.forEach((cb) => {
    cb.checked = activeDays.includes(cb.value);
  });
  hoursStartInput.value = currentAdmin.businessHoursStart || "09:00";
  hoursEndInput.value = currentAdmin.businessHoursEnd || "17:00";
  hoursOfflineMessageInput.value = currentAdmin.offlineMessage || "";
  hoursError.classList.add("hidden");
  settingsHoursView.classList.remove("hidden");
}

// Versi baca-saja dari renderMessage(), dipakai buat nampilin pesan yang
// sudah diarsipkan di deletionLogs/{logId}/messages -- tidak ada tombol edit
// atau hapus (memang sengaja permanen), dan label "Anda" diganti nama admin
// pengirim asli karena yang buka riwayat belum tentu admin yang sama.
function renderArchivedMessage(m, customerName) {
  const div = document.createElement("div");
  div.className = "message " + (m.sender === "admin" ? "mine" : "theirs");

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
  senderLabel.textContent = m.sender === "admin" ? m.senderName || "Admin" : customerName || "Customer";
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
      const tag = document.createElement("span");
      tag.className = "option-btn option-tag";
      tag.textContent = opt;
      optWrap.appendChild(tag);
    });
    div.appendChild(optWrap);
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

let historyDetailExportDocs = [];
let historyDetailExportName = "";

async function openHistoryDetail(logId, customerName) {
  historyDetailTitle.textContent = `Riwayat Chat dengan "${customerName || "?"}"`;
  historyDetailMessages.innerHTML = "";
  historyDetailOverlay.classList.remove("hidden");
  historyDetailExportDocs = [];
  historyDetailExportName = customerName || "";

  try {
    const q = query(
      collection(db, ...wsPath("deletionLogs", logId, "messages")),
      orderBy("timestamp", "asc")
    );
    const snap = await getDocs(q);
    historyDetailExportDocs = snap.docs;

    if (snap.empty) {
      const empty = document.createElement("p");
      empty.className = "saved-reply-empty";
      empty.textContent = "Tidak ada pesan tersimpan untuk riwayat ini.";
      historyDetailMessages.appendChild(empty);
      return;
    }

    let lastDate = null;
    snap.forEach((docSnap) => {
      const m = docSnap.data();
      const dateLabel = formatDateWIB(m.timestamp);
      if (dateLabel && dateLabel !== lastDate) {
        historyDetailMessages.appendChild(createDateDivider(dateLabel));
        lastDate = dateLabel;
      }
      historyDetailMessages.appendChild(renderArchivedMessage(m, customerName));
    });
  } catch (err) {
    const errEl = document.createElement("p");
    errEl.className = "saved-reply-empty";
    errEl.textContent = "Gagal memuat isi chat: " + err.message;
    historyDetailMessages.appendChild(errEl);
  }
}

historyDetailCloseBtn.addEventListener("click", () => {
  historyDetailOverlay.classList.add("hidden");
});

historyDetailExportBtn.addEventListener("click", () => {
  if (historyDetailExportDocs.length === 0) {
    alert("Tidak ada pesan untuk diekspor.");
    return;
  }
  downloadTextFile(
    `chat-${safeFileNamePart(historyDetailExportName)}-arsip-${Date.now()}.txt`,
    messagesToTranscript(historyDetailExportName, historyDetailExportDocs)
  );
});

historyDetailOverlay.addEventListener("click", (e) => {
  if (e.target === historyDetailOverlay) historyDetailOverlay.classList.add("hidden");
});

settingsBtn.addEventListener("click", () => {
  navigateTo("settings/profile");
});

document.querySelectorAll(".settings-back-btn").forEach((btn) => {
  btn.addEventListener("click", () => navigateTo("open"));
});

appearanceColorInput.addEventListener("input", () => {
  appearanceColorText.value = appearanceColorInput.value;
});

appearanceColorText.addEventListener("input", () => {
  if (/^#[0-9a-fA-F]{6}$/.test(appearanceColorText.value)) {
    appearanceColorInput.value = appearanceColorText.value;
  }
});

bubbleImageInput.addEventListener("change", async () => {
  const file = bubbleImageInput.files[0];
  bubbleImageInput.value = "";
  if (!file) return;

  try {
    // Ikon bubble muncul di setiap halaman website perusahaan, jadi
    // dijaga kecil (maks 200px / ~120KB) supaya tidak memperlambat loading
    // situs mereka -- GIF dilewatkan apa adanya (lihat compressImageOrPassthroughGif)
    // supaya animasinya tidak hilang, tapi dibatasi ukuran filenya sendiri.
    pendingBubbleImageDataUrl = await compressImageOrPassthroughGif(file, {
      maxDimension: 200,
      maxDataUrlLength: 120000,
      maxGifBytes: 200000
    });
    renderImagePreview(bubbleImagePreview, pendingBubbleImageDataUrl, "Emoji");
  } catch (err) {
    appearanceError.textContent = err.message || "Gagal memproses gambar.";
    appearanceError.classList.remove("hidden");
  }
});

bubbleImageRemoveBtn.addEventListener("click", () => {
  pendingBubbleImageDataUrl = null;
  renderImagePreview(bubbleImagePreview, null, "Emoji");
});

headerLogoInput.addEventListener("change", async () => {
  const file = headerLogoInput.files[0];
  headerLogoInput.value = "";
  if (!file) return;

  try {
    pendingHeaderLogoDataUrl = await compressImageFile(file, { maxDimension: 300, maxDataUrlLength: 150000 });
    renderImagePreview(headerLogoPreview, pendingHeaderLogoDataUrl, "Tanpa logo");
  } catch (err) {
    appearanceError.textContent = err.message || "Gagal memproses gambar.";
    appearanceError.classList.remove("hidden");
  }
});

headerLogoRemoveBtn.addEventListener("click", () => {
  pendingHeaderLogoDataUrl = null;
  renderImagePreview(headerLogoPreview, null, "Tanpa logo");
});

appearanceSaveBtn.addEventListener("click", async () => {
  const brandName = appearanceBrandInput.value.trim();
  const themeColor = appearanceColorText.value.trim();
  const bubbleIcon = appearanceIconInput.value.trim();
  const bubbleAnimation = appearanceAnimationSelect.value;
  const proactiveGreetingEnabled = proactiveEnabledInput.checked;
  const proactiveGreetingText = proactiveTextInput.value.trim();
  const proactiveGreetingDelay = Math.min(60, Math.max(1, Number(proactiveDelayInput.value) || 4));

  if (!/^#[0-9a-fA-F]{6}$/.test(themeColor)) {
    appearanceError.textContent = "Warna tema harus format hex, mis. #5b8cff.";
    appearanceError.classList.remove("hidden");
    return;
  }
  if (proactiveGreetingEnabled && !proactiveGreetingText) {
    appearanceError.textContent = "Isi dulu teks sapaannya sebelum mengaktifkan sapaan otomatis.";
    appearanceError.classList.remove("hidden");
    return;
  }

  appearanceSaveBtn.disabled = true;
  appearanceError.classList.add("hidden");

  try {
    const update = {
      brandName: brandName || currentAdmin.workspaceName || "",
      themeColor,
      bubbleIcon: bubbleIcon || "💬",
      bubbleAnimation,
      proactiveGreetingEnabled,
      proactiveGreetingText,
      proactiveGreetingDelay
    };
    // undefined = tidak disentuh sama sekali (biarkan nilai lama di
    // Firestore), null = eksplisit dihapus (balik ke emoji/tanpa logo).
    if (pendingBubbleImageDataUrl !== undefined) update.bubbleImageBase64 = pendingBubbleImageDataUrl;
    if (pendingHeaderLogoDataUrl !== undefined) update.headerLogoBase64 = pendingHeaderLogoDataUrl;

    await setDoc(doc(db, ...wsPath()), update, { merge: true });

    currentAdmin.workspaceBrandName = brandName;
    currentAdmin.workspaceThemeColor = themeColor;
    currentAdmin.workspaceBubbleIcon = bubbleIcon || "💬";
    currentAdmin.workspaceBubbleAnimation = bubbleAnimation;
    currentAdmin.proactiveGreetingEnabled = proactiveGreetingEnabled;
    currentAdmin.proactiveGreetingText = proactiveGreetingText;
    currentAdmin.proactiveGreetingDelay = proactiveGreetingDelay;
    if (pendingBubbleImageDataUrl !== undefined) currentAdmin.workspaceBubbleImage = pendingBubbleImageDataUrl;
    if (pendingHeaderLogoDataUrl !== undefined) currentAdmin.workspaceHeaderLogo = pendingHeaderLogoDataUrl;
    navigateTo("open");
  } catch (err) {
    appearanceError.textContent = "Gagal menyimpan: " + err.message;
    appearanceError.classList.remove("hidden");
  } finally {
    appearanceSaveBtn.disabled = false;
  }
});

autochatSaveBtn.addEventListener("click", async () => {
  const enabled = autochatEnabledInput.checked;
  const message = autochatMessageInput.value.trim();
  const { options, optionReplies } = parseAutochatOptions(autochatOptionsInput.value);

  if (enabled && !message) {
    autochatError.textContent = "Isi dulu pesan sapaannya sebelum mengaktifkan.";
    autochatError.classList.remove("hidden");
    return;
  }

  autochatSaveBtn.disabled = true;
  autochatError.classList.add("hidden");

  try {
    await setDoc(
      doc(db, ...wsPath()),
      {
        autoGreetingEnabled: enabled,
        autoGreetingMessage: message,
        autoGreetingOptions: options,
        autoGreetingOptionReplies: optionReplies
      },
      { merge: true }
    );
    currentAdmin.autoGreetingEnabled = enabled;
    currentAdmin.autoGreetingMessage = message;
    currentAdmin.autoGreetingOptions = options;
    currentAdmin.autoGreetingOptionReplies = optionReplies;
    navigateTo("open");
  } catch (err) {
    autochatError.textContent = "Gagal menyimpan: " + err.message;
    autochatError.classList.remove("hidden");
  } finally {
    autochatSaveBtn.disabled = false;
  }
});

hoursSaveBtn.addEventListener("click", async () => {
  const enabled = hoursEnabledInput.checked;
  const days = Array.from(hoursDayCheckboxes)
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);
  const start = hoursStartInput.value || "09:00";
  const end = hoursEndInput.value || "17:00";
  const offlineMessage = hoursOfflineMessageInput.value.trim();

  if (enabled && days.length === 0) {
    hoursError.textContent = "Pilih minimal 1 hari buka sebelum mengaktifkan.";
    hoursError.classList.remove("hidden");
    return;
  }
  if (enabled && start >= end) {
    hoursError.textContent = "Jam buka harus lebih awal dari jam tutup.";
    hoursError.classList.remove("hidden");
    return;
  }

  hoursSaveBtn.disabled = true;
  hoursError.classList.add("hidden");

  try {
    await setDoc(
      doc(db, ...wsPath()),
      {
        businessHoursEnabled: enabled,
        businessHoursDays: days,
        businessHoursStart: start,
        businessHoursEnd: end,
        offlineMessage
      },
      { merge: true }
    );
    currentAdmin.businessHoursEnabled = enabled;
    currentAdmin.businessHoursDays = days;
    currentAdmin.businessHoursStart = start;
    currentAdmin.businessHoursEnd = end;
    currentAdmin.offlineMessage = offlineMessage;
    navigateTo("open");
  } catch (err) {
    hoursError.textContent = "Gagal menyimpan: " + err.message;
    hoursError.classList.remove("hidden");
  } finally {
    hoursSaveBtn.disabled = false;
  }
});

photoInput.addEventListener("change", async () => {
  const file = photoInput.files[0];
  photoInput.value = "";
  if (!file) return;

  try {
    pendingPhotoDataUrl = await compressImageFile(file, { maxDimension: 300, maxDataUrlLength: 150000 });
    renderAvatar(avatarPreview, pendingPhotoDataUrl, displayNameInput.value);
  } catch (err) {
    settingsError.textContent = err.message || "Gagal memproses foto.";
    settingsError.classList.remove("hidden");
  }
});

settingsSaveBtn.addEventListener("click", async () => {
  const name = displayNameInput.value.trim();
  settingsSaveBtn.disabled = true;
  settingsError.classList.add("hidden");

  try {
    const update = { name: name || currentAdmin.email };
    if (pendingPhotoDataUrl) update.photo = pendingPhotoDataUrl;

    await setDoc(doc(db, ...wsPath("admins", currentAdmin.uid)), update, { merge: true });

    currentAdmin.name = update.name;
    if (pendingPhotoDataUrl) currentAdmin.photo = pendingPhotoDataUrl;
    adminEmailEl.textContent = currentAdmin.name;
    renderAvatar(sidebarAvatarEl, currentAdmin.photo, currentAdmin.name);
    navigateTo("open");
  } catch (err) {
    settingsError.textContent = "Gagal menyimpan: " + err.message;
    settingsError.classList.remove("hidden");
  } finally {
    settingsSaveBtn.disabled = false;
  }
});

// Cek sesi login tersimpan dulu (tampilkan layar "Memuat...") sebelum
// memutuskan mau tampilkan dashboard atau form login, supaya tidak ada
// kedipan form login sesaat sebelum auto-login selesai diproses.
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    loadingScreen.classList.add("hidden");
    if (!currentAdmin) loginScreen.classList.remove("hidden");
    return;
  }
  if (currentAdmin) return;

  try {
    const resolved = await resolveAdminWorkspace(user.uid);
    if (resolved) {
      await enterDashboard(user.uid, user.email, resolved.workspaceId, resolved.adminData);
    } else {
      console.warn("Auto re-enter dashboard: uid ini tidak terdaftar di adminIndex/workspace manapun.", user.uid);
      loginScreen.classList.remove("hidden");
    }
  } catch (err) {
    console.error("Auto re-enter dashboard gagal:", err);
    loginScreen.classList.remove("hidden");
  } finally {
    loadingScreen.classList.add("hidden");
  }
});

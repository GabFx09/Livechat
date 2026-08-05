import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  orderBy,
  onSnapshot,
  addDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { compressImageFile, showImageLightbox } from "./image-utils.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentAdmin = null; // { uid, email, name, photo, workspaceId, workspaceName }
let activeCustomerUid = null;
let activeCustomerName = "";
let unsubMessages = null;
let lastKnownTimestamps = new Map();
let customersInitialLoadDone = false;
let customersDataMap = new Map();
let currentListView = "active"; // "active" | "archived"
let autoArchiveIntervalId = null;

const AUTO_ARCHIVE_MS = 30 * 60 * 1000; // 30 menit tanpa pesan baru -> otomatis diarsipkan

function wsPath(...segments) {
  return ["workspaces", currentAdmin.workspaceId, ...segments];
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
const logoutBtn = document.getElementById("logout-btn");
const customerListEl = document.getElementById("customer-list");
const messagesEl = document.getElementById("messages");
const typingPreviewEl = document.getElementById("typing-preview");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const imageInput = document.getElementById("image-input");
const chatHeaderText = document.getElementById("chat-header-text");
const infoToggleBtn = document.getElementById("info-toggle-btn");
const infoCloseBtn = document.getElementById("info-close-btn");
const customerPanel = document.getElementById("customer-panel");
const customerPanelBody = document.getElementById("customer-panel-body");
const tabActiveBtn = document.getElementById("tab-active-btn");
const tabArchivedBtn = document.getElementById("tab-archived-btn");
const railUnreadBadge = document.getElementById("rail-unread-badge");

const settingsBtn = document.getElementById("settings-btn");
const settingsOverlay = document.getElementById("settings-overlay");
const avatarPreview = document.getElementById("avatar-preview");
const photoInput = document.getElementById("photo-input");
const displayNameInput = document.getElementById("display-name-input");
const settingsSaveBtn = document.getElementById("settings-save-btn");
const settingsCancelBtn = document.getElementById("settings-cancel-btn");
const settingsError = document.getElementById("settings-error");

const savedRepliesBtn = document.getElementById("saved-replies-btn");
const savedRepliesOverlay = document.getElementById("saved-replies-overlay");
const savedRepliesList = document.getElementById("saved-replies-list");
const savedReplyForm = document.getElementById("saved-reply-form");
const savedReplyInput = document.getElementById("saved-reply-input");
const savedRepliesCloseBtn = document.getElementById("saved-replies-close-btn");
const replySuggestionsEl = document.getElementById("reply-suggestions");

let unsubSavedReplies = null;
let savedRepliesCache = [];
let suggestionMatches = [];
let suggestionIndex = -1;

let pendingPhotoDataUrl = null;

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

// Browser mengunci audio sampai ada interaksi pengguna. Selain saat klik
// tombol "Masuk", kita juga buka lewat interaksi pertama apa pun di halaman
// (penting untuk kasus admin sudah otomatis login lewat sesi tersimpan).
function unlockAudioOnFirstInteraction() {
  ensureAudio();
}
document.addEventListener("click", unlockAudioOnFirstInteraction);
document.addEventListener("keydown", unlockAudioOnFirstInteraction);

// Pindah chat customer dengan Alt + panah atas/bawah (panah polos dipakai
// untuk navigasi saran saved replies di kolom pesan).
document.addEventListener("keydown", (e) => {
  if (!currentAdmin) return;
  if (!e.altKey) return;
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  if (!settingsOverlay.classList.contains("hidden")) return;

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
      currentAdmin.workspaceName = wsSnap.data().name || null;
      if (currentAdmin.workspaceName) document.title = currentAdmin.workspaceName + " - Admin";
    }
  } catch (err) {
    // biarkan, tidak krusial
  }

  listenCustomers();
  listenSavedReplies();

  if (autoArchiveIntervalId) clearInterval(autoArchiveIntervalId);
  autoArchiveIntervalId = setInterval(checkAutoArchive, 60000);
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
  closeSuggestions();
  messageInput.focus();
}

function closeSuggestions() {
  suggestionMatches = [];
  suggestionIndex = -1;
  replySuggestionsEl.classList.add("hidden");
  replySuggestionsEl.innerHTML = "";
}

messageInput.addEventListener("input", () => {
  suggestionMatches = findSuggestionMatches(messageInput.value);
  suggestionIndex = suggestionMatches.length > 0 ? 0 : -1;
  renderSuggestions();
});

messageInput.addEventListener("keydown", (e) => {
  if (suggestionMatches.length === 0) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    suggestionIndex = (suggestionIndex + 1) % suggestionMatches.length;
    renderSuggestions();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    suggestionIndex = (suggestionIndex - 1 + suggestionMatches.length) % suggestionMatches.length;
    renderSuggestions();
  } else if (e.key === "Enter") {
    e.preventDefault();
    selectSuggestion(suggestionIndex);
  } else if (e.key === "Escape") {
    closeSuggestions();
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

async function toggleArchive(uid, archived) {
  try {
    const update = archived
      ? { archived: true, archivedAt: serverTimestamp(), expireAt: oneYearFromNow() }
      : { archived: false, archivedAt: null, expireAt: null };
    await setDoc(doc(db, ...wsPath("customers", uid)), update, { merge: true });
  } catch (err) {
    alert("Gagal mengubah status arsip: " + err.message);
  }
}

function listenCustomers() {
  const q = query(collection(db, ...wsPath("customers")), orderBy("lastMessageAt", "desc"));
  onSnapshot(q, (snap) => {
    let shouldPlaySound = false;
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
      }
      lastKnownTimestamps.set(uid, newMillis);
    });

    if (shouldPlaySound) playNotificationSound();
    customersInitialLoadDone = true;

    renderCustomerList();
    updateRailBadge();
    updateTypingPreview();
    checkAutoArchive();

    if (activeCustomerUid && customersDataMap.has(activeCustomerUid)) {
      renderCustomerPanel(customersDataMap.get(activeCustomerUid), activeCustomerUid);
    }
  });
}

function getVisibleCustomerEntries() {
  const entries = [];
  customersDataMap.forEach((data, uid) => {
    const isArchived = !!data.archived;
    if (currentListView === "archived" && !isArchived) return;
    if (currentListView === "active" && isArchived) return;
    entries.push({ uid, name: data.name });
  });
  return entries;
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
}

function renderCustomerList() {
  customerListEl.innerHTML = "";

  customersDataMap.forEach((data, uid) => {
    const isArchived = !!data.archived;
    if (currentListView === "archived" && !isArchived) return;
    if (currentListView === "active" && isArchived) return;

    const unreadCount = isArchived ? 0 : data.unreadCount || 0;
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

  const archiveBtn = document.createElement("button");
  archiveBtn.type = "button";
  archiveBtn.className = "archive-btn";
  archiveBtn.textContent = data.archived ? "Pulihkan dari Arsip" : "Arsipkan Percakapan";
  archiveBtn.addEventListener("click", () => toggleArchive(uid, !data.archived));
  customerPanelBody.appendChild(archiveBtn);
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
  } catch (err) {
    alert("Gagal menghapus pesan: " + err.message);
  }
}

function openCustomer(uid, name) {
  activeCustomerUid = uid;
  activeCustomerName = name;
  chatHeaderText.textContent = "Chat dengan " + name;
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
    snap.forEach((docSnap) => {
      messagesEl.appendChild(renderMessage(docSnap.data(), docSnap.id));
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

messageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !activeCustomerUid) return;
  messageInput.value = "";

  try {
    await addDoc(collection(db, ...wsPath("chats", activeCustomerUid, "messages")), {
      sender: "admin",
      senderId: currentAdmin.uid,
      type: "text",
      text,
      senderName: currentAdmin.name,
      senderPhoto: currentAdmin.photo || null,
      timestamp: serverTimestamp()
    });
    await touchCustomerDoc(text);
  } catch (err) {
    alert("Gagal mengirim balasan: " + err.message);
  }
});

imageInput.addEventListener("change", async () => {
  const file = imageInput.files[0];
  imageInput.value = "";
  if (!file || !activeCustomerUid) return;

  try {
    const dataUrl = await compressImageFile(file, { maxDimension: 1200, maxDataUrlLength: 700000 });
    await addDoc(collection(db, ...wsPath("chats", activeCustomerUid, "messages")), {
      sender: "admin",
      senderId: currentAdmin.uid,
      type: "image",
      imageBase64: dataUrl,
      senderName: currentAdmin.name,
      senderPhoto: currentAdmin.photo || null,
      timestamp: serverTimestamp()
    });
    await touchCustomerDoc("📷 Gambar");
  } catch (err) {
    alert(err.message || "Gagal mengirim gambar.");
  }
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

logoutBtn.addEventListener("click", async () => {
  if (unsubMessages) unsubMessages();
  if (unsubSavedReplies) unsubSavedReplies();
  if (autoArchiveIntervalId) {
    clearInterval(autoArchiveIntervalId);
    autoArchiveIntervalId = null;
  }
  await signOut(auth);
  currentAdmin = null;
  activeCustomerUid = null;
  activeCustomerName = "";
  lastKnownTimestamps.clear();
  customersDataMap.clear();
  customersInitialLoadDone = false;
  currentListView = "active";
  tabActiveBtn.classList.add("active");
  tabArchivedBtn.classList.remove("active");
  railUnreadBadge.classList.add("hidden");
  settingsOverlay.classList.add("hidden");
  savedRepliesOverlay.classList.add("hidden");
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

tabActiveBtn.addEventListener("click", () => {
  currentListView = "active";
  tabActiveBtn.classList.add("active");
  tabArchivedBtn.classList.remove("active");
  renderCustomerList();
});

tabArchivedBtn.addEventListener("click", () => {
  currentListView = "archived";
  tabArchivedBtn.classList.add("active");
  tabActiveBtn.classList.remove("active");
  renderCustomerList();
});

infoToggleBtn.addEventListener("click", () => {
  customerPanel.classList.toggle("hidden");
});

infoCloseBtn.addEventListener("click", () => {
  customerPanel.classList.add("hidden");
});

// --- Pengaturan (nama tampilan & foto profil admin) ---

settingsBtn.addEventListener("click", () => {
  pendingPhotoDataUrl = null;
  displayNameInput.value = currentAdmin.name !== currentAdmin.email ? currentAdmin.name : "";
  renderAvatar(avatarPreview, currentAdmin.photo, currentAdmin.name);
  settingsError.classList.add("hidden");
  settingsOverlay.classList.remove("hidden");
});

settingsCancelBtn.addEventListener("click", () => {
  settingsOverlay.classList.add("hidden");
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
    settingsOverlay.classList.add("hidden");
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

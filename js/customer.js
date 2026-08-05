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
  increment
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { compressImageFile, showImageLightbox } from "./image-utils.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const workspaceId = new URLSearchParams(window.location.search).get("w");

let currentUser = null; // { uid, name }
let workspaceBrandName = null;

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
const brandNameEls = document.querySelectorAll("[data-brand-name]");

function wsPath(...segments) {
  return ["workspaces", workspaceId, ...segments];
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
  currentUser = { uid, name };
  loginScreen.classList.add("hidden");
  chatScreen.classList.remove("hidden");
  updateChatHeader();
  listenMessages();
}

function listenMessages() {
  const q = query(
    collection(db, ...wsPath("chats", currentUser.uid, "messages")),
    orderBy("timestamp", "asc")
  );
  onSnapshot(q, (snap) => {
    messagesEl.innerHTML = "";
    let latestAdminInfo = null;
    snap.forEach((docSnap) => {
      const m = docSnap.data();
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
      expireAt: null
    },
    { merge: true }
  );
}

messageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !currentUser) return;
  messageInput.value = "";

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
    await touchCustomerDoc(text);
  } catch (err) {
    console.error("Gagal setDoc ke customers/" + currentUser.uid + ":", err);
    alert("Gagal mengirim pesan (update profil customer): " + err.code + " - " + err.message);
  }
});

imageInput.addEventListener("change", async () => {
  const file = imageInput.files[0];
  imageInput.value = "";
  if (!file || !currentUser) return;

  try {
    const dataUrl = await compressImageFile(file, { maxDimension: 1200, maxDataUrlLength: 700000 });
    await addDoc(collection(db, ...wsPath("chats", currentUser.uid, "messages")), {
      sender: "customer",
      type: "image",
      imageBase64: dataUrl,
      timestamp: serverTimestamp()
    });
    await touchCustomerDoc("📷 Gambar");
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
    let user = auth.currentUser;
    if (!user) {
      const cred = await signInAnonymously(auth);
      user = cred.user;
    }
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
    enterChat(user.uid, name);
    captureVisitorInfo(user.uid);
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
    workspaceErrorScreen.classList.remove("hidden");
    loginScreen.classList.add("hidden");
    return;
  }

  try {
    const cred = auth.currentUser ? { user: auth.currentUser } : await signInAnonymously(auth);
    const wsSnap = await getDoc(doc(db, ...wsPath()));
    if (wsSnap.exists() && wsSnap.data().brandName) {
      applyBrandName(wsSnap.data().brandName);
    }

    // Auto rejoin kalau browser ini sudah pernah chat sebelumnya.
    const customerSnap = await getDoc(doc(db, ...wsPath("customers", cred.user.uid)));
    if (customerSnap.exists() && customerSnap.data().name) {
      enterChat(cred.user.uid, customerSnap.data().name);
      captureVisitorInfo(cred.user.uid);
    }
  } catch (err) {
    console.error("Gagal memuat workspace:", err);
  }
}

init();

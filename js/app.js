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
  updateDoc,
  getDoc,
  collection,
  query,
  orderBy,
  onSnapshot,
  addDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const HEARTBEAT_MS = 20000;
const ONLINE_THRESHOLD_MS = 60000;

let currentUser = null; // { uid, nickname }
let activeChatUid = null;
let unsubMessages = null;

const loginScreen = document.getElementById("login-screen");
const appScreen = document.getElementById("app-screen");
const nicknameInput = document.getElementById("nickname-input");
const loginBtn = document.getElementById("login-btn");
const loginError = document.getElementById("login-error");
const userListEl = document.getElementById("user-list");
const messagesEl = document.getElementById("messages");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const chatHeader = document.getElementById("chat-header");
const myNicknameEl = document.getElementById("my-nickname");

function chatIdFor(uidA, uidB) {
  return [uidA, uidB].sort().join("_");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function showLoginError(message) {
  loginError.textContent = message;
  loginError.classList.remove("hidden");
}

function enterApp(uid, nickname) {
  currentUser = { uid, nickname };
  myNicknameEl.textContent = nickname;
  loginScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
  startHeartbeat();
  listenUsers();
}

function startHeartbeat() {
  const touch = () =>
    updateDoc(doc(db, "users", currentUser.uid), { lastSeen: serverTimestamp() }).catch(() => {});
  touch();
  setInterval(touch, HEARTBEAT_MS);
}

function listenUsers() {
  onSnapshot(collection(db, "users"), (snap) => {
    userListEl.innerHTML = "";
    const now = Date.now();
    snap.forEach((docSnap) => {
      const uid = docSnap.id;
      if (uid === currentUser.uid) return;
      const data = docSnap.data();
      if (!data.nickname) return;

      const online =
        data.lastSeen && now - data.lastSeen.toMillis() < ONLINE_THRESHOLD_MS;

      const li = document.createElement("li");
      li.className = "user-item" + (uid === activeChatUid ? " active" : "");
      li.innerHTML =
        `<span class="dot ${online ? "online" : "offline"}"></span>` +
        `<span>${escapeHtml(data.nickname)}</span>`;
      li.addEventListener("click", () => openChat(uid, data.nickname));
      userListEl.appendChild(li);
    });
  });
}

function openChat(uid, nickname) {
  activeChatUid = uid;
  chatHeader.textContent = "Chat dengan " + nickname;
  messageForm.classList.remove("hidden");
  messageInput.focus();

  document.querySelectorAll(".user-item").forEach((el) => el.classList.remove("active"));

  if (unsubMessages) unsubMessages();

  const chatId = chatIdFor(currentUser.uid, uid);
  const q = query(
    collection(db, "chats", chatId, "messages"),
    orderBy("timestamp", "asc")
  );
  unsubMessages = onSnapshot(q, (snap) => {
    messagesEl.innerHTML = "";
    snap.forEach((docSnap) => {
      const m = docSnap.data();
      const div = document.createElement("div");
      div.className = "message " + (m.senderId === currentUser.uid ? "mine" : "theirs");
      div.innerHTML =
        `<span class="sender">${escapeHtml(m.senderName)}</span>` +
        `<p>${escapeHtml(m.text)}</p>`;
      messagesEl.appendChild(div);
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

messageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !activeChatUid || !currentUser) return;

  const chatId = chatIdFor(currentUser.uid, activeChatUid);
  messageInput.value = "";

  try {
    await addDoc(collection(db, "chats", chatId, "messages"), {
      senderId: currentUser.uid,
      senderName: currentUser.nickname,
      text,
      timestamp: serverTimestamp()
    });
  } catch (err) {
    alert("Gagal mengirim pesan: " + err.message);
  }
});

loginBtn.addEventListener("click", async () => {
  const nickname = nicknameInput.value.trim();
  if (!nickname) {
    showLoginError("Nama panggilan tidak boleh kosong.");
    return;
  }

  loginBtn.disabled = true;
  loginError.classList.add("hidden");

  try {
    let user = auth.currentUser;
    if (!user) {
      const cred = await signInAnonymously(auth);
      user = cred.user;
    }
    await setDoc(
      doc(db, "users", user.uid),
      { nickname, lastSeen: serverTimestamp() },
      { merge: true }
    );
    enterApp(user.uid, nickname);
  } catch (err) {
    showLoginError("Gagal masuk: " + err.message);
    loginBtn.disabled = false;
  }
});

nicknameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loginBtn.click();
});

// Auto rejoin if the browser already has an anonymous session with a saved nickname.
onAuthStateChanged(auth, async (user) => {
  if (!user || currentUser) return;
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (snap.exists() && snap.data().nickname) {
      enterApp(user.uid, snap.data().nickname);
    }
  } catch (err) {
    // Ignore: user will just see the login screen.
  }
});

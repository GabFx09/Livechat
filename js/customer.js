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
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentUser = null; // { uid, name }

const loginScreen = document.getElementById("login-screen");
const chatScreen = document.getElementById("chat-screen");
const nameInput = document.getElementById("name-input");
const startBtn = document.getElementById("start-btn");
const startError = document.getElementById("start-error");
const messagesEl = document.getElementById("messages");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function showStartError(message) {
  startError.textContent = message;
  startError.classList.remove("hidden");
}

function enterChat(uid, name) {
  currentUser = { uid, name };
  loginScreen.classList.add("hidden");
  chatScreen.classList.remove("hidden");
  listenMessages();
}

function listenMessages() {
  const q = query(
    collection(db, "chats", currentUser.uid, "messages"),
    orderBy("timestamp", "asc")
  );
  onSnapshot(q, (snap) => {
    messagesEl.innerHTML = "";
    snap.forEach((docSnap) => {
      const m = docSnap.data();
      const div = document.createElement("div");
      div.className = "message " + (m.sender === "customer" ? "mine" : "theirs");
      div.innerHTML =
        `<span class="sender">${m.sender === "customer" ? "Anda" : "Customer Service"}</span>` +
        `<p>${escapeHtml(m.text)}</p>`;
      messagesEl.appendChild(div);
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

messageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !currentUser) return;
  messageInput.value = "";

  try {
    await addDoc(collection(db, "chats", currentUser.uid, "messages"), {
      sender: "customer",
      text,
      timestamp: serverTimestamp()
    });
    await setDoc(
      doc(db, "customers", currentUser.uid),
      {
        name: currentUser.name,
        lastMessage: text,
        lastMessageAt: serverTimestamp(),
        lastSender: "customer"
      },
      { merge: true }
    );
  } catch (err) {
    alert("Gagal mengirim pesan: " + err.message);
  }
});

startBtn.addEventListener("click", async () => {
  const name = nameInput.value.trim();
  if (!name) {
    showStartError("Nama tidak boleh kosong.");
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
      doc(db, "customers", user.uid),
      {
        name,
        lastMessage: "",
        lastMessageAt: serverTimestamp(),
        lastSender: null
      },
      { merge: true }
    );
    enterChat(user.uid, name);
  } catch (err) {
    showStartError("Gagal memulai chat: " + err.message);
    startBtn.disabled = false;
  }
});

nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") startBtn.click();
});

// Auto rejoin if this browser already has a session with a saved name.
onAuthStateChanged(auth, async (user) => {
  if (!user || currentUser) return;
  try {
    const snap = await getDoc(doc(db, "customers", user.uid));
    if (snap.exists() && snap.data().name) {
      enterChat(user.uid, snap.data().name);
    }
  } catch (err) {
    // Ignore: user will just see the start screen.
  }
});

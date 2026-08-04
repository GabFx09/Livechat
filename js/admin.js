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

let currentAdmin = null; // { uid, email }
let activeCustomerUid = null;
let unsubMessages = null;

const loginScreen = document.getElementById("login-screen");
const appScreen = document.getElementById("app-screen");
const emailInput = document.getElementById("email-input");
const passwordInput = document.getElementById("password-input");
const loginBtn = document.getElementById("login-btn");
const loginError = document.getElementById("login-error");
const adminEmailEl = document.getElementById("admin-email");
const logoutBtn = document.getElementById("logout-btn");
const customerListEl = document.getElementById("customer-list");
const messagesEl = document.getElementById("messages");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const chatHeader = document.getElementById("chat-header");

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function showLoginError(message) {
  loginError.textContent = message;
  loginError.classList.remove("hidden");
}

function enterDashboard(uid, email) {
  currentAdmin = { uid, email };
  adminEmailEl.textContent = email;
  loginScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
  listenCustomers();
}

function listenCustomers() {
  const q = query(collection(db, "customers"), orderBy("lastMessageAt", "desc"));
  onSnapshot(q, (snap) => {
    customerListEl.innerHTML = "";
    snap.forEach((docSnap) => {
      const uid = docSnap.id;
      const data = docSnap.data();
      if (!data.name) return;

      const waiting = data.lastSender === "customer";

      const li = document.createElement("li");
      li.className =
        "user-item customer-item" +
        (uid === activeCustomerUid ? " active" : "") +
        (waiting ? " waiting" : "");
      li.innerHTML =
        `<div class="name-row"><span>${escapeHtml(data.name)}</span>${
          waiting ? '<span class="badge">Baru</span>' : ""
        }</div>` +
        `<span class="preview">${escapeHtml(data.lastMessage || "")}</span>`;
      li.addEventListener("click", () => openCustomer(uid, data.name));
      customerListEl.appendChild(li);
    });
  });
}

function openCustomer(uid, name) {
  activeCustomerUid = uid;
  chatHeader.textContent = "Chat dengan " + name;
  messageForm.classList.remove("hidden");
  messageInput.focus();

  document.querySelectorAll(".customer-item").forEach((el) => el.classList.remove("active"));

  if (unsubMessages) unsubMessages();

  const q = query(
    collection(db, "chats", uid, "messages"),
    orderBy("timestamp", "asc")
  );
  unsubMessages = onSnapshot(q, (snap) => {
    messagesEl.innerHTML = "";
    snap.forEach((docSnap) => {
      const m = docSnap.data();
      const div = document.createElement("div");
      div.className = "message " + (m.sender === "admin" ? "mine" : "theirs");
      div.innerHTML =
        `<span class="sender">${m.sender === "admin" ? "Anda" : name}</span>` +
        `<p>${escapeHtml(m.text)}</p>`;
      messagesEl.appendChild(div);
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

messageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !activeCustomerUid) return;
  messageInput.value = "";

  try {
    await addDoc(collection(db, "chats", activeCustomerUid, "messages"), {
      sender: "admin",
      text,
      timestamp: serverTimestamp()
    });
    await setDoc(
      doc(db, "customers", activeCustomerUid),
      { lastMessage: text, lastMessageAt: serverTimestamp(), lastSender: "admin" },
      { merge: true }
    );
  } catch (err) {
    alert("Gagal mengirim balasan: " + err.message);
  }
});

loginBtn.addEventListener("click", async () => {
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
    const adminDoc = await getDoc(doc(db, "admins", cred.user.uid));
    if (!adminDoc.exists()) {
      await signOut(auth);
      showLoginError("Akun ini bukan admin.");
      loginBtn.disabled = false;
      return;
    }
    enterDashboard(cred.user.uid, cred.user.email);
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
  await signOut(auth);
  currentAdmin = null;
  activeCustomerUid = null;
  appScreen.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  emailInput.value = "";
  passwordInput.value = "";
  loginBtn.disabled = false;
});

// Auto re-enter dashboard if this browser already has an admin session.
onAuthStateChanged(auth, async (user) => {
  if (!user || currentAdmin) return;
  try {
    const adminDoc = await getDoc(doc(db, "admins", user.uid));
    if (adminDoc.exists()) {
      enterDashboard(user.uid, user.email);
    }
  } catch (err) {
    // Ignore: admin will just see the login screen.
  }
});

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  deleteUser
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  updateDoc,
  collection,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import {
  initializeAppCheck,
  ReCaptchaV3Provider
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app-check.js";
import { firebaseConfig, RECAPTCHA_V3_SITE_KEY } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

if (RECAPTCHA_V3_SITE_KEY && !RECAPTCHA_V3_SITE_KEY.startsWith("PASTE_")) {
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(RECAPTCHA_V3_SITE_KEY),
    isTokenAutoRefreshEnabled: true
  });
}

const inviteCodeInput = document.getElementById("invite-code-input");
const companyNameInput = document.getElementById("company-name-input");
const adminNameInput = document.getElementById("admin-name-input");
const emailInput = document.getElementById("signup-email-input");
const passwordInput = document.getElementById("signup-password-input");
const signupBtn = document.getElementById("signup-btn");
const signupError = document.getElementById("signup-error");
const signupSuccess = document.getElementById("signup-success");

function wsPath(workspaceId, ...segments) {
  return ["workspaces", workspaceId, ...segments];
}

function showError(message) {
  signupError.textContent = message;
  signupError.classList.remove("hidden");
}

signupBtn.addEventListener("click", async () => {
  const code = inviteCodeInput.value.trim();
  const companyName = companyNameInput.value.trim();
  const adminName = adminNameInput.value.trim();
  const email = emailInput.value.trim();
  const password = passwordInput.value;

  signupError.classList.add("hidden");

  if (!code || !companyName || !adminName || !email || !password) {
    showError("Semua field wajib diisi.");
    return;
  }
  if (password.length < 6) {
    showError("Password minimal 6 karakter.");
    return;
  }

  signupBtn.disabled = true;

  let user;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    user = cred.user;
  } catch (err) {
    showError("Gagal bikin akun: " + (err.message || err.code));
    signupBtn.disabled = false;
    return;
  }

  // ID workspace dibikin di sisi client (Firestore auto-ID, aman dari
  // tabrakan), dipakai langsung buat ngiket kode undangan ke workspace ini
  // di langkah berikutnya -- lihat firestore.rules (workspaceClaimedBySelf)
  // buat penjelasan lengkap kenapa urutannya begini.
  const workspaceId = doc(collection(db, "workspaces")).id;

  try {
    await updateDoc(doc(db, "inviteCodes", code), {
      used: true,
      usedByUid: user.uid,
      usedAt: serverTimestamp(),
      claimedWorkspaceId: workspaceId
    });
  } catch (err) {
    showError("Kode undangan tidak valid atau sudah pernah dipakai.");
    await deleteUser(user).catch(() => {});
    signupBtn.disabled = false;
    return;
  }

  // Titik kritis: kode undangan sudah terpakai & terikat ke workspaceId ini
  // begitu baris di atas berhasil. Kalau salah satu langkah di bawah gagal
  // (mis. koneksi putus), kodenya sudah "kepakai" tapi workspace-nya tidak
  // lengkap -- app ini tanpa backend jadi tidak bisa rollback otomatis.
  // Pesan errornya sengaja jelas minta hubungi pemilik platform buat kode
  // baru kalau ini kejadian (lihat README > Testing/Menambahkan workspace).
  try {
    await setDoc(doc(db, ...wsPath(workspaceId)), {
      name: companyName,
      brandName: companyName,
      themeColor: "#5b8cff",
      bubbleIcon: "💬",
      signupInviteCode: code
    });

    await setDoc(doc(db, ...wsPath(workspaceId, "admins", user.uid)), {
      name: adminName
    });

    await setDoc(doc(db, "adminIndex", user.uid), { workspaceId });
  } catch (err) {
    showError(
      "Akun & kode undangan sudah terpakai, tapi workspace gagal dibuat lengkap (" +
        (err.message || err.code) +
        "). Hubungi pemilik platform untuk dibantu, jangan coba daftar ulang dengan kode yang sama."
    );
    signupBtn.disabled = false;
    return;
  }

  signupSuccess.classList.remove("hidden");
  setTimeout(() => {
    window.location.href = "/admin/";
  }, 1500);
});

passwordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") signupBtn.click();
});

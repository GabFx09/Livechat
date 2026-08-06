// Test khusus buat alur signup mandiri pakai kode undangan (item #8):
// klaim kode -> bikin workspace -> bikin dokumen admin -> bikin adminIndex.
// Jalankan lewat `npm run test:rules` (butuh emulator, sama seperti
// test/rules/firestore.rules.test.js).

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, collection, Timestamp } from "firebase/firestore";

const CODE = "TOKOABC2026";
const NEW_ADMIN = "new-admin-uid";
const ATTACKER = "attacker-uid";

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "demo-livechat-signup-test",
    firestore: { rules: readFileSync("firestore.rules", "utf8") }
  });
});

after(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    // Dibuat manual oleh pemilik platform lewat Console, persis seperti
    // instruksi di README.
    await setDoc(doc(ctx.firestore(), "inviteCodes", CODE), {
      used: false,
      usedByUid: null,
      usedAt: null,
      claimedWorkspaceId: null
    });
  });
});

function asUser(uid) {
  return testEnv.authenticatedContext(uid).firestore();
}

// Jalankan langkah 1 (klaim+ikat kode) sampai berhasil, dipakai sebagai
// setup buat test-test langkah selanjutnya.
async function claimCode(db, uid, workspaceId, code = CODE) {
  return updateDoc(doc(db, "inviteCodes", code), {
    used: true,
    usedByUid: uid,
    usedAt: Timestamp.now(),
    claimedWorkspaceId: workspaceId
  });
}

test("langkah 1 -- klaim kode: berhasil kalau kode belum dipakai", async () => {
  const db = asUser(NEW_ADMIN);
  await assertSucceeds(claimCode(db, NEW_ADMIN, "ws-baru-1"));
});

test("langkah 1 -- klaim kode: gagal kalau kode sudah dipakai (anti reuse)", async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await claimCode(ctx.firestore(), "someone-else", "ws-lama");
  });
  const db = asUser(ATTACKER);
  await assertFails(claimCode(db, ATTACKER, "ws-attacker"));
});

test("langkah 1 -- klaim kode: gagal kalau usedByUid diisi uid orang lain", async () => {
  const db = asUser(NEW_ADMIN);
  await assertFails(
    updateDoc(doc(db, "inviteCodes", CODE), {
      used: true,
      usedByUid: ATTACKER, // nyoba klaim atas nama orang lain
      usedAt: Timestamp.now(),
      claimedWorkspaceId: "ws-baru"
    })
  );
});

test("langkah 2 -- bikin workspace: berhasil setelah kode diklaim & terikat ke workspaceId ini", async () => {
  const db = asUser(NEW_ADMIN);
  const workspaceId = "ws-happy-path";
  await claimCode(db, NEW_ADMIN, workspaceId);

  await assertSucceeds(
    setDoc(doc(db, "workspaces", workspaceId), {
      name: "Toko Baru",
      brandName: "Toko Baru",
      themeColor: "#5b8cff",
      bubbleIcon: "💬",
      signupInviteCode: CODE
    })
  );
});

test("langkah 2 -- bikin workspace: gagal kalau signupInviteCode nunjuk kode yang belum diklaim siapa pun", async () => {
  const db = asUser(ATTACKER);
  await assertFails(
    setDoc(doc(db, "workspaces", "ws-tanpa-klaim"), {
      name: "Workspace Ilegal",
      signupInviteCode: CODE
    })
  );
});

test("langkah 2 -- bikin workspace: gagal kalau workspaceId beda dari yang diikat pas klaim", async () => {
  const db = asUser(NEW_ADMIN);
  await claimCode(db, NEW_ADMIN, "ws-yang-benar");

  await assertFails(
    setDoc(doc(db, "workspaces", "ws-yang-salah"), {
      name: "Workspace Salah Sasaran",
      signupInviteCode: CODE
    })
  );
});

test("langkah 2 -- bikin workspace: uid LAIN tidak bisa numpang kode yang diklaim uid ini", async () => {
  const claimerDb = asUser(NEW_ADMIN);
  const workspaceId = "ws-dicoba-bajak";
  await claimCode(claimerDb, NEW_ADMIN, workspaceId);

  const attackerDb = asUser(ATTACKER);
  await assertFails(
    setDoc(doc(attackerDb, "workspaces", workspaceId), {
      name: "Dibajak",
      signupInviteCode: CODE
    })
  );
});

test("langkah 2 -- bikin workspace: field di luar daftar yang diizinkan bikin gagal (mis. nyuntik autoGreetingOptions)", async () => {
  const db = asUser(NEW_ADMIN);
  const workspaceId = "ws-field-liar";
  await claimCode(db, NEW_ADMIN, workspaceId);

  await assertFails(
    setDoc(doc(db, "workspaces", workspaceId), {
      name: "Toko",
      signupInviteCode: CODE,
      autoGreetingOptions: ["Backdoor"]
    })
  );
});

test("1 kode cuma bisa dipakai buat SATU workspace (tidak bisa dipakai bikin workspace kedua)", async () => {
  const db = asUser(NEW_ADMIN);
  const firstWorkspaceId = "ws-pertama";
  await claimCode(db, NEW_ADMIN, firstWorkspaceId);
  await assertSucceeds(
    setDoc(doc(db, "workspaces", firstWorkspaceId), { name: "Pertama", signupInviteCode: CODE })
  );

  // Coba klaim ulang kode yang sama buat workspace kedua -- langkah 1-nya
  // sendiri sudah harus gagal karena claimedWorkspaceId sudah terisi.
  await assertFails(claimCode(db, NEW_ADMIN, "ws-kedua"));
});

test("langkah 3 -- bikin dokumen admin: berhasil setelah workspace-nya ada & terikat ke uid ini", async () => {
  const db = asUser(NEW_ADMIN);
  const workspaceId = "ws-admin-doc";
  await claimCode(db, NEW_ADMIN, workspaceId);
  await setDoc(doc(db, "workspaces", workspaceId), { name: "Toko", signupInviteCode: CODE });

  await assertSucceeds(
    setDoc(doc(db, "workspaces", workspaceId, "admins", NEW_ADMIN), {
      name: "Admin Baru",
      email: "admin@tokobaru.com"
    })
  );
});

test("langkah 3 -- bikin dokumen admin: uid LAIN tidak bisa daftar jadi admin di workspace ini", async () => {
  const ownerDb = asUser(NEW_ADMIN);
  const workspaceId = "ws-admin-bajak";
  await claimCode(ownerDb, NEW_ADMIN, workspaceId);
  await setDoc(doc(ownerDb, "workspaces", workspaceId), { name: "Toko", signupInviteCode: CODE });

  const attackerDb = asUser(ATTACKER);
  await assertFails(
    setDoc(doc(attackerDb, "workspaces", workspaceId, "admins", ATTACKER), {
      name: "Penyusup"
    })
  );
});

test("langkah 4 -- bikin adminIndex: berhasil & lengkap satu alur signup end-to-end", async () => {
  const db = asUser(NEW_ADMIN);
  const workspaceId = "ws-full-flow";

  await assertSucceeds(claimCode(db, NEW_ADMIN, workspaceId));
  await assertSucceeds(
    setDoc(doc(db, "workspaces", workspaceId), {
      name: "Toko Lengkap",
      brandName: "Toko Lengkap",
      themeColor: "#5b8cff",
      bubbleIcon: "💬",
      signupInviteCode: CODE
    })
  );
  await assertSucceeds(
    setDoc(doc(db, "workspaces", workspaceId, "admins", NEW_ADMIN), {
      name: "Admin Baru",
      email: "admin@tokolengkap.com"
    })
  );
  await assertSucceeds(setDoc(doc(db, "adminIndex", NEW_ADMIN), { workspaceId }));

  // Verifikasi hasil akhirnya kebaca normal, sama seperti admin yang
  // dionboarding manual lewat Console.
  const indexSnap = await getDoc(doc(db, "adminIndex", NEW_ADMIN));
  assert.equal(indexSnap.data().workspaceId, workspaceId);
});

test("langkah 4 -- bikin adminIndex: gagal kalau workspaceId yang ditunjuk bukan hasil klaim uid ini", async () => {
  const db = asUser(ATTACKER);
  await assertFails(setDoc(doc(db, "adminIndex", ATTACKER), { workspaceId: "ws-punya-orang-lain" }));
});

test("adminIndex tidak bisa diubah lagi setelah dibuat, bahkan oleh pemiliknya sendiri", async () => {
  const db = asUser(NEW_ADMIN);
  const workspaceId = "ws-lock-index";
  await claimCode(db, NEW_ADMIN, workspaceId);
  await setDoc(doc(db, "workspaces", workspaceId), { name: "Toko", signupInviteCode: CODE });
  await setDoc(doc(db, "adminIndex", NEW_ADMIN), { workspaceId });

  await assertFails(updateDoc(doc(db, "adminIndex", NEW_ADMIN), { workspaceId: "ws-lain" }));
});

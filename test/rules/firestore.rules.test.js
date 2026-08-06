// Test buat firestore.rules lewat Firestore Emulator -- jalankan dengan
// `npm run test:rules` (bukan `npm test` biasa), karena butuh emulator
// nyala. Emulator dijalankan otomatis oleh `firebase emulators:exec` yang
// membungkus perintah node --test di package.json.
//
// Fokusnya khusus ke rules yang paling gampang salah/gampang lupa dites
// manual: exists()/get()-based anti-spoofing buat sapaan & menu pilihan
// otomatis, rate limit anti-spam, hasOnly di berbagai koleksi, dan isolasi
// antar workspace (multi-tenant).

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, Timestamp } from "firebase/firestore";

const WS = "ws-test";
const OTHER_WS = "ws-other";
const ADMIN = "admin-1";
const OTHER_ADMIN = "admin-2";
const CUSTOMER = "cust-1";
const OTHER_CUSTOMER = "cust-2";

const GREETING = "Halo! Selamat datang di Toko Test.";
const OPTIONS = ["Info Produk", "Keluhan"];
const OPTION_REPLIES = { "Info Produk": "Produk apa yang dicari?" };

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "demo-livechat-rules-test",
    firestore: { rules: readFileSync("firestore.rules", "utf8") }
  });
});

after(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "workspaces", WS), {
      name: "Toko Test",
      brandName: "Toko Test",
      themeColor: "#5b8cff",
      autoGreetingEnabled: true,
      autoGreetingMessage: GREETING,
      autoGreetingOptions: OPTIONS,
      autoGreetingOptionReplies: OPTION_REPLIES
    });
    await setDoc(doc(db, "workspaces", WS, "admins", ADMIN), { name: "Admin Satu" });
    await setDoc(doc(db, "workspaces", OTHER_WS), { name: "Toko Lain" });
    await setDoc(doc(db, "workspaces", OTHER_WS, "admins", OTHER_ADMIN), { name: "Admin Lain" });
  });
});

function asCustomer(uid = CUSTOMER) {
  return testEnv.authenticatedContext(uid).firestore();
}
function asAdmin(uid = ADMIN) {
  return testEnv.authenticatedContext(uid).firestore();
}
function asAnon() {
  return testEnv.unauthenticatedContext().firestore();
}
async function seed(pathSegments, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), ...pathSegments), data);
  });
}

// --- workspaces/{workspaceId} ---

test("workspaces: baca publik boleh walau tidak login", async () => {
  const db = asAnon();
  await assertSucceeds(getDoc(doc(db, "workspaces", WS)));
});

test("workspaces: create selalu ditolak (dibuat manual lewat Console)", async () => {
  const db = asAdmin();
  await assertFails(setDoc(doc(db, "workspaces", "ws-baru"), { name: "Baru" }));
});

test("workspaces: update ditolak buat yang bukan admin workspace itu", async () => {
  const db = asCustomer();
  await assertFails(setDoc(doc(db, "workspaces", WS), { brandName: "Ganti" }, { merge: true }));
});

test("workspaces: admin boleh update field appearance/auto-chat yang diizinkan", async () => {
  const db = asAdmin();
  await assertSucceeds(setDoc(doc(db, "workspaces", WS), { brandName: "Nama Baru" }, { merge: true }));
});

test("workspaces: admin ditolak kalau nyentuh field di luar daftar hasOnly", async () => {
  const db = asAdmin();
  await assertFails(setDoc(doc(db, "workspaces", WS), { name: "Ganti nama internal" }, { merge: true }));
});

test("workspaces: admin workspace LAIN tidak bisa update workspace ini", async () => {
  const db = asAdmin(OTHER_ADMIN);
  await assertFails(setDoc(doc(db, "workspaces", WS), { brandName: "Diserobot" }, { merge: true }));
});

// --- admins subcollection ---

test("admins: admin boleh baca profil sendiri", async () => {
  const db = asAdmin();
  await assertSucceeds(getDoc(doc(db, "workspaces", WS, "admins", ADMIN)));
});

test("admins: admin lain di workspace sama tetap tidak boleh baca profil orang lain", async () => {
  await seed(["workspaces", WS, "admins", "admin-3"], { name: "Admin Tiga" });
  const db = asAdmin();
  await assertFails(getDoc(doc(db, "workspaces", WS, "admins", "admin-3")));
});

test("admins: create selalu ditolak (dibuat manual lewat Console)", async () => {
  const db = asAdmin();
  await assertFails(setDoc(doc(db, "workspaces", WS, "admins", "admin-baru"), { name: "X" }));
});

// --- customers/{customerId} ---

test("customers: customer boleh bikin dokumen sendiri", async () => {
  const db = asCustomer();
  await assertSucceeds(setDoc(doc(db, "workspaces", WS, "customers", CUSTOMER), { name: "Budi" }));
});

test("customers: customer TIDAK boleh bikin dokumen atas nama uid lain", async () => {
  const db = asCustomer();
  await assertFails(setDoc(doc(db, "workspaces", WS, "customers", OTHER_CUSTOMER), { name: "Nyamar" }));
});

test("customers: admin boleh baca & update dokumen customer di workspace-nya", async () => {
  await seed(["workspaces", WS, "customers", CUSTOMER], { name: "Budi" });
  const db = asAdmin();
  await assertSucceeds(getDoc(doc(db, "workspaces", WS, "customers", CUSTOMER)));
  await assertSucceeds(setDoc(doc(db, "workspaces", WS, "customers", CUSTOMER), { archived: true }, { merge: true }));
});

test("customers: admin workspace LAIN tidak bisa baca customer workspace ini (isolasi tenant)", async () => {
  await seed(["workspaces", WS, "customers", CUSTOMER], { name: "Budi" });
  const db = asAdmin(OTHER_ADMIN);
  await assertFails(getDoc(doc(db, "workspaces", WS, "customers", CUSTOMER)));
});

test("customers: customer tidak boleh hapus dokumen sendiri, cuma admin", async () => {
  await seed(["workspaces", WS, "customers", CUSTOMER], { name: "Budi" });
  await assertFails(deleteDoc(doc(asCustomer(), "workspaces", WS, "customers", CUSTOMER)));
  await assertSucceeds(deleteDoc(doc(asAdmin(), "workspaces", WS, "customers", CUSTOMER)));
});

// --- chats/{customerId}/messages: pesan biasa ---

test("chats: customer boleh kirim pesan teks kalau dokumen customer-nya ada", async () => {
  await seed(["workspaces", WS, "customers", CUSTOMER], { name: "Budi" });
  const db = asCustomer();
  await assertSucceeds(
    addDoc(collection(db, "workspaces", WS, "chats", CUSTOMER, "messages"), {
      sender: "customer",
      type: "text",
      text: "halo",
      timestamp: Timestamp.now()
    })
  );
});

test("chats: customer DITOLAK kirim pesan kalau dokumen customer-nya sudah dihapus", async () => {
  // Simulasi state setelah admin pakai "Hapus Semua Chat" -- dokumen
  // customers/{uid} sengaja tidak di-seed sama sekali.
  const db = asCustomer();
  await assertFails(
    addDoc(collection(db, "workspaces", WS, "chats", CUSTOMER, "messages"), {
      sender: "customer",
      type: "text",
      text: "halo lagi",
      timestamp: Timestamp.now()
    })
  );
});

test("chats: pesan teks customer ditolak kalau lebih dari 4000 karakter", async () => {
  await seed(["workspaces", WS, "customers", CUSTOMER], { name: "Budi" });
  const db = asCustomer();
  await assertFails(
    addDoc(collection(db, "workspaces", WS, "chats", CUSTOMER, "messages"), {
      sender: "customer",
      type: "text",
      text: "a".repeat(4001),
      timestamp: Timestamp.now()
    })
  );
});

test("chats: anti-spam menolak pesan customer < 500ms sejak pesan sebelumnya", async () => {
  await seed(["workspaces", WS, "customers", CUSTOMER], {
    name: "Budi",
    lastMessageAt: Timestamp.now()
  });
  const db = asCustomer();
  await assertFails(
    addDoc(collection(db, "workspaces", WS, "chats", CUSTOMER, "messages"), {
      sender: "customer",
      type: "text",
      text: "spam cepat",
      timestamp: Timestamp.now()
    })
  );
});

test("chats: pesan customer LOLOS kalau sudah lebih dari 500ms sejak pesan sebelumnya", async () => {
  const past = Timestamp.fromMillis(Date.now() - 2000);
  await seed(["workspaces", WS, "customers", CUSTOMER], { name: "Budi", lastMessageAt: past });
  const db = asCustomer();
  await assertSucceeds(
    addDoc(collection(db, "workspaces", WS, "chats", CUSTOMER, "messages"), {
      sender: "customer",
      type: "text",
      text: "pesan wajar",
      timestamp: Timestamp.now()
    })
  );
});

test("chats: admin boleh kirim balasan dengan senderId uid sendiri", async () => {
  await seed(["workspaces", WS, "customers", CUSTOMER], { name: "Budi" });
  const db = asAdmin();
  await assertSucceeds(
    addDoc(collection(db, "workspaces", WS, "chats", CUSTOMER, "messages"), {
      sender: "admin",
      senderId: ADMIN,
      type: "text",
      text: "siap dibantu",
      timestamp: Timestamp.now()
    })
  );
});

test("chats: admin TIDAK boleh kirim pesan menyamar sebagai admin lain (senderId tidak match)", async () => {
  await seed(["workspaces", WS, "customers", CUSTOMER], { name: "Budi" });
  const db = asAdmin();
  await assertFails(
    addDoc(collection(db, "workspaces", WS, "chats", CUSTOMER, "messages"), {
      sender: "admin",
      senderId: OTHER_ADMIN,
      type: "text",
      text: "menyamar",
      timestamp: Timestamp.now()
    })
  );
});

// --- chats/{customerId}/messages: anti-spoofing sapaan/menu/balasan otomatis ---

test("auto-greeting: customer TIDAK bisa nyamar admin dengan teks bebas", async () => {
  await seed(["workspaces", WS, "customers", CUSTOMER], { name: "Budi" });
  const db = asCustomer();
  await assertFails(
    addDoc(collection(db, "workspaces", WS, "chats", CUSTOMER, "messages"), {
      sender: "admin",
      type: "text",
      text: "Ini bukan sapaan asli, saya pura-pura jadi admin",
      autoGreeting: true,
      timestamp: Timestamp.now()
    })
  );
});

test("auto-greeting: LOLOS kalau teksnya persis sama dengan autoGreetingMessage workspace", async () => {
  await seed(["workspaces", WS, "customers", CUSTOMER], { name: "Budi" });
  const db = asCustomer();
  await assertSucceeds(
    addDoc(collection(db, "workspaces", WS, "chats", CUSTOMER, "messages"), {
      sender: "admin",
      type: "text",
      text: GREETING,
      autoGreeting: true,
      timestamp: Timestamp.now()
    })
  );
});

test("menu pilihan: customer TIDAK bisa kirim array pilihan yang tidak sesuai config", async () => {
  await seed(["workspaces", WS, "customers", CUSTOMER], { name: "Budi" });
  const db = asCustomer();
  await assertFails(
    addDoc(collection(db, "workspaces", WS, "chats", CUSTOMER, "messages"), {
      sender: "admin",
      type: "options",
      options: ["Pilihan Palsu"],
      autoGreeting: true,
      timestamp: Timestamp.now()
    })
  );
});

test("menu pilihan: LOLOS kalau array-nya persis sama dengan autoGreetingOptions workspace", async () => {
  await seed(["workspaces", WS, "customers", CUSTOMER], { name: "Budi" });
  const db = asCustomer();
  await assertSucceeds(
    addDoc(collection(db, "workspaces", WS, "chats", CUSTOMER, "messages"), {
      sender: "admin",
      type: "options",
      options: OPTIONS,
      autoGreeting: true,
      timestamp: Timestamp.now()
    })
  );
});

test("menu pilihan: ditolak kalau ada field ekstra di luar hasOnly (mis. nyelundup senderPhoto)", async () => {
  await seed(["workspaces", WS, "customers", CUSTOMER], { name: "Budi" });
  const db = asCustomer();
  await assertFails(
    addDoc(collection(db, "workspaces", WS, "chats", CUSTOMER, "messages"), {
      sender: "admin",
      type: "options",
      options: OPTIONS,
      autoGreeting: true,
      senderPhoto: "https://evil.example/fake.png",
      timestamp: Timestamp.now()
    })
  );
});

test("balasan otomatis: customer TIDAK bisa nyetel teks balasan sembarangan buat suatu pilihan", async () => {
  await seed(["workspaces", WS, "customers", CUSTOMER], { name: "Budi" });
  const db = asCustomer();
  await assertFails(
    addDoc(collection(db, "workspaces", WS, "chats", CUSTOMER, "messages"), {
      sender: "admin",
      type: "text",
      text: "Balasan palsu",
      optionLabel: "Info Produk",
      autoReply: true,
      timestamp: Timestamp.now()
    })
  );
});

test("balasan otomatis: LOLOS kalau teksnya persis sama dengan autoGreetingOptionReplies[optionLabel]", async () => {
  await seed(["workspaces", WS, "customers", CUSTOMER], { name: "Budi" });
  const db = asCustomer();
  await assertSucceeds(
    addDoc(collection(db, "workspaces", WS, "chats", CUSTOMER, "messages"), {
      sender: "admin",
      type: "text",
      text: OPTION_REPLIES["Info Produk"],
      optionLabel: "Info Produk",
      autoReply: true,
      timestamp: Timestamp.now()
    })
  );
});

// --- chats/{customerId}/messages: edit & delete ---

test("edit pesan: cuma admin pengirim asli yang boleh edit, dan cuma field tertentu", async () => {
  await seed(["workspaces", WS, "customers", CUSTOMER], { name: "Budi" });
  let msgRef;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    msgRef = await addDoc(collection(ctx.firestore(), "workspaces", WS, "chats", CUSTOMER, "messages"), {
      sender: "admin",
      senderId: ADMIN,
      type: "text",
      text: "versi awal",
      timestamp: Timestamp.now()
    });
  });

  const otherAdminDb = asAdmin(OTHER_ADMIN);
  await assertFails(
    updateDoc(doc(otherAdminDb, "workspaces", WS, "chats", CUSTOMER, "messages", msgRef.id), {
      text: "diedit admin lain"
    })
  );

  const ownerDb = asAdmin();
  await assertSucceeds(
    updateDoc(doc(ownerDb, "workspaces", WS, "chats", CUSTOMER, "messages", msgRef.id), {
      text: "sudah direvisi",
      edited: true,
      editedAt: Timestamp.now()
    })
  );
});

test("hapus pesan: admin mana pun di workspace itu boleh hapus, customer tidak boleh", async () => {
  await seed(["workspaces", WS, "customers", CUSTOMER], { name: "Budi" });
  let msgRef;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    msgRef = await addDoc(collection(ctx.firestore(), "workspaces", WS, "chats", CUSTOMER, "messages"), {
      sender: "customer",
      type: "text",
      text: "mau dihapus",
      timestamp: Timestamp.now()
    });
  });

  await assertFails(
    deleteDoc(doc(asCustomer(), "workspaces", WS, "chats", CUSTOMER, "messages", msgRef.id))
  );
  await assertSucceeds(
    deleteDoc(doc(asAdmin(), "workspaces", WS, "chats", CUSTOMER, "messages", msgRef.id))
  );
});

// --- deletionLogs: read-only permanen ---

test("deletionLogs: admin boleh bikin log dengan deletedBy uid sendiri", async () => {
  const db = asAdmin();
  await assertSucceeds(
    addDoc(collection(db, "workspaces", WS, "deletionLogs"), {
      customerId: CUSTOMER,
      customerName: "Budi",
      messageCount: 3,
      deletedBy: ADMIN,
      deletedByName: "Admin Satu",
      deletedAt: Timestamp.now()
    })
  );
});

test("deletionLogs: admin TIDAK bisa bikin log atas nama admin lain", async () => {
  const db = asAdmin();
  await assertFails(
    addDoc(collection(db, "workspaces", WS, "deletionLogs"), {
      customerId: CUSTOMER,
      customerName: "Budi",
      messageCount: 3,
      deletedBy: OTHER_ADMIN,
      deletedByName: "Admin Lain",
      deletedAt: Timestamp.now()
    })
  );
});

test("deletionLogs: sekali tersimpan, tidak bisa diedit ataupun dihapus siapa pun (termasuk admin)", async () => {
  let logRef;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    logRef = await addDoc(collection(ctx.firestore(), "workspaces", WS, "deletionLogs"), {
      customerId: CUSTOMER,
      customerName: "Budi",
      messageCount: 1,
      deletedBy: ADMIN,
      deletedByName: "Admin Satu",
      deletedAt: Timestamp.now()
    });
  });

  const db = asAdmin();
  await assertFails(updateDoc(doc(db, "workspaces", WS, "deletionLogs", logRef.id), { messageCount: 999 }));
  await assertFails(deleteDoc(doc(db, "workspaces", WS, "deletionLogs", logRef.id)));
});

// --- stats/{date}: hasOnly & read admin-only ---

test("stats: create ditolak kalau ada field di luar daftar counter yang dikenal", async () => {
  const db = asCustomer();
  await assertFails(setDoc(doc(db, "workspaces", WS, "stats", "2024-01-01"), { messageCount: 1, hacked: true }));
});

test("stats: create/update dengan counter yang dikenal (termasuk field baru rating/response-time) berhasil", async () => {
  const db = asCustomer();
  await assertSucceeds(
    setDoc(doc(db, "workspaces", WS, "stats", "2024-01-01"), {
      messageCount: 1,
      ratingTotal: 5,
      ratingCount: 1,
      firstResponseTotalMs: 12000,
      firstResponseCount: 1
    })
  );
});

test("stats: cuma admin yang boleh baca, customer tidak boleh", async () => {
  await seed(["workspaces", WS, "stats", "2024-01-01"], { messageCount: 1 });
  await assertFails(getDoc(doc(asCustomer(), "workspaces", WS, "stats", "2024-01-01")));
  await assertSucceeds(getDoc(doc(asAdmin(), "workspaces", WS, "stats", "2024-01-01")));
});

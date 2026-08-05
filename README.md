# LiveChat — Platform Multi-Tenant

Platform live chat customer service yang bisa dipakai bareng-bareng oleh **banyak perusahaan berbeda** (multi-tenant), mirip Chaport/Tawk.to/Crisp. Tiap perusahaan punya **workspace** sendiri — data customer & percakapannya terisolasi, tidak bisa saling lihat.

- Pengunjung website perusahaan (`index.html?w=WORKSPACE_ID`) cukup masukkan username lalu langsung chat — tanpa registrasi.
- Admin (`admin.html`, **URL sama untuk semua perusahaan**) login dengan email & password, sistem otomatis tahu dia admin di workspace mana, lalu melihat & membalas percakapan customer workspace-nya secara real-time.
- Widget bubble (`js/widget.js`) bisa ditempel di website perusahaan mana pun, terhubung ke workspace mereka lewat parameter konfigurasi.

Situs ini murni HTML/CSS/JS statis (tanpa proses build), sehingga bisa di-hosting gratis lewat GitHub Pages. Data disimpan di Firebase Firestore (realtime, gratis).

Live: https://gabfx09.github.io/Livechat/ dan https://gabfx09.github.io/Livechat/admin.html

**Pemilik platform** (Anda) yang menambahkan tiap perusahaan baru secara manual lewat Firebase Console (lihat langkah 4) — belum ada halaman signup mandiri.

## 1. Buat project Firebase

1. Buka https://console.firebase.google.com dan login dengan akun Google Anda.
2. Klik **Add project**, beri nama bebas, lanjutkan sampai selesai.
3. Tambahkan **Web App** (`</>`), salin objek `firebaseConfig` yang muncul.
4. Isikan nilai-nilai itu ke `js/firebase-config.js` di project ini.

## 2. Aktifkan metode login

Di Firebase Console, buka **Authentication** (kategori **Security**) → tab **Sign-in method**:

1. Aktifkan **Anonymous** — dipakai untuk sisi customer (tanpa form login).
2. Aktifkan juga **Email/Password** — dipakai untuk sisi admin.

## 3. Buat Firestore Database

1. Buka **Firestore Database** (kategori **Databases and storage**) → **Create database**.
2. Pilih **Standard edition** → lokasi server terdekat → **Start in production mode**.
3. Publish `firestore.rules` — **disarankan pakai Firebase CLI**, bukan copy-paste manual ke Console (rules ini cukup panjang, copy-paste manual gampang ke-corrupt/terpotong):
   ```bash
   npm install -g firebase-tools   # sekali saja
   firebase login                  # sekali saja, buka browser untuk login
   firebase deploy --only firestore:rules
   ```
   Project ID sudah diatur di `.firebaserc`. Kalau tetap mau lewat Firebase Console manual: buka tab **Rules**, hapus isi default, tempel seluruh isi file `firestore.rules`, klik **Publish** — teliti dulu tidak ada baris yang hilang/terpotong sebelum publish.

## 4. Menambahkan perusahaan baru (workspace)

Tiap kali ada perusahaan baru mau pakai livechat ini, ulangi 4 langkah berikut lewat Firebase Console:

### 4a. Buat dokumen workspace

**Firestore Database > Data** → **Start collection** → Collection ID: `workspaces` → Document ID: **klik "Auto-ID"** (atau isi ID pendek sendiri, mis. `toko-abc`) → tambahkan field:
- `name` (string) — nama internal perusahaan, mis. `PT Toko ABC`
- `brandName` (string) — nama yang tampil ke customer di widget/header chat, mis. `Toko ABC`
- `themeColor` (string) — kode hex warna brand, mis. `#e0745f`

Klik **Save**, lalu **salin Document ID-nya** (ini `WORKSPACE_ID`, dipakai di langkah berikutnya).

### 4b. Buat akun admin pertama perusahaan itu

1. **Authentication > Users** → **Add user** → isi email & password admin perusahaan tsb → **Add user**.
2. Salin **User UID**-nya.
3. **Firestore Database > Data** → masuk ke dokumen `workspaces/WORKSPACE_ID` tadi → **Start collection** di dalamnya → Collection ID: `admins` → Document ID: **tempel User UID** (jangan Auto-ID) → tambahkan field bebas, mis. `role` (string) = `admin` → **Save**.

### 4c. Hubungkan admin ke workspace-nya (adminIndex)

Ini yang membuat sistem tahu "admin dengan UID ini kerja di workspace mana" saat login.

**Firestore Database > Data** (kembali ke root, bukan di dalam `workspaces`) → **Start collection** → Collection ID: `adminIndex` → Document ID: **tempel User UID yang sama** dari 4b → tambahkan field:
- `workspaceId` (string) = **WORKSPACE_ID** dari langkah 4a

Klik **Save**.

Ulangi 4b + 4c kalau perusahaan itu mau lebih dari 1 admin (tiap admin dapat user Auth + dokumen `admins` + dokumen `adminIndex` sendiri, semua `workspaceId`-nya sama).

### 4d. Berikan ke perusahaan tsb

- **Admin login**: `https://gabfx09.github.io/Livechat/admin.html` (URL sama untuk semua perusahaan, tidak perlu dibedakan) + email/password dari 4b.
- **Link chat langsung** (mis. buat bio WhatsApp/QR code): `https://gabfx09.github.io/Livechat/index.html?w=WORKSPACE_ID`
- **Snippet widget** untuk ditempel di website mereka — lihat bagian "Widget untuk website perusahaan" di bawah.

## 5. Coba jalankan secara lokal (opsional tapi disarankan)

Karena kode memakai ES Modules, membuka file HTML langsung dengan cara double-click (`file://`) tidak akan berfungsi. Jalankan lewat server lokal:

```bash
npx serve .
# atau: python -m http.server 8080
```

Lalu buka:
- `http://localhost:8080/index.html?w=WORKSPACE_ID` — sisi customer (wajib ada `?w=...`, kalau tidak akan muncul halaman "Workspace tidak ditemukan").
- `http://localhost:8080/admin.html` — sisi admin, login dengan email/password dari langkah 4b.

## 6. Upload ke GitHub & aktifkan GitHub Pages

```bash
git add .
git commit -m "Update livechat"
git push
```

Kalau repo belum pernah dihubungkan ke GitHub:
```bash
git remote add origin https://github.com/USERNAME/NAMA-REPO.git
git push -u origin main
```

Aktifkan GitHub Pages di **Settings > Pages** → **Source: Deploy from a branch** → branch `main`, folder `/ (root)` → **Save**.

## Widget untuk website perusahaan

Tiap perusahaan tempel snippet ini sebelum tag `</body>` di HTML website mereka, dengan `workspaceId` masing-masing (dari langkah 4a):

```html
<!-- Begin LiveChat Widget code -->
<script>
  (function (w, d) {
    w.__livechatConfig = {
      workspaceId: "WORKSPACE_ID_PERUSAHAAN_INI",
      brandName: "Nama Perusahaan",
      themeColor: "#5b8cff"
    };
    var s = d.createElement("script");
    s.src = "https://gabfx09.github.io/Livechat/js/widget.js";
    s.async = true;
    d.head.appendChild(s);
  })(window, document);
</script>
<!-- End LiveChat Widget code -->
```

Cara kerjanya:
- Muncul bubble 💬 melayang di pojok kanan bawah, warna & nama sesuai `themeColor`/`brandName` yang diisi di config.
- Diklik → di **desktop** muncul jendela chat kecil melayang; di **mobile** (layar ≤640px) otomatis full-screen dalam halaman yang sama (tanpa pindah tab).
- Bisa dipasang di domain mana pun (bukan cuma GitHub Pages), karena cukup memuat `index.html?w=WORKSPACE_ID` lewat iframe.
- `workspaceId` **wajib diisi** — kalau kosong, widget tidak akan muncul (dicatat sebagai error di console browser).
- Kalau `brandName`/`themeColor` tidak diisi, widget pakai default ("Live Chat", biru `#5b8cff`).

## Fitur

- **Suara notifikasi admin**: dashboard admin berbunyi otomatis saat ada pesan baru dari customer (hanya pesan yang datang setelah admin login).
- **Pengaturan admin**: klik ⚙ di sidebar untuk ganti nama tampilan & foto profil. Muncul di tiap balasan ke customer.
- **Kirim gambar**: customer & admin bisa kirim gambar lewat ikon 📎, otomatis dikompres & disimpan langsung di Firestore (bukan Firebase Storage, supaya tetap gratis tanpa kartu kredit). Maks. sekitar 700KB per gambar.
- **Edit & hapus pesan (admin saja)**: arahkan kursor ke pesan balasan admin sendiri untuk lihat ikon ✏ (edit teks) dan 🗑 (hapus). Pesan dari customer tidak bisa diubah admin. Pesan yang diedit diberi label "(diedit)".
- **Arsip percakapan**: tab **Aktif**/**Arsip** di sidebar (ikon rail kiri: 💬/🗄). Otomatis pindah ke Arsip setelah **30 menit** tanpa pesan baru; admin juga bisa arsipkan/pulihkan manual lewat panel Info Customer. Customer yang diarsipkan lalu kirim pesan lagi otomatis pulih ke Aktif.
- **Auto-hapus arsip 1 tahun**: perlu setup TTL sekali di Firestore Console (**Firestore Database > TTL** → Create policy → Collection group: `customers`, Timestamp field: `expireAt`). Tanpa ini, data arsip tetap ada di tab Arsip tapi tidak pernah otomatis terhapus.
- **Info customer (admin saja)**: klik ℹ di header chat → panel kanan berisi nama, IP, kota, provinsi, negara (diambil otomatis dari [ipapi.co](https://ipapi.co)/ipwho.is, tidak terlihat customer).
- **Saved Replies**: tekan **Ctrl+/** (atau klik ⚡ di sebelah kolom pesan) untuk buka daftar balasan cepat tersimpan, bisa tambah/hapus sendiri. Mengetik 3+ huruf yang cocok dengan salah satu saved reply juga langsung memunculkan saran di atas kolom pesan (navigasi dengan panah atas/bawah, pilih dengan Enter/klik).
- **Navigasi keyboard**: **Alt + panah atas/bawah** untuk pindah antar chat customer tanpa klik mouse.

## Catatan keamanan & isolasi data antar perusahaan

- Setiap workspace terisolasi lewat Firestore rules: admin workspace A tidak bisa membaca/menulis data workspace B sama sekali (dicek lewat `exists(workspaces/{id}/admins/{uid})` yang scoped ke `workspaceId` masing-masing).
- `adminIndex/{uid}` dan dokumen `admins` di dalam tiap workspace **hanya bisa dibuat manual lewat Firebase Console** — tidak ada cara bagi siapa pun untuk mengangkat dirinya sendiri jadi admin lewat aplikasi.
- Sisi customer pakai Firebase Anonymous Auth: siapa pun yang buka link/widget suatu workspace bisa mulai chat dengan username apa saja — ini memang perilaku wajar untuk widget customer service publik.
- `admin.html` tidak ditautkan dari `index.html` manapun, tapi ini cuma "security by obscurity" tambahan — pengaman sesungguhnya ada di kombinasi login + Firestore rules di atas.
- Menggunakan tier gratis Firebase (Spark plan). Untuk jumlah workspace/traffic yang besar, pantau kuota Firestore (jumlah baca/tulis) di Firebase Console — kalau mendekati limit gratis, perlu upgrade ke Blaze (bayar sesuai pakai).

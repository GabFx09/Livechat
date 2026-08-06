# LiveChat — Platform Multi-Tenant

Platform live chat customer service yang bisa dipakai bareng-bareng oleh **banyak perusahaan berbeda** (multi-tenant), mirip Chaport/Tawk.to/Crisp. Tiap perusahaan punya **workspace** sendiri — data customer & percakapannya terisolasi, tidak bisa saling lihat.

- Pengunjung website perusahaan (`index.html?w=WORKSPACE_ID`) cukup masukkan username lalu langsung chat — tanpa registrasi.
- Admin (`admin.html`, **URL sama untuk semua perusahaan**) login dengan email & password, sistem otomatis tahu dia admin di workspace mana, lalu melihat & membalas percakapan customer workspace-nya secara real-time.
- Widget bubble (`js/widget.js`) bisa ditempel di website perusahaan mana pun, terhubung ke workspace mereka lewat parameter konfigurasi.

Situs ini murni HTML/CSS/JS statis (tanpa proses build), sehingga bisa di-hosting gratis lewat GitHub Pages. Data disimpan di Firebase Firestore (realtime, gratis).

Live: https://gabfx09.github.io/Livechat/ dan https://gabfx09.github.io/Livechat/admin.html

**Pemilik platform** (Anda) yang mengontrol siapa boleh gabung: tambahkan perusahaan baru manual lewat Firebase Console (langkah 4a-4c), atau bagikan kode undangan sekali-pakai supaya mereka daftar sendiri lewat `signup.html` (langkah 4e) — dua-duanya menghasilkan workspace yang sama persis.

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

## 3b. (Opsional tapi disarankan) Aktifkan App Check anti-spam

Tanpa ini, chat customer tetap bisa dipakai script/bot untuk bikin ribuan sesi/pesan palsu (anonymous auth publik). App Check menandai tiap request dengan token dari reCAPTCHA v3 supaya Firestore bisa bedakan browser asli vs script — gratis, tidak perlu Blaze plan.

1. Firebase Console → kategori **Security > App Check** (nama menunya bisa beda tergantung versi Console — cari yang ada tulisan "App Check").
2. Tab **Apps** → cari Web App yang sudah didaftarkan di langkah 1 → **Register**.
3. Pilih provider **reCAPTCHA** (yang biasa/v3, **bukan** "reCAPTCHA Enterprise" — itu produk terpisah, lebih ribet setupnya).
4. Kalau diminta site key/secret key (bukan di-generate otomatis), buka tab baru ke https://www.google.com/recaptcha/admin/create:
   - **Label**: bebas
   - **reCAPTCHA type**: pilih **Score based (v3)**
   - **Domains**: `gabfx09.github.io` (tambahkan `localhost` juga kalau mau tes lokal)
   - **Google Cloud Platform > Project name**: pilih project Firebase kamu (mis. `livechat-saya`), bukan "My First Project"
   - Submit → muncul **Site Key** dan **Secret Key**
5. Tempel **Secret Key** di halaman App Check tadi (Firebase). **Site Key** disimpan buat langkah berikutnya — dua kunci ini beda, jangan tertukar.
6. Salin **Site Key**-nya ke `RECAPTCHA_V3_SITE_KEY` di `js/firebase-config.js`. **Jangan pernah** taruh Secret Key di kode manapun — kode ini publik di GitHub, Secret Key harus tetap rahasia, cuma boleh ada di Firebase Console.
7. **Jangan langsung nyalain toggle "Enforce"** di App Check untuk Firestore. Biarkan dulu di mode default (monitor-only) beberapa hari, cek tab **Requests** di App Check buat pastikan traffic asli (customer & admin) memang dapat token *verified* — baru nyalain Enforce kalau sudah yakin, supaya tidak keburu ngeblokir pengguna sah gara-gara salah setup.

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
- **Link chat langsung** (mis. buat bio WhatsApp/QR code) — dua format, sama-sama valid:
  - Bersih: `https://gabfx09.github.io/Livechat/WORKSPACE_ID/`
  - Atau: `https://gabfx09.github.io/Livechat/?w=WORKSPACE_ID`
- **Snippet widget** untuk ditempel di website mereka — lihat bagian "Widget untuk website perusahaan" di bawah.

### 4e. Alternatif: signup mandiri pakai kode undangan (tidak perlu 4a-4c manual)

Ada juga `signup.html` — perusahaan baru bisa bikin akun admin + workspace-nya **sendiri**, asal punya kode undangan yang Anda buat dulu. Cocok kalau tidak mau bolak-balik Firebase Console tiap ada perusahaan baru, tapi tetap mau kontrol siapa yang boleh gabung (bukan signup terbuka bebas).

1. **Bikin kode undangan** — **Firestore Database > Data** → **Start collection** (atau masuk ke collection `inviteCodes` yang sudah ada) → Collection ID: `inviteCodes` → Document ID: **ketik kode bebas yang mudah dibagikan**, mis. `TOKOABC2026` (jangan Auto-ID, supaya kodenya gampang diketik ulang oleh penerima) → tambahkan field:
   - `used` (boolean) = `false`
   - `usedByUid` (null)
   - `usedAt` (null)
   - `claimedWorkspaceId` (null)

   Klik **Save**. Kode ini sekali pakai — begitu ada yang signup pakai kode ini, otomatis terkunci (`used` jadi `true`) dan tidak bisa dipakai lagi buat bikin workspace lain.

2. **Bagikan** kode itu + link `https://gabfx09.github.io/Livechat/signup.html` ke perusahaan yang bersangkutan.
3. Mereka isi form (kode undangan, nama perusahaan, nama tampilan admin, email, password) → klik **Daftar & Buat Workspace** → otomatis dapat akun admin + workspace baru, langsung diarahkan ke `admin.html`. Hasilnya identik dengan yang dibuat manual lewat 4a-4c (workspace ID di-generate otomatis, bisa dilihat lewat Firestore Console kalau perlu link chat/widget-nya).

**Kalau signup gagal di tengah jalan** (mis. koneksi putus setelah kode terpakai tapi sebelum workspace-nya lengkap terbentuk) — app ini statis tanpa backend jadi tidak ada rollback otomatis. Kode itu jadi "terbakar" percuma; solusinya buat kode undangan baru, atau reset manual field `used`/`usedByUid`/`usedAt`/`claimedWorkspaceId` dokumen kode itu balik ke kondisi awal (`false`/`null`) lewat Firestore Console kalau workspace setengah-jadinya juga sudah dibersihkan manual.

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

**Catatan teknis soal URL bersih** (`/Livechat/WORKSPACE_ID/`): karena GitHub Pages tidak mendukung URL dinamis, ini disiasati lewat file `404.html` (isinya sama seperti `index.html`, dengan path aset absolut) — GitHub Pages otomatis menampilkan `404.html` untuk path apa pun yang tidak match file/folder asli, lalu `customer.js` membaca ID workspace dari segmen terakhir URL. Kalau nanti ganti nama repo GitHub, update juga `BASE_SEGMENTS`/path absolut di `404.html` dan `js/customer.js` supaya tetap cocok.

Cara kerjanya:
- Muncul bubble 💬 melayang di pojok kanan bawah, warna & nama sesuai `themeColor`/`brandName` yang diisi di config.
- Diklik → di **desktop** muncul jendela chat kecil melayang; di **mobile** (layar ≤640px) otomatis full-screen dalam halaman yang sama (tanpa pindah tab).
- Bisa dipasang di domain mana pun (bukan cuma GitHub Pages), karena cukup memuat `index.html?w=WORKSPACE_ID` lewat iframe.
- `workspaceId` **wajib diisi** — kalau kosong, widget tidak akan muncul (dicatat sebagai error di console browser).
- Kalau `brandName`/`themeColor` tidak diisi, widget pakai default ("Live Chat", biru `#5b8cff`).

## Fitur

- **Suara notifikasi admin**: dashboard admin berbunyi otomatis saat ada pesan baru dari customer (hanya pesan yang datang setelah admin login).
- **Notifikasi desktop**: browser akan minta izin notifikasi begitu admin klik/ketik pertama kali setelah login. Kalau diizinkan, popup notifikasi OS muncul untuk pesan baru selama tab admin masih kebuka (walau di-minimize/pindah tab) — tidak muncul kalau tab sedang aktif & difokus. Ini bukan push notification asli (butuh Cloud Functions/Blaze), jadi tetap tidak jalan kalau tab/browser-nya benar-benar ditutup.
- **Pengaturan admin**: klik ⚙ di rail kiri sidebar (paling bawah) untuk buka panel Pengaturan. Ada 3 tab:
  - **Profil**: ganti nama tampilan & foto profil admin, muncul di tiap balasan ke customer.
  - **Appearance**: atur nama brand, warna tema, dan ikon bubble yang tampil di widget chat website perusahaan — begitu disimpan, otomatis ikut berubah di widget (`js/widget.js`) tanpa perlu edit ulang snippet, dan juga ikut mewarnai halaman chat customer.
  - **Auto-Chat**: aktifkan sapaan otomatis yang langsung terkirim (dari sisi customer sendiri, ditandai `autoGreeting: true` di Firestore) begitu customer **baru** pertama kali mulai chat, sebelum mereka mengetik apa pun. Customer lama yang sudah pernah chat tidak dikirimi ulang. Isi juga "Pilihan Bantuan" (satu per baris) supaya menu tombol pilihan otomatis menyusul ~1 detik setelah sapaan — klik salah satu langsung terkirim sebagai pesan customer, tidak perlu ngetik. Tambahkan `Label :: Balasan` di baris yang sama supaya pilihan itu dapat balasan otomatis juga (~800ms setelah diklik, ditandai `autoReply: true`); tanpa `::` pilihannya tetap jadi tombol tapi tidak ada balasan.
  - **Riwayat**: daftar jejak audit tiap kali chat customer dihapus lewat tombol "Hapus Semua Chat" (siapa yang hapus, kapan, dan berapa pesan). Klik salah satu entri untuk buka lagi isi percakapan yang dihapus (disalin apa adanya ke `deletionLogs/{logId}/messages` sebelum chat aslinya dihapus). Semuanya read-only permanen, tidak bisa diedit/dihapus siapa pun demi menjaga keasliannya.
  - **Jam Operasional**: aktifkan untuk atur hari & jam buka (WIB). Di luar jam itu, customer lihat status "🌙 Sedang tidak online" (di halaman chat, layar login, dan header widget bubble) plus pesan penjelasan yang bisa diedit — tapi tetap bisa kirim pesan/tinggalkan chat seperti biasa, tidak diblokir.
  Tombol **Keluar** juga ada di dalam panel Pengaturan ini (bagian bawah).
- **Kirim gambar**: customer & admin bisa kirim gambar lewat ikon 🖼️, atau langsung **Ctrl+V** screenshot/gambar di kolom pesan (tidak perlu klik ikon dulu) — otomatis dikompres & disimpan langsung di Firestore (bukan Firebase Storage, supaya tetap gratis tanpa kartu kredit). Maks. sekitar 700KB per gambar.
- **Link otomatis jadi bisa diklik**: URL (`https://...` atau `www...`) di isi pesan mana pun otomatis dijadikan link `<a>` yang bisa diklik langsung (buka tab baru), baik dikirim admin maupun customer. Ditangani `js/text-utils.js`, tanpa `innerHTML` sama sekali supaya aman dari XSS.
- **Proteksi anti-spam/bot**: 3 lapis — (1) [App Check](#3b-opsional-tapi-disarankan-aktifkan-app-check-anti-spam) reCAPTCHA v3 buat filter request dari script; (2) honeypot field tersembunyi di form "Mulai Chat" (customer asli tidak mungkin ngisi, bot auto-fill biasanya iya); (3) Firestore rules nolak pesan customer yang lebih cepat dari 500ms sejak pesan sebelumnya, plus batas 4000 karakter per pesan teks.
- **Edit & hapus pesan (admin saja)**: arahkan kursor ke pesan balasan admin sendiri untuk lihat ikon ✏ (edit teks) dan 🗑 (hapus). Pesan dari customer tidak bisa diubah admin. Pesan yang diedit diberi label "(diedit)".
- **Arsip percakapan**: tab **Aktif**/**Arsip** di sidebar (ikon rail kiri: 💬/🗄). Otomatis pindah ke Arsip setelah **30 menit** tanpa pesan baru; admin juga bisa arsipkan/pulihkan manual lewat panel Info Customer. Customer yang diarsipkan lalu kirim pesan lagi otomatis pulih ke Aktif.
- **Auto-hapus arsip 1 tahun**: perlu setup TTL sekali di Firestore Console (**Firestore Database > TTL** → Create policy → Collection group: `customers`, Timestamp field: `expireAt`). Tanpa ini, data arsip tetap ada di tab Arsip tapi tidak pernah otomatis terhapus.
- **Ekspor chat ke .txt**: tombol "Ekspor Chat" di panel Info Customer (chat aktif) dan ikon ⬇ di header viewer Riwayat (chat yang sudah diarsipkan/dihapus) — men-download transkrip percakapan lengkap dengan timestamp WIB, langsung dari browser tanpa server.
- **Statistik "Respon Pertama" & "Rating Kepuasan"**: dashboard Statistik nampilin rata-rata waktu balasan pertama admin (dihitung dari pesan customer pertama di tiap sesi baru sampai balasan admin pertama) dan rata-rata rating, keduanya agregat 30 hari terakhir. Customer bisa kasih rating 1-5 ⭐ + komentar opsional kapan saja lewat ikon ⭐ di header chat (tidak terikat "akhiri chat" karena app ini tidak punya konsep sesi ditutup formal).
- **Info customer (admin saja)**: klik ℹ di header chat → panel kanan berisi nama, IP, kota, provinsi, negara (diambil otomatis dari [ipapi.co](https://ipapi.co)/ipwho.is, tidak terlihat customer).
- **Saved Replies**: tekan **Ctrl+/** (atau klik ⚡ di sebelah kolom pesan) untuk buka daftar balasan cepat tersimpan, bisa tambah/hapus sendiri. Mengetik 3+ huruf yang cocok dengan salah satu saved reply juga langsung memunculkan saran di atas kolom pesan (navigasi dengan panah atas/bawah, pilih dengan Enter/klik).
- **Navigasi keyboard**: **Alt + panah atas/bawah** untuk pindah antar chat customer tanpa klik mouse.
- **Dashboard Statistik**: klik ikon 📊 di rail kiri untuk lihat jumlah pesan hari ini (dengan perbandingan naik/turun dari kemarin), jumlah customer baru hari ini, dan grafik batang jumlah pesan 30 hari terakhir. Datanya dari counter harian (`stats/{YYYY-MM-DD}`) yang otomatis bertambah tiap ada pesan terkirim — jadi cuma menghitung aktivitas **sejak fitur ini dirilis**, histori sebelumnya tidak ikut terhitung.
- **Link per menu**: tiap menu di rail kiri admin punya URL sendiri lewat hash (`#/open`, `#/all`, `#/archived`, `#/stats`, `#/settings`) — mis. `admin.html#/settings` langsung membuka panel Pengaturan, `admin.html#/stats` langsung membuka Statistik. Bisa di-refresh/bookmark/share, dan tombol back/forward browser juga berfungsi untuk pindah antar menu.
- **Live typing preview (admin saja)**: saat customer sedang mengetik, admin bisa lihat draf ketikannya secara real-time (bukan cuma indikator "sedang mengetik") di atas kolom balas. Draf otomatis hilang begitu customer kirim pesan atau menghapus semua ketikannya. Catatan: ini fitur umum di tool livechat (LiveChat, Intercom, dll), tapi berarti admin melihat teks sebelum customer sempat membatalkan/menghapusnya — pertimbangkan untuk diinformasikan ke customer kalau relevan untuk kebijakan privasi Anda.
- **Signup mandiri pakai kode undangan** (`signup.html`): alternatif buat langkah 4a-4c yang manual — perusahaan baru bikin akun admin + workspace sendiri asal punya kode undangan sekali-pakai yang Anda buat dulu lewat Firestore Console. Lihat langkah 4e di atas untuk cara bikin kodenya.

## Testing

Situs ini tetap statis murni tanpa build step untuk deploy — tapi ada `package.json` + `test/` khusus buat development, dijalankan lokal lewat Node, tidak ikut ke-deploy ke GitHub Pages.

```bash
npm install   # sekali saja, install devDependencies
npm test      # unit test logika murni (parsing, format tanggal/durasi, deteksi link, jam operasional)
```

`npm test` pakai test runner bawaan Node (`node --test`), tanpa dependency tambahan buat unit test-nya sendiri — cuma `@firebase/rules-unit-testing` + `firebase` yang jadi devDependency, khusus buat test rules di bawah.

Fungsi-fungsi logika murni (tidak nyentuh DOM/Firebase) dipisah ke modul sendiri supaya gampang dites: `js/text-utils.js` (deteksi & linkify URL), `js/autochat-utils.js` (parsing textarea Auto-Chat), `js/hours-utils.js` (evaluasi jam operasional), `js/format-utils.js` (format durasi). Semuanya di-import balik oleh `admin.js`/`customer.js`, jadi bukan kode terpisah yang sengaja diduplikasi buat testing.

### Test Firestore rules (butuh Firestore Emulator)

```bash
npm run test:rules
```

Menjalankan `firestore.rules` lewat Firestore Emulator (auto-start via `firebase emulators:exec`) dan memverifikasi 50 skenario di 2 file: `test/rules/firestore.rules.test.js` (isolasi antar workspace, siapa boleh baca/tulis/hapus apa, rate limit anti-spam, batas panjang pesan, semua rule anti-spoofing berbasis `get()`/`exists()` buat sapaan/menu pilihan/balasan otomatis) dan `test/rules/signup.rules.test.js` (alur signup mandiri pakai kode undangan -- lihat langkah 4e di atas -- termasuk anti reuse kode & anti pembajakan workspace orang lain).

**Butuh Java Runtime** (dipakai Firestore Emulator, bukan bagian dari app-nya sendiri). Kalau belum ada:
```powershell
winget install --id EclipseAdoptium.Temurin.21.JRE -e
```
Lalu buka terminal baru (supaya PATH ke-refresh) sebelum jalankan `npm run test:rules`.

## Catatan keamanan & isolasi data antar perusahaan

- Setiap workspace terisolasi lewat Firestore rules: admin workspace A tidak bisa membaca/menulis data workspace B sama sekali (dicek lewat `exists(workspaces/{id}/admins/{uid})` yang scoped ke `workspaceId` masing-masing).
- `adminIndex/{uid}` dan dokumen `admins` di dalam tiap workspace **hanya bisa dibuat manual lewat Firebase Console** — tidak ada cara bagi siapa pun untuk mengangkat dirinya sendiri jadi admin lewat aplikasi.
- Sisi customer pakai Firebase Anonymous Auth: siapa pun yang buka link/widget suatu workspace bisa mulai chat dengan username apa saja — ini memang perilaku wajar untuk widget customer service publik.
- `admin.html` tidak ditautkan dari `index.html` manapun, tapi ini cuma "security by obscurity" tambahan — pengaman sesungguhnya ada di kombinasi login + Firestore rules di atas.
- Menggunakan tier gratis Firebase (Spark plan). Untuk jumlah workspace/traffic yang besar, pantau kuota Firestore (jumlah baca/tulis) di Firebase Console — kalau mendekati limit gratis, perlu upgrade ke Blaze (bayar sesuai pakai).

# LiveChat — Customer Service

Website live chat untuk customer service. Pengunjung situs (`index.html`) cukup masukkan nama lalu langsung chat dengan admin — tanpa perlu registrasi. Admin (`admin.html`) login dengan email & password, lalu melihat daftar semua percakapan customer dan membalasnya secara real-time.

Situs ini murni HTML/CSS/JS statis (tanpa proses build), sehingga bisa langsung di-hosting gratis lewat GitHub Pages. Data chat disimpan di Firebase Firestore (realtime, gratis).

Live: https://gabfx09.github.io/Livechat/ (customer) dan https://gabfx09.github.io/Livechat/admin.html (admin)

## 1. Buat project Firebase

1. Buka https://console.firebase.google.com dan login dengan akun Google Anda.
2. Klik **Add project**, beri nama bebas, lanjutkan sampai selesai.
3. Tambahkan **Web App** (`</>`), salin objek `firebaseConfig` yang muncul.
4. Isikan nilai-nilai itu ke `js/firebase-config.js` di project ini.

## 2. Aktifkan metode login

Di Firebase Console, buka **Authentication** (kategori **Security**) → tab **Sign-in method**:

1. Aktifkan **Anonymous** — ini dipakai untuk sisi customer (tanpa form login).
2. Aktifkan juga **Email/Password** — ini dipakai untuk sisi admin.

## 3. Buat Firestore Database

1. Buka **Firestore Database** (kategori **Databases and storage**) → **Create database**.
2. Pilih **Standard edition** → lokasi server terdekat → **Start in production mode**.
3. Buka tab **Rules**, hapus isi default, tempel seluruh isi file `firestore.rules` dari project ini, klik **Publish**.

## 4. Buat akun admin (WAJIB, hanya sekali)

Admin **tidak bisa daftar sendiri** lewat website (disengaja, demi keamanan — supaya sembarang orang tidak bisa masuk ke dashboard admin dan melihat semua chat customer). Buat manual lewat Firebase Console:

1. Buka **Authentication > Users** → klik **Add user**.
2. Isi email & password untuk admin (mis. email Anda sendiri) → **Add user**.
3. Setelah user dibuat, salin **User UID**-nya (kolom paling kanan di tabel user).
4. Buka **Firestore Database > Data** → klik **Start collection**.
   - Collection ID: `admins`
   - Document ID: tempel **User UID** yang tadi disalin (jangan pakai "Auto-ID")
   - Tambahkan satu field bebas, misal field `role` (type: string) isi `admin`.
   - Klik **Save**.

Sekarang akun tadi bisa dipakai untuk login di halaman `admin.html`. Ulangi langkah ini (buat user + tambah dokumen di `admins`) kalau ingin admin lebih dari satu.

## 5. Coba jalankan secara lokal (opsional tapi disarankan)

Karena kode memakai ES Modules, membuka file HTML langsung dengan cara double-click (`file://`) tidak akan berfungsi. Jalankan lewat server lokal:

```bash
npx serve .
# atau: python -m http.server 8080
```

Lalu buka:
- `http://localhost:8080/` (atau `:8080`) — sisi customer, masukkan nama, kirim pesan.
- `http://localhost:8080/admin.html` — sisi admin, login dengan email/password dari langkah 4, balas pesan customer tadi.

## 6. Upload ke GitHub & aktifkan GitHub Pages

```bash
git add .
git commit -m "Update ke customer service livechat"
git push
```

Kalau repo belum pernah dihubungkan ke GitHub, lihat riwayat commit sebelumnya atau jalankan:
```bash
git remote add origin https://github.com/USERNAME/NAMA-REPO.git
git push -u origin main
```

Aktifkan GitHub Pages di **Settings > Pages** → **Source: Deploy from a branch** → branch `main`, folder `/ (root)` → **Save**.

## Fitur tambahan (v2)

- **Suara notifikasi admin**: dashboard admin akan berbunyi otomatis saat ada pesan baru masuk dari customer (hanya untuk pesan yang datang *setelah* admin login, tidak untuk histori lama).
- **Pengaturan admin**: klik ikon ⚙ di sidebar admin untuk mengganti nama tampilan dan foto profil. Nama & foto ini akan muncul di setiap balasan yang dikirim ke customer.
- **Kirim gambar**: baik customer maupun admin bisa kirim gambar lewat ikon 📎 di sebelah kolom pesan. Gambar otomatis dikecilkan & dikompres di browser sebelum disimpan (maks. sekitar 700KB), karena disimpan langsung di Firestore (bukan Firebase Storage) supaya tetap 100% gratis tanpa perlu kartu kredit/upgrade paket.

- **Edit & hapus pesan (admin saja)**: arahkan kursor ke pesan balasan admin sendiri untuk melihat ikon ✏ (edit, khusus pesan teks) dan 🗑 (hapus). Customer maupun pesan dari customer tidak bisa diedit/dihapus. Pesan yang sudah diedit akan ada label "(diedit)" di kedua sisi.
- **Arsip percakapan**: sidebar admin sekarang punya tab **Aktif** dan **Arsip**. Percakapan otomatis pindah ke Arsip kalau sudah **30 menit** tanpa pesan baru dari admin maupun customer (dicek tiap ada aktivitas + tiap 1 menit lewat timer). Admin juga bisa arsipkan/pulihkan manual lewat tombol di panel Info Customer (klik ikon ℹ). Kalau customer yang sudah diarsipkan kirim pesan lagi, otomatis pulih ke Aktif.
- **Auto-hapus arsip setelah 1 tahun**: perlu **setup satu kali** di Firebase Console supaya benar-benar berjalan (kode saja tidak cukup, ini pakai fitur bawaan Firestore bernama TTL/Time-to-Live):
  1. Buka **Firestore Database** → cari tab **TTL** (kadang di bawah menu "..." atau di sebelah tab Rules/Indexes, tergantung versi console).
  2. Klik **Create policy** (atau serupa).
  3. **Collection group**: isi `customers`.
  4. **Timestamp field**: isi `expireAt`.
  5. Simpan.
  
  Setelah itu, dokumen customer yang diarsipkan akan otomatis terhapus Firestore dalam waktu 1 tahun sejak diarsipkan (penghapusan oleh Firestore biasanya tidak instan, bisa berjarak s.d. 72 jam dari waktu kedaluwarsa — ini perilaku normal fitur TTL). Kalau langkah TTL ini belum di-setup, percakapan akan tetap pindah ke tab Arsip seperti biasa, hanya saja tidak akan pernah otomatis terhapus dari database.

  **Catatan teknis:** yang terhapus otomatis oleh TTL adalah dokumen `customers/{id}` (sehingga hilang dari tampilan Arsip). Sub-koleksi pesannya (`chats/{id}/messages`) tidak ikut terhapus otomatis oleh Firestore (ini batasan dari fitur TTL Firestore, bukan sesuatu yang bisa diatur dari sisi kode tanpa Cloud Functions berbayar) — datanya jadi tidak lagi bisa diakses lewat aplikasi, tapi secara teknis masih tersimpan di database. Untuk skala personal/kecil ini tidak masalah.

- **Info customer (admin saja)**: klik ikon ℹ di header chat untuk membuka panel kanan berisi nama, alamat IP, kota, provinsi, dan negara customer. Data ini diambil otomatis dari browser customer lewat layanan publik [ipapi.co](https://ipapi.co) (gratis, tanpa API key, tanpa perlu izin browser) saat customer mulai chat — tidak terlihat sama sekali di sisi customer. Catatan: layanan gratis ini punya batas pemakaian (~30rb request/bulan), cukup untuk skala kecil-menengah; kalau lookup gagal (mis. limit habis), field-nya cukup kosong ("-") tanpa mengganggu chat.

**Penting:** karena `firestore.rules` berubah beberapa kali (menambah izin admin mengedit profilnya sendiri, validasi field `type` pada pesan, dan sekarang izin edit/hapus pesan sendiri), rules yang lama di Firebase Console **harus di-republish** dengan isi file `firestore.rules` yang terbaru, kalau belum dilakukan. Catatan: pesan admin yang dikirim **sebelum** update ini tidak akan bisa diedit/dihapus (belum punya field `senderId`), hanya pesan baru setelahnya.

## Widget untuk website perusahaan

Supaya livechat ini muncul sebagai bubble chat melayang di website perusahaan Anda (seperti Chaport/Tawk.to), tempel snippet ini sebelum tag `</body>` di HTML website Anda:

```html
<!-- Begin LiveChat Widget -->
<script src="https://gabfx09.github.io/Livechat/js/widget.js" async></script>
<!-- End LiveChat Widget -->
```

Cara kerjanya:
- Muncul bubble 💬 melayang di pojok kanan bawah di semua halaman yang memasang snippet ini.
- Diklik → terbuka jendela chat kecil (iframe) di desktop, atau layar penuh di HP (lebar layar ≤640px) — supaya nyaman dipakai di mobile tanpa pindah tab/halaman.
- Bisa dipasang di website mana pun (domain berbeda dari GitHub Pages), karena cukup memuat `index.html` lewat iframe dari `https://gabfx09.github.io/Livechat/`.
- Kalau nanti ganti nama repo/username GitHub, update juga `CHAT_ORIGIN` di `js/widget.js`.
- Warna bubble/header dan nama brand bisa diatur lewat 3 variabel di baris paling atas `js/widget.js`: `THEME_COLOR` (kode hex warna), `BRAND_NAME` (nama di header jendela chat), `BUBBLE_ICON` (emoji tombol bubble).
- Untuk kebutuhan link langsung (tanpa widget) di HP — misal tombol "Chat via HP", bio WhatsApp, atau QR code — bisa langsung pakai URL `https://gabfx09.github.io/Livechat/`, tidak perlu setup tambahan.

## Catatan keamanan & batasan

- Sisi customer pakai Firebase Anonymous Auth: siapa pun yang buka link bisa mulai chat dengan nama apa saja (termasuk nama yang sama dengan orang lain).
- Sisi admin dilindungi dua lapis: harus login email/password yang benar, **dan** UID-nya harus terdaftar di collection `admins` (yang hanya bisa ditambahkan manual lewat Firebase Console, tidak lewat aplikasi).
- Firestore rules (`firestore.rules`) memastikan tiap customer hanya bisa membaca chat miliknya sendiri; hanya admin yang bisa membaca semua chat.
- Halaman `admin.html` memang tidak ditautkan dari mana pun di `index.html` — cukup diakses lewat URL langsung oleh admin. Ini bukan pengaman utama (siapa pun bisa menebak URL-nya), pengaman sesungguhnya ada di login + Firestore rules di atas.
- Ini menggunakan tier gratis Firebase (Spark plan), cukup untuk pemakaian personal/kecil.

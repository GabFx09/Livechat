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

## Catatan keamanan & batasan

- Sisi customer pakai Firebase Anonymous Auth: siapa pun yang buka link bisa mulai chat dengan nama apa saja (termasuk nama yang sama dengan orang lain).
- Sisi admin dilindungi dua lapis: harus login email/password yang benar, **dan** UID-nya harus terdaftar di collection `admins` (yang hanya bisa ditambahkan manual lewat Firebase Console, tidak lewat aplikasi).
- Firestore rules (`firestore.rules`) memastikan tiap customer hanya bisa membaca chat miliknya sendiri; hanya admin yang bisa membaca semua chat.
- Halaman `admin.html` memang tidak ditautkan dari mana pun di `index.html` — cukup diakses lewat URL langsung oleh admin. Ini bukan pengaman utama (siapa pun bisa menebak URL-nya), pengaman sesungguhnya ada di login + Firestore rules di atas.
- Ini menggunakan tier gratis Firebase (Spark plan), cukup untuk pemakaian personal/kecil.

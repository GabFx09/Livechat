# LiveChat

Website live chat 1-on-1 sederhana. Cukup masukkan nama panggilan, lalu pilih orang lain yang sedang online untuk mengobrol secara real-time. Tidak ada form registrasi/password — di baliknya memakai Firebase Anonymous Auth secara otomatis.

Situs ini murni HTML/CSS/JS statis (tanpa proses build), sehingga bisa langsung di-hosting gratis lewat GitHub Pages. Data chat & daftar user disimpan di Firebase Firestore (realtime, gratis).

## 1. Buat project Firebase

1. Buka https://console.firebase.google.com dan login dengan akun Google Anda.
2. Klik **Add project**, beri nama bebas (mis. `livechat-saya`), lanjutkan sampai selesai (Google Analytics boleh dimatikan).
3. Di sidebar kiri, klik ikon `</>` (Web) untuk **menambahkan Web App** ke project ini. Beri nickname app bebas, klik **Register app**.
4. Firebase akan menampilkan objek `firebaseConfig` seperti ini:
   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "livechat-saya.firebaseapp.com",
     projectId: "livechat-saya",
     storageBucket: "livechat-saya.appspot.com",
     messagingSenderId: "...",
     appId: "..."
   };
   ```
   Salin nilai-nilai ini.

## 2. Isi konfigurasi di kode

Buka file `js/firebase-config.js`, ganti semua nilai `"GANTI_DENGAN_..."` dengan nilai asli dari langkah 1.

## 3. Aktifkan Anonymous Authentication

1. Di Firebase Console, buka menu **Build > Authentication**.
2. Klik **Get started**.
3. Pada tab **Sign-in method**, pilih **Anonymous**, aktifkan (Enable), lalu **Save**.

## 4. Buat Firestore Database

1. Di Firebase Console, buka menu **Build > Firestore Database**.
2. Klik **Create database**.
3. Pilih lokasi server terdekat (mis. `asia-southeast2`), lalu pilih **Start in production mode**.
4. Setelah database dibuat, buka tab **Rules**, hapus isi default, lalu tempel (copy-paste) seluruh isi file `firestore.rules` dari project ini. Klik **Publish**.

## 5. Coba jalankan secara lokal (opsional tapi disarankan)

Karena kode memakai ES Modules, membuka `index.html` langsung dengan cara double-click (`file://`) tidak akan berfungsi. Jalankan lewat server lokal, misalnya:

```bash
# jika punya Python
python -m http.server 8080

# atau jika punya Node.js
npx serve .
```

Lalu buka `http://localhost:8080` di dua tab/browser berbeda, masukkan nama panggilan berbeda di masing-masing, dan coba saling chat.

## 6. Upload ke GitHub & aktifkan GitHub Pages

1. Buat repository baru di https://github.com/new (mis. nama `livechat`). **Jangan** centang "Add a README" (repo ini sudah punya).
2. Di folder project ini, jalankan:
   ```bash
   git init
   git add .
   git commit -m "Initial commit: livechat app"
   git branch -M main
   git remote add origin https://github.com/USERNAME/livechat.git
   git push -u origin main
   ```
   Ganti `USERNAME` dan nama repo sesuai punya Anda.
3. Di halaman repo GitHub, buka **Settings > Pages**.
4. Pada **Build and deployment > Source**, pilih **Deploy from a branch**.
5. Pada **Branch**, pilih `main` dan folder `/ (root)`, klik **Save**.
6. Tunggu 1-2 menit, lalu situs akan online di:
   ```
   https://USERNAME.github.io/livechat/
   ```

## Catatan keamanan & batasan

- Tidak ada verifikasi identitas nyata: siapa pun yang membuka link bisa memilih nama panggilan apa saja (termasuk nama yang sama dengan orang lain).
- Firestore rules membatasi agar isi chat 1-on-1 hanya bisa dibaca oleh dua pihak yang terlibat (lihat `firestore.rules`), tapi daftar nama user bersifat publik untuk semua yang login.
- Ini menggunakan tier gratis Firebase (Spark plan), cukup untuk pemakaian personal/kecil.

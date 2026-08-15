// Sampling grid piksel, bukan scan penuh, supaya tidak lambat di gambar
// besar -- 12x12 titik cukup buat mendeteksi "kanvas cuma fillRect putih,
// drawImage tidak menggambar apa-apa" karena foto asli nyaris mustahil
// 100% putih rata persis di semua titik sampel itu sekaligus.
function isCanvasBlank(ctx, width, height) {
  const cols = 12;
  const rows = 12;
  for (let row = 0; row < rows; row++) {
    const y = Math.min(height - 1, Math.floor(((row + 0.5) * height) / rows));
    for (let col = 0; col < cols; col++) {
      const x = Math.min(width - 1, Math.floor(((col + 0.5) * width) / cols));
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
      if (r !== 255 || g !== 255 || b !== 255) return false;
    }
  }
  return true;
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

// Mengubah file gambar jadi data URL base64 yang sudah dikecilkan & dikompres,
// supaya muat disimpan sebagai field dokumen Firestore (batas 1MB per dokumen).
export async function compressImageFile(
  file,
  { maxDimension = 1200, maxDataUrlLength = 700000, mimeType = "image/jpeg" } = {}
) {
  if (!file.type.startsWith("image/")) {
    throw new Error("File yang dipilih bukan gambar.");
  }
  // HEIC/HEIF (format foto default iPhone) tidak bisa didekode lewat
  // <img>/canvas di hampir semua browser selain Safari -- daripada gagal
  // diam-diam lewat img.onerror di bawah dengan pesan generik, kasih tahu
  // penyebabnya langsung supaya customer tahu harus ganti format.
  if (/^image\/hei(c|f)/.test(file.type) || /\.hei(c|f)$/i.test(file.name || "")) {
    throw new Error(
      "Format HEIC/HEIF belum didukung. Ubah pengaturan kamera ke JPG (\"Paling Kompatibel\") atau kirim sebagai screenshot."
    );
  }

  // img.onload bisa saja tetap terpanggil dengan naturalWidth/Height 0 kalau
  // filenya rusak/format aneh (bukan selalu img.onerror) -- baseW/baseH 0
  // berarti <img> ini tidak bisa dipakai sebagai sumber gambar sama sekali,
  // lanjut ke rung-loop di bawah dilewati, langsung ke fallback mentah.
  const img = await loadImageFile(file).catch(() => null);
  const baseW = img?.naturalWidth || 0;
  const baseH = img?.naturalHeight || 0;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  function dimsForTarget(target) {
    if (baseW <= target && baseH <= target) return { width: baseW, height: baseH };
    if (baseW >= baseH) {
      return { width: target, height: Math.round((baseH * target) / baseW) };
    }
    return { height: target, width: Math.round((baseW * target) / baseH) };
  }

  function drawAndCheck(src, width, height) {
    canvas.width = width;
    canvas.height = height;
    // Isi latar putih dulu -- JPEG tidak punya kanal alpha, jadi tanpa ini
    // area transparan (PNG berlatar transparan, atau gambar yang gagal
    // digambar penuh) akan diekspor jadi hitam solid oleh toDataURL.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(src, 0, 0, width, height);
    return !isCanvasBlank(ctx, width, height);
  }

  // Foto HP modern gampang 12-48MP -- decode+drawImage di resolusi besar
  // kadang diam-diam GAGAL menggambar isinya di browser/WebView mobile
  // tertentu (limit memori decode), tanpa melempar error -- hasilnya kanvas
  // kosong/putih yang dulu malah ikut terkirim ke chat. Daripada menolak
  // kirim (customer HARUS bisa kirim gambar apa pun, seperti WhatsApp),
  // di sini dicoba turun bertahap ke resolusi target yang lebih kecil --
  // makin kecil target decode-nya, makin kecil juga kebutuhan memorinya,
  // jadi jauh lebih mungkin berhasil -- sambil tetap dicoba dua jalur
  // decode di tiap ukuran (createImageBitmap resize dulu karena paling
  // hemat memori, baru <img>+canvas biasa sebagai cadangan).
  const rungs = [...new Set([maxDimension, 800, 500, 300, 150])]
    .filter((d) => d <= maxDimension)
    .sort((a, b) => b - a);

  let width, height, drawn = false;
  if (baseW && baseH) {
    for (const target of rungs) {
      const dims = dimsForTarget(target);
      if (typeof createImageBitmap === "function") {
        try {
          const bitmap = await createImageBitmap(file, {
            resizeWidth: dims.width,
            resizeHeight: dims.height,
            resizeQuality: "high"
          });
          const ok = drawAndCheck(bitmap, dims.width, dims.height);
          if (typeof bitmap.close === "function") bitmap.close();
          if (ok) {
            width = dims.width;
            height = dims.height;
            drawn = true;
            break;
          }
        } catch (err) {
          // lanjut coba jalur <img> di bawah untuk ukuran target yang sama
        }
      }
      if (drawAndCheck(img, dims.width, dims.height)) {
        width = dims.width;
        height = dims.height;
        drawn = true;
        break;
      }
    }
  }

  if (!drawn) {
    // Upaya terakhir: semua ukuran & jalur decode gagal (atau <img> sama
    // sekali tidak bisa dipakai) -- daripada gagal terkirim, kirim file
    // ASLINYA apa adanya tanpa resize/kompresi kanvas sama sekali (murni
    // baca-bytes lewat FileReader, tidak lewat decode gambar jadi tidak
    // kena masalah yang sama). Cuma bisa gagal kalau file mentahnya juga
    // melebihi batas ukuran field Firestore -- satu-satunya kasus yang
    // masih bisa tidak terkirim, seharusnya sangat jarang.
    const rawDataUrl = await fileToDataUrl(file);
    if (rawDataUrl.length <= maxDataUrlLength) {
      return rawDataUrl;
    }
    throw new Error("Gambar terlalu besar dan gagal diproses. Coba kirim gambar lain yang lebih kecil.");
  }

  let quality = 0.85;
  let dataUrl = canvas.toDataURL(mimeType, quality);
  while (dataUrl.length > maxDataUrlLength && quality > 0.25) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL(mimeType, quality);
  }

  if (dataUrl.length > maxDataUrlLength) {
    throw new Error("Gambar terlalu besar meskipun sudah dikompres. Coba gambar lain yang lebih kecil.");
  }

  return dataUrl;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Sama seperti compressImageFile, tapi GIF dilewatkan apa adanya (dibaca
// langsung jadi data URL, bukan digambar ulang ke canvas) supaya animasinya
// tidak ikut hilang -- canvas.toDataURL cuma bisa ambil 1 frame statis dari
// GIF. Dipakai buat gambar bubble widget yang boleh berupa GIF animasi.
export async function compressImageOrPassthroughGif(file, options = {}) {
  if (file.type === "image/gif") {
    const maxBytes = options.maxGifBytes || 300000;
    if (file.size > maxBytes) {
      throw new Error(
        `GIF terlalu besar (maks ${Math.round(maxBytes / 1000)}KB supaya tidak memperlambat loading website). Coba GIF lain yang lebih kecil.`
      );
    }
    return fileToDataUrl(file);
  }
  return compressImageFile(file, options);
}

export function showImageLightbox(dataUrl) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay lightbox";
  const img = document.createElement("img");
  img.src = dataUrl;
  img.className = "lightbox-image";
  overlay.appendChild(img);
  overlay.addEventListener("click", () => overlay.remove());
  document.body.appendChild(overlay);
}

// Dipakai sebelum gambar (dari klik ikon 🖼️ ATAU paste Ctrl+V) beneran
// terkirim -- kasih kesempatan lihat dulu & batal, jangan langsung nyelonong
// ke chat begitu file dipilih/di-paste. Dibikin dinamis (bukan markup statis
// di HTML) sama seperti showImageLightbox di atas, supaya tidak perlu
// diduplikasi ke index.html/404.html/admin/index.html sekaligus.
export function showImageSendConfirm(dataUrl) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const card = document.createElement("div");
    card.className = "modal-card image-confirm-card";

    const heading = document.createElement("h2");
    heading.textContent = "Kirim gambar ini?";
    card.appendChild(heading);

    const img = document.createElement("img");
    img.src = dataUrl;
    img.className = "image-confirm-preview";
    card.appendChild(img);

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn-secondary";
    cancelBtn.textContent = "Batal";

    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.textContent = "Kirim";

    actions.appendChild(cancelBtn);
    actions.appendChild(sendBtn);
    card.appendChild(actions);
    overlay.appendChild(card);

    function close(result) {
      overlay.remove();
      document.removeEventListener("keydown", onKeydown);
      resolve(result);
    }
    function onKeydown(e) {
      if (e.key === "Escape") {
        close(false);
      } else if (e.key === "Enter") {
        // preventDefault supaya kalau fokus masih di message-input (bekas
        // paste Ctrl+V), Enter tidak juga ke-submit ke form kirim pesan teks
        // -- cukup jadi "Kirim" buat dialog konfirmasi ini.
        e.preventDefault();
        close(true);
      }
    }

    cancelBtn.addEventListener("click", () => close(false));
    sendBtn.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
    });
    document.addEventListener("keydown", onKeydown);

    document.body.appendChild(overlay);
    sendBtn.focus();
  });
}

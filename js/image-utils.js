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

  const img = await loadImageFile(file);
  let width = img.naturalWidth;
  let height = img.naturalHeight;

  if (width > maxDimension || height > maxDimension) {
    if (width >= height) {
      height = Math.round((height * maxDimension) / width);
      width = maxDimension;
    } else {
      width = Math.round((width * maxDimension) / height);
      height = maxDimension;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(img, 0, 0, width, height);

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

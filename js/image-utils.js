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

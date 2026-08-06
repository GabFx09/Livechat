const URL_REGEX = /((?:https?:\/\/|www\.)[^\s<]+[^\s<.,:;"')\]!?])/gi;

// Taruh isi pesan ke dalam elemen sebagai campuran teks biasa + link <a>
// yang bisa diklik, tanpa lewat innerHTML sama sekali (aman dari XSS karena
// setiap potongan cuma diisi lewat textContent/createTextNode, bukan HTML
// mentah). Dipakai bareng oleh customer.js & admin.js biar konsisten.
export function renderTextWithLinks(container, text) {
  if (!text) return;

  let lastIndex = 0;
  let match;
  URL_REGEX.lastIndex = 0;

  while ((match = URL_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }

    const url = match[0];
    const a = document.createElement("a");
    a.href = url.startsWith("http") ? url : "https://" + url;
    a.textContent = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "msg-link";
    container.appendChild(a);

    lastIndex = URL_REGEX.lastIndex;
  }

  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

const URL_REGEX = /((?:https?:\/\/|www\.)[^\s<]+[^\s<.,:;"')\]!?])/gi;

// Bagian yang beneran berisi logika (deteksi URL) dipisah dari yang megang
// DOM, supaya bisa dites langsung di Node tanpa perlu jsdom/browser --
// lihat test/text-utils.test.js.
export function splitTextAndLinks(text) {
  const parts = [];
  if (!text) return parts;

  let lastIndex = 0;
  let match;
  URL_REGEX.lastIndex = 0;

  while ((match = URL_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }
    const url = match[0];
    parts.push({ type: "link", value: url, href: url.startsWith("http") ? url : "https://" + url });
    lastIndex = URL_REGEX.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push({ type: "text", value: text.slice(lastIndex) });
  }

  return parts;
}

// Taruh isi pesan ke dalam elemen sebagai campuran teks biasa + link <a>
// yang bisa diklik, tanpa lewat innerHTML sama sekali (aman dari XSS karena
// setiap potongan cuma diisi lewat textContent/createTextNode, bukan HTML
// mentah). Dipakai bareng oleh customer.js & admin.js biar konsisten.
export function renderTextWithLinks(container, text) {
  splitTextAndLinks(text).forEach((part) => {
    if (part.type === "link") {
      const a = document.createElement("a");
      a.href = part.href;
      a.textContent = part.value;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = "msg-link";
      container.appendChild(a);
    } else {
      container.appendChild(document.createTextNode(part.value));
    }
  });
}

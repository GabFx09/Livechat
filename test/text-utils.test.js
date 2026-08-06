import { test } from "node:test";
import assert from "node:assert/strict";
import { splitTextAndLinks, renderTextWithLinks } from "../js/text-utils.js";

test("splitTextAndLinks: teks tanpa link balik apa adanya", () => {
  const parts = splitTextAndLinks("halo, ada yang bisa dibantu?");
  assert.deepEqual(parts, [{ type: "text", value: "halo, ada yang bisa dibantu?" }]);
});

test("splitTextAndLinks: teks kosong/null balik array kosong", () => {
  assert.deepEqual(splitTextAndLinks(""), []);
  assert.deepEqual(splitTextAndLinks(null), []);
  assert.deepEqual(splitTextAndLinks(undefined), []);
});

test("splitTextAndLinks: satu link https di tengah kalimat", () => {
  const parts = splitTextAndLinks("cek https://example.com/produk ya");
  assert.deepEqual(parts, [
    { type: "text", value: "cek " },
    { type: "link", value: "https://example.com/produk", href: "https://example.com/produk" },
    { type: "text", value: " ya" }
  ]);
});

test("splitTextAndLinks: link www. tanpa skema dapat https:// otomatis", () => {
  const parts = splitTextAndLinks("kunjungi www.tokoabc.com sekarang");
  assert.equal(parts[1].type, "link");
  assert.equal(parts[1].value, "www.tokoabc.com");
  assert.equal(parts[1].href, "https://www.tokoabc.com");
});

test("splitTextAndLinks: tanda baca penutup kalimat tidak ikut ke dalam link", () => {
  const parts = splitTextAndLinks("info di https://example.com/a, dan https://example.com/b.");
  const links = parts.filter((p) => p.type === "link").map((p) => p.value);
  assert.deepEqual(links, ["https://example.com/a", "https://example.com/b"]);
});

test("splitTextAndLinks: beberapa link berturut-turut dipisah spasi", () => {
  const parts = splitTextAndLinks("https://a.com https://b.com");
  const links = parts.filter((p) => p.type === "link").map((p) => p.value);
  assert.deepEqual(links, ["https://a.com", "https://b.com"]);
});

// Stub DOM minimal (bukan jsdom) -- cuma implement method/property yang
// benar-benar dipakai renderTextWithLinks, cukup buat verifikasi wrapper-nya
// membangun node dengan benar tanpa perlu dependency tambahan.
function makeFakeContainer() {
  const children = [];
  return {
    children,
    appendChild(node) {
      children.push(node);
    }
  };
}

function withFakeDocument(fn) {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createTextNode: (text) => ({ nodeType: "text", textContent: text }),
    createElement: () => ({ nodeType: "element" })
  };
  try {
    fn();
  } finally {
    globalThis.document = originalDocument;
  }
}

test("renderTextWithLinks: bikin campuran text node & <a> sesuai splitTextAndLinks", () => {
  withFakeDocument(() => {
    const container = makeFakeContainer();
    renderTextWithLinks(container, "cek https://example.com ya");

    assert.equal(container.children.length, 3);
    assert.equal(container.children[0].textContent, "cek ");
    assert.equal(container.children[1].href, "https://example.com");
    assert.equal(container.children[1].textContent, "https://example.com");
    assert.equal(container.children[1].className, "msg-link");
    assert.equal(container.children[1].target, "_blank");
    assert.equal(container.children[2].textContent, " ya");
  });
});

test("renderTextWithLinks: teks kosong tidak nambah node apa pun", () => {
  withFakeDocument(() => {
    const container = makeFakeContainer();
    renderTextWithLinks(container, "");
    assert.equal(container.children.length, 0);
  });
});

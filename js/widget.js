(function () {
  var config = window.__livechatConfig || {};

  if (!config.workspaceId) {
    console.error("LiveChat widget: workspaceId belum diisi di window.__livechatConfig.");
    return;
  }

  var PROJECT_ID = "livechat-saya";
  var CHAT_ORIGIN = "https://gabfx09.github.io/Livechat";
  var CHAT_URL = CHAT_ORIGIN + "/index.html?w=" + encodeURIComponent(config.workspaceId);
  var MOBILE_BREAKPOINT = 640;

  if (document.getElementById("livechat-widget-bubble")) return; // sudah ada, jangan dobel

  // Nilai awal dari snippet config (kalau ada), supaya bubble langsung
  // tampil tanpa nunggu network. Nanti di-update otomatis begitu branding
  // dari Firestore (diatur admin lewat Pengaturan > Appearance) selesai
  // diambil, tanpa perlu edit ulang snippet ini di website.
  var themeColor = config.themeColor || "#5b8cff";
  var brandName = config.brandName || "Live Chat";
  var bubbleIcon = config.bubbleIcon || "💬";

  var isOpen = false;

  var bubble = document.createElement("button");
  bubble.id = "livechat-widget-bubble";
  bubble.type = "button";
  bubble.setAttribute("aria-label", "Buka " + brandName);
  bubble.textContent = bubbleIcon;

  var panel = document.createElement("div");
  panel.id = "livechat-widget-panel";

  var header = document.createElement("div");
  header.id = "livechat-widget-header";

  var headerTitle = document.createElement("span");
  headerTitle.textContent = brandName;

  var closeBtn = document.createElement("button");
  closeBtn.id = "livechat-widget-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Tutup chat");
  closeBtn.textContent = "✕";

  header.appendChild(headerTitle);
  header.appendChild(closeBtn);

  var iframe = document.createElement("iframe");
  iframe.id = "livechat-widget-iframe";
  iframe.title = brandName;
  iframe.allow = "clipboard-write";

  panel.appendChild(header);
  panel.appendChild(iframe);

  function isMobile() {
    return window.innerWidth <= MOBILE_BREAKPOINT;
  }

  // Di desktop, panel tampil sebagai jendela kecil melayang di pojok.
  // Di mobile, panel melebar penuh layar (mirip widget Chaport di HP)
  // supaya nyaman dipakai, tetap dalam halaman yang sama (bukan tab baru).
  function applyLayout() {
    if (isMobile()) {
      panel.classList.add("livechat-widget-fullscreen");
    } else {
      panel.classList.remove("livechat-widget-fullscreen");
    }
  }

  function openWidget() {
    if (!iframe.src) iframe.src = CHAT_URL;
    applyLayout();
    panel.classList.add("livechat-widget-open");
    bubble.classList.add("hidden");
    isOpen = true;
  }

  function closeWidget() {
    panel.classList.remove("livechat-widget-open");
    bubble.classList.remove("hidden");
    isOpen = false;
  }

  bubble.addEventListener("click", openWidget);
  closeBtn.addEventListener("click", closeWidget);
  window.addEventListener("resize", function () {
    if (isOpen) applyLayout();
  });

  var style = document.createElement("style");

  function buildStyleText(color) {
    return (
      "#livechat-widget-bubble{position:fixed;bottom:20px;right:20px;width:58px;height:58px;" +
      "border-radius:50%;background:" + color + ";color:#fff;border:none;font-size:26px;line-height:1;" +
      "cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35);z-index:2147483000;" +
      "display:flex;align-items:center;justify-content:center;transition:transform .15s ease;}" +
      "#livechat-widget-bubble:hover{transform:scale(1.06);}" +
      "#livechat-widget-bubble.hidden{display:none;}" +
      "#livechat-widget-panel{position:fixed;bottom:20px;right:20px;width:370px;height:560px;" +
      "max-height:80vh;background:#171a21;border-radius:14px;overflow:hidden;" +
      "box-shadow:0 16px 48px rgba(0,0,0,.5);display:flex;flex-direction:column;" +
      "z-index:2147483000;opacity:0;pointer-events:none;transform:translateY(12px);" +
      "transition:opacity .15s ease,transform .15s ease;}" +
      "#livechat-widget-panel.livechat-widget-open{opacity:1;pointer-events:auto;transform:translateY(0);}" +
      "#livechat-widget-header{flex-shrink:0;display:flex;align-items:center;justify-content:space-between;" +
      "padding:14px 16px;background:" + color + ";color:#fff;font-weight:600;" +
      "font-family:-apple-system,\"Segoe UI\",Roboto,Helvetica,Arial,sans-serif;}" +
      "#livechat-widget-close{background:transparent;border:none;color:#fff;font-size:16px;" +
      "cursor:pointer;line-height:1;padding:2px 4px;}" +
      "#livechat-widget-iframe{flex:1;border:none;width:100%;background:#171a21;}" +
      "#livechat-widget-panel.livechat-widget-fullscreen{top:0;left:0;right:0;bottom:0;" +
      "width:100%;height:100%;max-height:100%;border-radius:0;}" +
      "@media (max-width:640px){#livechat-widget-bubble{bottom:16px;right:16px;}}"
    );
  }

  style.textContent = buildStyleText(themeColor);
  document.head.appendChild(style);

  document.body.appendChild(bubble);
  document.body.appendChild(panel);

  // Ambil branding terbaru dari Firestore (kalau admin sudah atur lewat
  // Pengaturan > Appearance di dashboard), lalu perbarui tampilan widget
  // yang sedang tampil kalau ada yang beda dari snippet. Dokumen workspace
  // memang publik untuk keperluan ini (cuma berisi nama/warna/ikon, bukan data sensitif).
  var url =
    "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
    "/databases/(default)/documents/workspaces/" + encodeURIComponent(config.workspaceId);

  fetch(url)
    .then(function (res) {
      return res.ok ? res.json() : null;
    })
    .then(function (data) {
      if (!data || !data.fields) return;
      var f = data.fields;
      var liveBrandName = f.brandName && f.brandName.stringValue;
      var liveThemeColor = f.themeColor && f.themeColor.stringValue;
      var liveBubbleIcon = f.bubbleIcon && f.bubbleIcon.stringValue;

      if (liveBrandName && liveBrandName !== brandName) {
        brandName = liveBrandName;
        bubble.setAttribute("aria-label", "Buka " + brandName);
        headerTitle.textContent = brandName;
        iframe.title = brandName;
      }
      if (liveBubbleIcon && liveBubbleIcon !== bubbleIcon) {
        bubbleIcon = liveBubbleIcon;
        bubble.textContent = bubbleIcon;
      }
      if (liveThemeColor && liveThemeColor !== themeColor) {
        themeColor = liveThemeColor;
        style.textContent = buildStyleText(themeColor);
      }
    })
    .catch(function () {
      // Diamkan, tetap pakai nilai dari snippet config.
    });
})();

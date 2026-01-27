(function () {
  const title = byId("title");
  const content = byId("content");

  /** @type {{label:string, text:string, queue:string[]}|null} */
  let payload = null;

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function render() {
    if (!payload) return;
    title.textContent = payload.label || "";
    const text = payload.text || "";

    content.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === "set") {
      payload = msg.payload;
      render();
    }
  });

  function byId(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element: ${id}`);
    return el;
  }
})();

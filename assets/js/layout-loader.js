(function (window) {
  const PARTIAL_ATTR = 'data-partial';
  const htmlCache = new Map();
  let startAlpine;

  window.deferLoadingAlpine = function deferLoadingAlpine(callback) {
    startAlpine = callback;
  };

  async function getPartialHtml(url) {
    if (!htmlCache.has(url)) {
      htmlCache.set(
        url,
        fetch(url, { cache: 'no-cache' }).then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })
      );
    }
    return htmlCache.get(url);
  }

  async function loadPartial(node) {
    const url = node.getAttribute(PARTIAL_ATTR);
    if (!url) return;

    try {
      const html = await getPartialHtml(url);
      node.outerHTML = html;
    } catch (err) {
      console.error('[layout-loader] Failed to load partial:', url, err);
      node.outerHTML = `<div class="p-2 text-xs text-red-400">Partial load failed: ${url}</div>`;
    }
  }

  function collectPlaceholderNodes() {
    const direct = Array.from(document.querySelectorAll(`[${PARTIAL_ATTR}]`));
    const inTemplates = Array.from(document.querySelectorAll('template')).flatMap((tpl) =>
      Array.from(tpl.content.querySelectorAll(`[${PARTIAL_ATTR}]`))
    );
    return [...direct, ...inTemplates];
  }

  async function bootstrap() {
    // Keep resolving until no placeholder is left (supports nested partials).
    let rounds = 0;
    while (true) {
      const nodes = collectPlaceholderNodes();
      if (!nodes.length) break;
      rounds += 1;
      if (rounds > 25) {
        console.error('[layout-loader] Too many nested partial rounds, aborting.');
        break;
      }
      await Promise.all(nodes.map((node) => loadPartial(node)));
    }

    if (typeof startAlpine === 'function') startAlpine();
  }

  document.addEventListener('DOMContentLoaded', () => {
    void bootstrap();
  });
})(window);

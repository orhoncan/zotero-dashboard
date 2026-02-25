(function (root, factory) {
  const api = factory();
  root.ZoteroFormatting = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createZoteroFormatting() {
  function normalizeNewlines(text) {
    return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  function normalizeMarkdownForDisplay(text) {
    let normalized = normalizeNewlines(text);
    normalized = normalized.replace(/((?:https?:\/\/|www\.)\S+)\s+(\d{1,2}\.\s+)/g, '$1\n\n$2');
    normalized = normalized.replace(/([.:;!?])\s+(\d{1,2}\.\s+[A-ZÇĞİÖŞÜ])/g, '$1\n\n$2');
    normalized = normalized.replace(/\n{4,}/g, '\n\n\n');
    return normalized;
  }

  function postFormatAssistantOutput(text) {
    const base = normalizeMarkdownForDisplay(text);
    if (!base.trim()) return '';

    const lines = base.split('\n').map((line) => String(line || '').replace(/\s+$/g, ''));
    const out = [];

    const isListLine = (line) => /^(\d+\.\s+|[-*]\s+|•\s+)/.test(line);
    const isHeaderLine = (line) => /^#{1,6}\s+/.test(line);
    const isMetaLine = (line) => /^(doi|url|source|kaynak|authors?|yazarlar?)\s*:/i.test(line.trim());

    let blankRun = 0;
    for (let idx = 0; idx < lines.length; idx += 1) {
      let line = lines[idx];
      const trimmed = line.trim();

      if (!trimmed) {
        blankRun += 1;
        if (blankRun <= 2 && out.length > 0) out.push('');
        continue;
      }
      blankRun = 0;

      line = line.replace(/^(\d+)\)\s+/, '$1. ');
      line = line.replace(/^\s*•\s+/, '- ');

      const prev = out.length ? String(out[out.length - 1] || '') : '';
      const prevTrimmed = prev.trim();
      const shouldInsertBreak =
        prevTrimmed &&
        !isMetaLine(prev) &&
        !isListLine(prevTrimmed) &&
        !isHeaderLine(prevTrimmed) &&
        (isHeaderLine(line.trim()) || isListLine(line.trim()));

      if (shouldInsertBreak) {
        out.push('');
      }
      out.push(line);
    }

    return out.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
  }

  function cleanDoi(value) {
    let doi = String(value || '').trim();
    if (!doi) return '';
    doi = doi.replace(/^https?:\/\/doi\.org\//i, '');
    doi = doi.replace(/^doi:\s*/i, '');
    doi = doi.replace(/[),.;]+$/g, '');
    if (!/^10\.\d{4,9}\/\S+$/i.test(doi)) return '';
    return doi.toLowerCase();
  }

  function normalizeUrl(value) {
    let url = String(value || '').trim();
    if (!url) return '';
    url = url.replace(/[)>.,;]+$/g, '');
    if (/^doi:/i.test(url)) {
      const doi = cleanDoi(url);
      return doi ? `https://doi.org/${doi}` : '';
    }
    if (/^10\.\d{4,9}\//i.test(url)) {
      return `https://doi.org/${cleanDoi(url)}`;
    }
    if (/^www\./i.test(url)) {
      url = `https://${url}`;
    }
    if (!/^https?:\/\//i.test(url)) return '';
    return url;
  }

  function hostOf(url) {
    try {
      const parsed = new URL(url);
      const host = String(parsed.hostname || '').toLowerCase();
      return host.startsWith('www.') ? host.slice(4) : host;
    } catch (e) {
      return '';
    }
  }

  function displayHostLabel(host) {
    if (!host) return '';
    if (host === 'doi.org') return 'DOI';
    return host;
  }

  function normalizeTitle(raw) {
    return String(raw || '')
      .replace(/^[-*]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizedTitleKey(raw) {
    return normalizeTitle(raw).toLowerCase().replace(/[^a-z0-9ğüşöçıİĞÜŞÖÇ]+/gi, '');
  }

  function isSourceListEntryLine(line) {
    const value = String(line || '').trim();
    if (!value) return false;
    if (/^\s*(?:[-*]\s*)?\[[^\]]{2,180}\]\((?:https?:\/\/|doi:|10\.)[^\s)]+\)\s*$/i.test(value)) return true;
    if (/^\s*(?:[-*]\s*)?(?:https?:\/\/|www\.)\S+\s*$/i.test(value)) return true;
    if (/^\s*(?:[-*]\s*)?(?:doi\s*:?\s*)?10\.\d{4,9}\/\S+/i.test(value)) return true;
    if (/^\s*(?:[-*]\s*)?.+\s+[-—]\s+(?:https?:\/\/|doi:|10\.)\S+\s*$/i.test(value)) return true;
    return false;
  }

  function stripInlineSourceSection(text) {
    const lines = normalizeNewlines(text).split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = String(lines[i] || '');
      const trimmed = line.trim();
      const isSourcesHeader = /^(sources?|kaynaklar?)\s*:?\s*$/i.test(trimmed);

      if (!isSourcesHeader) {
        out.push(line);
        i += 1;
        continue;
      }

      let j = i + 1;
      while (j < lines.length) {
        const next = String(lines[j] || '').trim();
        if (!next) {
          j += 1;
          continue;
        }
        if (isSourceListEntryLine(next)) {
          j += 1;
          continue;
        }
        break;
      }

      // Remove only if we actually consumed at least one source-looking line.
      if (j > i + 1) {
        while (out.length > 0 && !String(out[out.length - 1] || '').trim()) {
          out.pop();
        }
        if (out.length > 0) out.push('');
        i = j;
        continue;
      }

      out.push(line);
      i += 1;
    }

    return out.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
  }

  function extractSourceCardsFromText(text) {
    const normalized = postFormatAssistantOutput(text);
    if (!normalized) return [];

    const cards = [];
    const seen = new Set();
    const lines = normalized.split('\n');
    let contextTitle = '';

    const addCard = (partial) => {
      let doi = cleanDoi(partial?.doi || '');
      const url = normalizeUrl(partial?.url || '');
      if (!doi && url && /^https?:\/\/doi\.org\//i.test(url)) {
        doi = cleanDoi(url);
      }
      if (!doi && !url) return;

      const dedupeKey = doi ? `doi:${doi}` : `url:${url.toLowerCase()}`;
      if (seen.has(dedupeKey)) return;

      const finalUrl = url || (doi ? `https://doi.org/${doi}` : '');
      const host = displayHostLabel(hostOf(finalUrl));
      const title = normalizeTitle(partial?.title || contextTitle || host || 'Kaynak');
      const titleKey = normalizedTitleKey(title);
      const yearMatch = String(title).match(/\((19|20)\d{2}\)/);
      const year = yearMatch ? yearMatch[0].replace(/[()]/g, '') : '';

      const existingIdx = cards.findIndex((card) => {
        if (doi && card.doi && card.doi === doi) return true;
        if (finalUrl && card.url && card.url.toLowerCase() === finalUrl.toLowerCase()) return true;
        const cardTitleKey = normalizedTitleKey(card.title || '');
        return !!titleKey && !!cardTitleKey && titleKey === cardTitleKey;
      });
      if (existingIdx >= 0) {
        const existing = cards[existingIdx];
        cards[existingIdx] = {
          ...existing,
          title: existing.title || title,
          url: existing.url || finalUrl,
          doi: existing.doi || doi,
          host: existing.host || host,
          year: existing.year || year,
        };
        seen.add(dedupeKey);
        if (doi) seen.add(`doi:${doi}`);
        if (finalUrl) seen.add(`url:${finalUrl.toLowerCase()}`);
        return;
      }

      cards.push({
        title,
        url: finalUrl,
        doi,
        host,
        year,
      });
      seen.add(dedupeKey);
      if (doi) seen.add(`doi:${doi}`);
      if (finalUrl) seen.add(`url:${finalUrl.toLowerCase()}`);
    };

    const metadataPrefix = /^(doi|url|source|kaynak|authors?|yazarlar?)\s*:/i;
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = String(lines[idx] || '').trim();
      if (!line) continue;

      const numberedTitle = line.match(/^\d+[.)]\s+(.+)/);
      if (numberedTitle) {
        contextTitle = normalizeTitle(numberedTitle[1]);
      } else if (!metadataPrefix.test(line) && line.length >= 12 && line.length <= 180) {
        contextTitle = normalizeTitle(line);
      }

      const mdLinkMatches = [...line.matchAll(/\[([^\]]{2,180})\]\((https?:\/\/[^\s)]+)\)/g)];
      if (mdLinkMatches.length) {
        const firstLabel = normalizeTitle(mdLinkMatches[0][1] || '');
        if (firstLabel) contextTitle = firstLabel;
        mdLinkMatches.forEach((match) => {
          const label = normalizeTitle(match[1]);
          const url = normalizeUrl(match[2]);
          const doi = cleanDoi(url);
          addCard({ title: label, url, doi });
        });
        // Already extracted structured links from this line; skip raw URL pass to avoid duplicates.
        continue;
      }

      const doiMatches = [...line.matchAll(/\b10\.\d{4,9}\/[^\s<>\])]+/gi)];
      doiMatches.forEach((match) => {
        addCard({ title: contextTitle, doi: cleanDoi(match[0]) });
      });

      const rawUrlMatches = [...line.matchAll(/\bhttps?:\/\/[^\s<>\])]+/gi)];
      rawUrlMatches.forEach((match) => {
        addCard({ title: contextTitle, url: normalizeUrl(match[0]) });
      });

      const wwwMatches = [...line.matchAll(/\bwww\.[^\s<>\])]+/gi)];
      wwwMatches.forEach((match) => {
        addCard({ title: contextTitle, url: normalizeUrl(match[0]) });
      });

      if (cards.length >= 12) break;
    }

    return cards.slice(0, 10);
  }

  return {
    normalizeMarkdownForDisplay,
    postFormatAssistantOutput,
    extractSourceCardsFromText,
    stripInlineSourceSection,
  };
});

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

  function cleanSectionHeadingText(value) {
    return String(value || '')
      .replace(/^[-*•\s]+/, '')
      .replace(/\s+/g, ' ')
      .replace(/[:：]\s*$/, '')
      .trim();
  }

  function normalizeSectionHeadingLine(line) {
    const raw = String(line || '');
    const trimmed = raw.trim();
    if (!trimmed) return raw;

    const numbered = trimmed.match(/^\(?([1-9]\d*)\)?[.)]\s+(.+?)[:：]?\s*$/);
    if (numbered) {
      const heading = cleanSectionHeadingText(numbered[2]);
      if (heading && heading.length <= 90) return `## ${heading}`;
    }

    const knownHeading = trimmed.match(/^(Benzerlikler|Ayrışmalar|Farklılıklar|Ortak temalar|Güçlü\/Zayıf yönler|Hangi çalışma hangi amaç için daha uygun|Önerilen okuma sırası|Shared themes|Differences|Strengths\/weaknesses|Which paper is better for which purpose|Recommended reading order)[:：]?\s*$/i);
    if (knownHeading) {
      return `## ${cleanSectionHeadingText(knownHeading[1])}`;
    }

    return raw;
  }

  function isGenericCaveatLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return false;
    const patterns = [
      /^Sağlanan tam metin kırpıntıları kısmi olduğundan/i,
      /^Daha kapsamlı karşılaştırma için tam metinlere erişim önerilir\.?$/i,
      /^Sınırlılık notu:\s*/i,
      /^Kısıt:\s*/i,
      /^Provided full[- ]text excerpts are partial/i,
      /^For a more comprehensive comparison, access to the full texts? is recommended\.?$/i,
      /^Limitation note:\s*/i,
      /^Constraint:\s*/i,
      /^General Note:?$/i,
      /^Genel Bilgi Notu:?$/i,
    ];
    return patterns.some((re) => re.test(trimmed));
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

      if (isGenericCaveatLine(trimmed)) {
        continue;
      }

      line = line.replace(/^(\d+)\)\s+/, '$1. ');
      line = line.replace(/^\s*•\s+/, '- ');
      line = normalizeSectionHeadingLine(line);

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

    return out
      .join('\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .replace(/^(?:Genel Bilgi Notu|General Note)\s*$/gim, '')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }

  function cleanDoi(value) {
    let doi = String(value || '').trim();
    if (!doi) return '';
    doi = doi.replace(/^https?:\/\/doi\.org\//i, '');
    doi = doi.replace(/^doi:\s*/i, '');
    doi = doi.replace(/[),.;:\]*_`]+$/g, '');
    doi = doi.replace(/[*_`]+/g, '');
    doi = doi.replace(/:+$/g, '');
    if (!/^10\.\d{4,9}\/\S+$/i.test(doi)) return '';
    return doi.toLowerCase();
  }

  function normalizeUrl(value) {
    let url = String(value || '').trim();
    if (!url) return '';
    url = url.replace(/[)>.,;:\]*_`]+$/g, '');
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

  function stripMarkdownArtifacts(value) {
    let text = String(value || '');
    if (!text) return '';
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/!\[[^\]]*]\((?:https?:\/\/|data:)[^)]+\)/gi, ' ');
    text = text.replace(/\[([^\]]{2,260})\]\((?:https?:\/\/|doi:|10\.)[^\s)]+\)/gi, '$1');
    text = text.replace(/\\([`*_~[\](){}#+\-.!])/g, '$1');
    text = text.replace(/[`*_~]+/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    return text;
  }

  function normalizedTitleKey(raw) {
    return normalizeTitle(raw).toLowerCase().replace(/[^a-z0-9ğüşöçıİĞÜŞÖÇ]+/gi, '');
  }

  function titleLooksLikeDoi(raw) {
    const value = normalizeTitle(raw);
    if (!value) return false;
    if (cleanDoi(value)) return true;
    if (/^https?:\/\/doi\.org\//i.test(value)) return true;
    return false;
  }

  function cleanSourceTitle(raw) {
    let value = normalizeTitle(raw);
    if (!value) return '';
    value = stripMarkdownArtifacts(value);
    value = value
      .replace(/^[-*•]\s+/, '')
      .replace(/^\(?\d+\)?[.)]\s+/, '')
      .replace(/^(sources?|kaynaklar?)\s*:?\s*/i, '')
      .replace(/^(doi|url|source|kaynak)\s*:\s*/i, '')
      .replace(/\s+(?:doi|url|source|kaynak)\s*:?\s*$/i, '')
      .replace(/[\s\-–—:;,]+$/g, '')
      .trim();
    return value;
  }

  function titleQuality(rawTitle, doi, host) {
    const title = cleanSourceTitle(rawTitle);
    if (!title) return 0;
    if (titleLooksLikeDoi(title)) return 1;
    if (/^(doi|source|kaynak|url)$/i.test(title)) return 1;
    if (host && title.toLowerCase() === String(host).toLowerCase()) return 1;
    let score = 3;
    if (title.length >= 24) score += 1;
    if (title.length >= 42) score += 1;
    if (/\b(19|20)\d{2}\b/.test(title)) score += 1;
    if (/["“”]/.test(title)) score += 1;
    return score;
  }

  function pickBetterTitle(existingTitle, candidateTitle, doi, host) {
    const current = cleanSourceTitle(existingTitle);
    const candidate = cleanSourceTitle(candidateTitle);
    if (!current) return candidate;
    if (!candidate) return current;
    const currentScore = titleQuality(current, doi, host);
    const candidateScore = titleQuality(candidate, doi, host);
    if (candidateScore > currentScore) return candidate;
    if (candidateScore === currentScore && candidate.length > current.length + 6 && candidate.length <= 220) {
      return candidate;
    }
    return current;
  }

  function sourceYearHint(value) {
    const match = String(value || '').match(/\b(19|20)\d{2}\b/);
    return match ? match[0] : '';
  }

  function isProbableAuthorSegment(value) {
    const text = String(value || '').trim();
    if (!text || text.length < 4 || text.length > 80) return false;
    if (/\b(doi|url|http|www|journal|review|press|springer|elsevier|taylor|wiley)\b/i.test(text)) return false;
    if (/\b(19|20)\d{2}\b/.test(text)) return false;
    if (/:/.test(text)) return false;
    if (/\bet al\.?\b/i.test(text)) return true;
    const normalized = text.replace(/&/g, ' ').replace(/\band\b/gi, ' ').replace(/\bve\b/gi, ' ');
    const parts = normalized.split(/\s+/).filter(Boolean);
    if (parts.length < 2 || parts.length > 8) return false;
    const capitalized = parts.filter((part) => /^([A-ZÇĞİÖŞÜ][a-zçğıöşü'`.-]+|[A-ZÇĞİÖŞÜ]\.)$/.test(part)).length;
    return capitalized >= Math.min(parts.length, 2);
  }

  function extractBibliographicTitle(raw) {
    const source = stripMarkdownArtifacts(String(raw || ''));
    if (!source) return '';
    const cutIndexCandidates = [
      source.search(/\bdoi\s*:/i),
      source.search(/\burl\s*:/i),
      source.search(/\bhttps?:\/\//i),
      source.search(/\b10\.\d{4,9}\//i),
    ].filter((idx) => idx >= 0);
    const cutIndex = cutIndexCandidates.length ? Math.min(...cutIndexCandidates) : -1;
    const base = cleanSourceTitle(cutIndex >= 0 ? source.slice(0, cutIndex).trim() : source);
    if (!base) return '';

    const segments = base.split(/\s*,\s*/).map((part) => cleanSourceTitle(part)).filter(Boolean);
    if (segments.length <= 1) return base;

    const titleParts = [];
    for (const segment of segments) {
      if (isProbableAuthorSegment(segment) && titleParts.length) break;
      titleParts.push(segment);
    }

    const joined = cleanSourceTitle(titleParts.join(', '));
    return joined || base;
  }

  function sourceHintFromLine(line) {
    const raw = String(line || '').trim();
    if (!raw) return { title: '', year: '' };

    const doiMatch = /\b10\.\d{4,9}\/[^\s<>\])]+/i.exec(raw);
    const urlMatch = /\bhttps?:\/\/[^\s<>\])]+/i.exec(raw);
    const markerIndex = Math.min(
      doiMatch?.index ?? Number.POSITIVE_INFINITY,
      urlMatch?.index ?? Number.POSITIVE_INFINITY
    );
    const base = stripMarkdownArtifacts(Number.isFinite(markerIndex) ? raw.slice(0, markerIndex).trim() : raw);

    const quoteMatches = [...base.matchAll(/["“”'‘’]([^"“”'‘’]{8,260})["“”'‘’]/g)];
    let title = '';
    if (quoteMatches.length) {
      quoteMatches.sort((a, b) => (b[1] || '').length - (a[1] || '').length);
      title = cleanSourceTitle(quoteMatches[0][1] || '');
    }

    if (!title) {
      title = extractBibliographicTitle(base) || cleanSourceTitle(base);
    }

    if (!title || titleLooksLikeDoi(title) || /^(sources?|kaynaklar?)$/i.test(title)) {
      return { title: '', year: sourceYearHint(raw) };
    }

    return {
      title,
      year: sourceYearHint(raw) || sourceYearHint(title),
    };
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

  function isLikelySourceTitleLine(line) {
    let value = String(line || '').trim();
    if (!value) return false;
    value = value.replace(/^[-*]\s+/, '').trim();
    if (!value) return false;
    if (/^(sources?|kaynaklar?)\s*:?\s*$/i.test(value)) return false;
    if (isSourceListEntryLine(value)) return true;
    if (value.length < 6 || value.length > 180) return false;
    const words = value.split(/\s+/).filter(Boolean);
    if (words.length > 14) return false;
    if (/^[\d()\[\]\-–—•]+$/.test(value)) return false;
    if (/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(value) === false) return false;
    if (/[.!?]$/.test(value) && words.length > 8) return false;
    return true;
  }

  function looksLikeBibliographicSourceLine(line) {
    const value = String(line || '').trim();
    if (!value) return false;
    const hasReferenceToken =
      /\bdoi\s*:/i.test(value) ||
      /\b10\.\d{4,9}\//i.test(value) ||
      /\bhttps?:\/\//i.test(value) ||
      /\bwww\./i.test(value);
    if (!hasReferenceToken) return false;
    const commaCount = (value.match(/,/g) || []).length;
    const year = sourceYearHint(value);
    return commaCount >= 2 || !!year;
  }

  function stripInlineSourceSection(text, options = {}) {
    const lines = normalizeNewlines(text).split('\n');
    const out = [];
    let i = 0;
    const aggressive = !!options?.aggressive;

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
      let consumed = 0;
      while (j < lines.length) {
        const next = String(lines[j] || '').trim();
        if (!next) {
          j += 1;
          continue;
        }
        if (isSourceListEntryLine(next)) {
          consumed += 1;
          j += 1;
          continue;
        }
        if (aggressive && looksLikeBibliographicSourceLine(next)) {
          consumed += 1;
          j += 1;
          continue;
        }
        if (aggressive && isLikelySourceTitleLine(next)) {
          consumed += 1;
          j += 1;
          continue;
        }
        break;
      }

      // Remove only if we actually consumed at least one source-looking line.
      if (consumed > 0) {
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
    let inSourceSection = false;

    const addCard = (partial) => {
      let doi = cleanDoi(partial?.doi || '');
      const url = normalizeUrl(partial?.url || '');
      if (!doi && url && /^https?:\/\/doi\.org\//i.test(url)) {
        doi = cleanDoi(url);
      }

      const finalUrl = url || (doi ? `https://doi.org/${doi}` : '');
      const host = displayHostLabel(hostOf(finalUrl));
      const preferredTitle = pickBetterTitle('', partial?.title || contextTitle || '', doi, host);
      const title = preferredTitle || host || (doi ? doi : 'Source');
      const titleKey = normalizedTitleKey(title);
      if (!doi && !finalUrl && !titleKey) return;

      const dedupeKey = doi
        ? `doi:${doi}`
        : (finalUrl ? `url:${finalUrl.toLowerCase()}` : `title:${titleKey}`);
      if (dedupeKey && seen.has(dedupeKey)) return;
      const year = sourceYearHint(partial?.year || title);

      const existingIdx = cards.findIndex((card) => {
        if (doi && card.doi && card.doi === doi) return true;
        if (finalUrl && card.url && card.url.toLowerCase() === finalUrl.toLowerCase()) return true;
        const cardTitleKey = normalizedTitleKey(card.title || '');
        return !!titleKey && !!cardTitleKey && titleKey === cardTitleKey;
      });
      if (existingIdx >= 0) {
        const existing = cards[existingIdx];
        const nextTitle = pickBetterTitle(existing.title || '', title, existing.doi || doi, existing.host || host);
        cards[existingIdx] = {
          ...existing,
          title: nextTitle || existing.title || title,
          url: existing.url || finalUrl,
          doi: existing.doi || doi,
          host: existing.host || host,
          year: existing.year || year,
        };
        if (dedupeKey) seen.add(dedupeKey);
        if (doi) seen.add(`doi:${doi}`);
        if (finalUrl) seen.add(`url:${finalUrl.toLowerCase()}`);
        if (titleKey) seen.add(`title:${titleKey}`);
        return;
      }

      cards.push({
        title,
        url: finalUrl,
        doi,
        host,
        year,
      });
      if (dedupeKey) seen.add(dedupeKey);
      if (doi) seen.add(`doi:${doi}`);
      if (finalUrl) seen.add(`url:${finalUrl.toLowerCase()}`);
      if (titleKey) seen.add(`title:${titleKey}`);
    };

    const metadataPrefix = /^(doi|url|source|kaynak|authors?|yazarlar?)\s*:/i;
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = String(lines[idx] || '').trim();
      if (!line) {
        if (inSourceSection && cards.length) inSourceSection = false;
        continue;
      }
      if (/^(sources?|kaynaklar?)\s*:?\s*$/i.test(line)) {
        inSourceSection = true;
        contextTitle = '';
        continue;
      }
      const lineHint = sourceHintFromLine(line);
      const isMetadataLine = metadataPrefix.test(line)
        || (/^\d{4}\s*[•\-]\s*(doi|url)\b/i.test(line));

      const numberedTitle = line.match(/^\d+[.)]\s+(.+)/);
      if (numberedTitle) {
        contextTitle = normalizeTitle(numberedTitle[1]);
      } else if (lineHint.title && !isMetadataLine) {
        contextTitle = lineHint.title;
      } else if (!isMetadataLine && line.length >= 12 && line.length <= 180) {
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
        addCard({
          title: isMetadataLine ? contextTitle : (lineHint.title || contextTitle),
          year: lineHint.year,
          doi: cleanDoi(match[0]),
        });
      });

      const rawUrlMatches = [...line.matchAll(/\bhttps?:\/\/[^\s<>\])]+/gi)];
      rawUrlMatches.forEach((match) => {
        addCard({
          title: isMetadataLine ? contextTitle : (lineHint.title || contextTitle),
          year: lineHint.year,
          url: normalizeUrl(match[0]),
        });
      });

      const wwwMatches = [...line.matchAll(/\bwww\.[^\s<>\])]+/gi)];
      wwwMatches.forEach((match) => {
        addCard({
          title: isMetadataLine ? contextTitle : (lineHint.title || contextTitle),
          year: lineHint.year,
          url: normalizeUrl(match[0]),
        });
      });

      const hasRefToken = mdLinkMatches.length || doiMatches.length || rawUrlMatches.length || wwwMatches.length;
      if (inSourceSection && !hasRefToken && lineHint.title) {
        addCard({
          title: lineHint.title,
          year: lineHint.year,
        });
      }

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

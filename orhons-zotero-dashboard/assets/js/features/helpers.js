(function (window) {
  const ns = window.ZoteroDashboard;

  ns.registerMixin(function registerHelpers() {
    return {
      normalizeText(v) {
        const locale = this.aiLanguage === 'en' ? 'en-US' : 'tr-TR';
        return (v || "").toString().toLocaleLowerCase(locale);
      },

      renderMd(text) {
        if (!text) return "";
        try {
          return marked.parse(text);
        } catch (e) {
          return text;
        }
      },

      getCollectionName(key) {
        return this.collections.find((c) => c.key === key)?.data.name || key;
      },

      formatAuthors(creators) {
        if (!creators?.length) return "";
        const names = creators.filter(
          (c) => c.creatorType === "author" || !c.creatorType || c.creatorType === "editor"
        );
        if (!names.length) return "";
        if (names.length <= 3) {
          return names.map((c) => c.lastName || c.name || "").join(", ");
        }
        return names[0].lastName + " et al.";
      },

      extractYear(dateValue) {
        if (!dateValue) return "";
        const match = dateValue.match(/(\d{4})/);
        return match ? match[1] : dateValue;
      },

      formatDate(dateValue) {
        if (!dateValue) return "";
        try {
          const locale = this.aiLanguage === 'en' ? 'en-US' : 'tr-TR';
          return new Date(dateValue).toLocaleDateString(locale, {
            day: "numeric",
            month: "short",
            year: "numeric",
          });
        } catch (e) {
          return dateValue;
        }
      },

      formatItemType(itemType) {
        const labels = this.aiLanguage === 'en'
          ? {
              journalArticle: "Article",
              book: "Book",
              bookSection: "Book Chapter",
              conferencePaper: "Conference",
              thesis: "Thesis",
              report: "Report",
              webpage: "Web",
              document: "Document",
              preprint: "Preprint",
              presentation: "Presentation",
              patent: "Patent",
              film: "Film",
            }
          : {
              journalArticle: "Makale",
              book: "Kitap",
              bookSection: "Kitap Bölümü",
              conferencePaper: "Konferans",
              thesis: "Tez",
              report: "Rapor",
              webpage: "Web",
              document: "Doküman",
              preprint: "Preprint",
              presentation: "Sunum",
              patent: "Patent",
              film: "Film",
            };

        return (
          labels[itemType] || itemType
        );
      },

      isPrimaryLibraryItem(item) {
        const itemType = item?.data?.itemType || '';
        return itemType !== 'attachment' && itemType !== 'note' && itemType !== 'annotation';
      },

      getTypeIcon(itemType) {
        const icons = {
          journalArticle: [
            'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z',
            'M14 3v5h5',
            'M9 12h6',
            'M9 15h6',
            'M9 18h4',
          ],
          book: [
            'M6.5 4.5h8.5a3 3 0 0 1 3 3v11.5H9A2.5 2.5 0 0 0 6.5 21z',
            'M6.5 4.5V21',
            'M9 8h6',
          ],
          bookSection: [
            'M4 5.5A2.5 2.5 0 0 1 6.5 3H18v15H6.5A2.5 2.5 0 0 0 4 20.5z',
            'M12 3v15',
            'M7.5 8H10',
            'M14 8h2.5',
          ],
          conferencePaper: [
            'M12 6v9',
            'M8 9.5a4 4 0 0 1 8 0',
            'M6 21h12',
            'M10 15h4',
          ],
          thesis: [
            'm4 9 8-4 8 4-8 4-8-4z',
            'M7 11v4.5c0 .6 2.2 2.5 5 2.5s5-1.9 5-2.5V11',
          ],
          report: [
            'M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
            'M8.5 8.5h7',
            'M8.5 12h7',
            'M8.5 15.5H13',
          ],
          webpage: [
            'M3 12h18',
            'M12 3a9 9 0 0 1 0 18',
            'M12 3a9 9 0 0 0 0 18',
            'M3.6 8h16.8',
            'M3.6 16h16.8',
          ],
          document: [
            'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z',
            'M14 3v5h5',
            'M9 12h6',
            'M9 15h6',
          ],
          preprint: [
            'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z',
            'M14 3v5h5',
            'M9 16l2 2 4-4',
          ],
          presentation: [
            'M4 5h16',
            'M5 5v10h14V5',
            'M12 15v4',
            'M9 19h6',
          ],
          patent: [
            'M12 3a6 6 0 0 0-6 6c0 2.2 1.2 4 3 5v2h6v-2c1.8-1 3-2.8 3-5a6 6 0 0 0-6-6z',
            'M10 19h4',
            'M10.5 21h3',
          ],
          film: [
            'M4 7h16v10H4z',
            'M8 7V5',
            'M12 7V5',
            'M16 7V5',
            'M8 17v2',
            'M12 17v2',
            'M16 17v2',
          ],
        };
        const paths = icons[itemType] || icons.journalArticle;
        const pathHtml = paths.map((d) => `<path d="${d}"></path>`).join('');
        return `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true">${pathHtml}</svg>`;
      },

      getTypeColor(itemType) {
        return (
          {
            journalArticle: "bg-blue-500/20 text-blue-300",
            book: "bg-amber-500/20 text-amber-300",
            conferencePaper: "bg-purple-500/20 text-purple-300",
            thesis: "bg-emerald-500/20 text-emerald-300",
            webpage: "bg-cyan-500/20 text-cyan-300",
            preprint: "bg-orange-500/20 text-orange-300",
          }[itemType] || "bg-slate-500/20 text-slate-300"
        );
      },

      normalizeTagValue(tagLike) {
        if (typeof tagLike === 'string') return tagLike.trim();
        if (tagLike && typeof tagLike === 'object') return String(tagLike.tag || '').trim();
        return '';
      },

      isSystemTag(tagLike) {
        const tagValue = this.normalizeTagValue(tagLike);
        if (!tagValue) return false;
        const normalized = tagValue.toLocaleLowerCase(this.aiLanguage === 'en' ? 'en-US' : 'tr-TR');
        if (normalized.startsWith('_') || normalized.startsWith('@')) return true;
        if (/^(status|stage|priority|meta|system|workflow|read|todo|flag|zotero|source|collection)\s*:/.test(normalized)) {
          return true;
        }
        return false;
      },

      topicTags(tags) {
        return (tags || []).filter((tag) => !this.isSystemTag(tag));
      },

      systemTags(tags) {
        return (tags || []).filter((tag) => this.isSystemTag(tag));
      },

      copyCitation() {
        if (!this.selectedItem) return;
        const data = this.selectedItem.data;
        const authors = (data.creators || []).filter(
          (c) => c.creatorType === "author" || !c.creatorType
        );
        const authorText =
          authors.length === 1
            ? authors[0].lastName || authors[0].name
            : authors.length === 2
              ? `${authors[0].lastName} & ${authors[1].lastName}`
              : authors.length > 2
                ? `${authors[0].lastName} et al.`
                : "";
        const year = this.extractYear(data.date) || "n.d.";
        const journal = data.publicationTitle
          ? ` *${data.publicationTitle}*${data.volume ? ", " + data.volume : ""}${data.issue ? "(" + data.issue + ")" : ""}${data.pages ? ", " + data.pages : ""}.`
          : "";
        const doi = data.DOI ? ` https://doi.org/${data.DOI}` : "";
        navigator.clipboard
          .writeText(`${authorText} (${year}). ${data.title || ""}.${journal}${doi}`)
          .then(() => this.showToast(this.aiLanguage === 'en' ? 'APA citation copied' : 'APA atıf kopyalandı'));
      },

      showToast(message) {
        this.toast = message;
        setTimeout(() => {
          this.toast = "";
        }, 3000);
      },
    };
  });
})(window);

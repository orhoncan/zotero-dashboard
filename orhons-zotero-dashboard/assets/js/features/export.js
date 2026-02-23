(function (window) {
  const ns = window.ZoteroDashboard;

  ns.registerMixin(function registerExport() {
    return {
      escapeCsv(value) {
        const str = (value ?? '').toString().replace(/"/g, '""');
        return `"${str}"`;
      },

      exportCsv() {
        if (!this.displayItems.length) return;

        const header = ['key', 'type', 'title', 'authors', 'year', 'publication', 'doi', 'url', 'tags'];
        const rows = this.displayItems.map((item) => {
          const data = item.data;
          return [
            item.key,
            this.formatItemType(data.itemType),
            data.title || '',
            this.formatAuthors(data.creators),
            this.extractYear(data.date) || '',
            data.publicationTitle || '',
            data.DOI || '',
            data.url || '',
            (data.tags || []).map((t) => t.tag).join('; '),
          ]
            .map((v) => this.escapeCsv(v))
            .join(',');
        });

        const csv = [header.map((v) => this.escapeCsv(v)).join(','), ...rows].join('\n');
        this.downloadTextFile(csv, 'zotero-export.csv', 'text/csv;charset=utf-8');
        this.showToast(
          this.aiLanguage === 'en'
            ? `${this.displayItems.length} items downloaded as CSV`
            : `${this.displayItems.length} öğe CSV olarak indirildi`
        );
      },

      escapeBib(value) {
        return (value || '').toString().replace(/[{}]/g, '');
      },

      bibType(itemType) {
        return (
          {
            journalArticle: 'article',
            conferencePaper: 'inproceedings',
            book: 'book',
            bookSection: 'incollection',
            thesis: 'phdthesis',
            report: 'techreport',
            webpage: 'misc',
            preprint: 'unpublished',
          }[itemType] || 'misc'
        );
      },

      bibKey(item, idx) {
        const data = item.data;
        const first = (data.creators || []).find(
          (c) => c.creatorType === 'author' || !c.creatorType || c.creatorType === 'editor'
        );
        const author =
          this.normalizeText(first?.lastName || first?.name || 'item').replace(/[^a-z0-9]/g, '') ||
          'item';
        const year = this.extractYear(data.date) || 'nodate';
        return `${author}${year}${idx + 1}`;
      },

      exportBibTeX() {
        if (!this.displayItems.length) return;

        const entries = this.displayItems.map((item, idx) => {
          const data = item.data;
          const authors = (data.creators || [])
            .filter((c) => c.creatorType === 'author' || !c.creatorType || c.creatorType === 'editor')
            .map((c) => [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.name)
            .filter(Boolean)
            .join(' and ');

          const fields = [
            ['title', data.title],
            ['author', authors],
            ['year', this.extractYear(data.date)],
            ['journal', data.publicationTitle],
            ['booktitle', data.proceedingsTitle],
            ['publisher', data.publisher],
            ['volume', data.volume],
            ['number', data.issue],
            ['pages', data.pages],
            ['doi', data.DOI],
            ['url', data.url],
          ].filter(([, value]) => value);

          const body = fields.map(([k, v]) => `  ${k} = {${this.escapeBib(v)}}`).join(',\n');
          return `@${this.bibType(data.itemType)}{${this.bibKey(item, idx)},\n${body}\n}`;
        });

        this.downloadTextFile(entries.join('\n\n'), 'zotero-export.bib', 'text/plain;charset=utf-8');
        this.showToast(
          this.aiLanguage === 'en'
            ? `${this.displayItems.length} items downloaded as BibTeX`
            : `${this.displayItems.length} öğe BibTeX olarak indirildi`
        );
      },

      downloadTextFile(content, filename, mime) {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      },
    };
  });
})(window);

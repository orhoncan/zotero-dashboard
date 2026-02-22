(function (window) {
  const ns = window.ZoteroDashboard;

  ns.registerMixin(function registerPdf() {
    return {
      zoteroPdfUrlForAttachment(attachment) {
        const key = attachment?.key || attachment?.data?.key;
        if (!key) return '';
        const libraryType = attachment?.library?.type || 'user';
        const libraryId = attachment?.library?.id;
        if (libraryType === 'group' && libraryId) {
          return `zotero://open-pdf/groups/${libraryId}/items/${key}`;
        }
        return `zotero://open-pdf/library/items/${key}`;
      },

      setActivePdfAttachmentMeta(attachment) {
        this.activePdfAttachmentKey = attachment?.key || attachment?.data?.key || null;
        this.activePdfZoteroUrl = this.zoteroPdfUrlForAttachment(attachment);
      },

      stripHtmlPlain(value) {
        return (value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      },

      relativeStoragePathFromEnclosure(enclosureUrl) {
        const value = String(enclosureUrl || '').trim();
        if (!value || !value.startsWith('file:///')) return '';
        try {
          const decoded = decodeURIComponent(value.replace(/^file:\/\//i, ''));
          const normalized = decoded.replace(/\\/g, '/');
          const lower = normalized.toLowerCase();
          const marker = '/storage/';
          const markerIdx = lower.lastIndexOf(marker);
          if (markerIdx >= 0) {
            return normalized.slice(markerIdx + marker.length).replace(/^\/+/, '');
          }
          const parts = normalized.split('/');
          const storageIdx = parts.findIndex((part) => part.toLowerCase() === 'storage');
          if (storageIdx >= 0 && storageIdx + 1 < parts.length) {
            return parts.slice(storageIdx + 1).join('/').replace(/^\/+/, '');
          }
        } catch (e) {
          return '';
        }
        return '';
      },

      normalizeAnnotationRows(rows = []) {
        return rows
          .filter((c) => c?.data?.itemType === 'annotation')
          .map((c) => ({
            key: c.key,
            text: this.stripHtmlPlain(c.data.annotationText),
            comment: this.stripHtmlPlain(c.data.annotationComment),
            pageLabel: c.data.annotationPageLabel || '?',
            color: c.data.annotationColor || '#CC2936',
          }))
          .filter((a) => a.text || a.comment);
      },

      setPdfAnnotationsState(itemKey, annotations) {
        const rows = Array.isArray(annotations) ? annotations : [];
        const ts = Date.now();
        this.annotationCache[itemKey] = rows;
        this.annotationUpdatedAtCache[itemKey] = ts;
        this.pdfAnnotations = rows;
        this.pdfAnnotationsUpdatedAt = ts;
        this.showPdfAnnotations = rows.length > 0;
      },

      getPdfAnnotationsTimestamp(itemKey) {
        return Number(this.annotationUpdatedAtCache?.[itemKey] || 0);
      },

      formatPdfAnnotationUpdatedAt(ts = this.pdfAnnotationsUpdatedAt) {
        const value = Number(ts || 0);
        if (!value) return this.aiLanguage === 'en' ? 'Not loaded yet' : 'Henüz yüklenmedi';
        try {
          const locale = this.aiLanguage === 'en' ? 'en-US' : 'tr-TR';
          return new Date(value).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        } catch (e) {
          return '';
        }
      },

      async launchZoteroUrl(zoteroUrl, options = {}) {
        const shouldScheduleRefresh = !!options.scheduleRefresh;
        const copyFallback = async () => {
          try {
            await navigator.clipboard.writeText(zoteroUrl);
            return true;
          } catch (e) {
            return false;
          }
        };

        try {
          let hidden = false;
          const onVisibility = () => {
            if (document.visibilityState === 'hidden') {
              hidden = true;
            }
          };
          document.addEventListener('visibilitychange', onVisibility, { once: true });

          const anchor = document.createElement('a');
          anchor.href = zoteroUrl;
          anchor.style.display = 'none';
          document.body.appendChild(anchor);
          anchor.click();
          document.body.removeChild(anchor);

          this.showToast(this.aiLanguage === 'en' ? 'Opened in Zotero Reader' : 'Zotero Reader’da açıldı');

          window.setTimeout(async () => {
            if (!hidden) {
              const copied = await copyFallback();
              if (copied) {
                this.showToast(
                  this.aiLanguage === 'en'
                    ? 'If Zotero did not open, deep link copied'
                    : 'Zotero açılmadıysa derin bağlantı kopyalandı'
                );
              }
            }
          }, 1400);

          if (shouldScheduleRefresh) {
            this.schedulePdfAnnotationRefresh();
          }
          return true;
        } catch (e) {
          const copied = await copyFallback();
          if (copied) {
            this.showToast(
              this.aiLanguage === 'en'
                ? 'Could not open automatically, link copied'
                : 'Otomatik açılamadı, bağlantı kopyalandı'
            );
          } else {
            this.showToast(this.aiLanguage === 'en' ? 'Could not open Zotero Reader' : 'Zotero Reader açılamadı');
          }
          return false;
        }
      },

      clearPdfAnnotationRefreshTimer() {
        if (this._pdfAnnotationRefreshTimer) {
          clearTimeout(this._pdfAnnotationRefreshTimer);
          this._pdfAnnotationRefreshTimer = null;
        }
      },

      closePdfPanel() {
        this.clearPdfAnnotationRefreshTimer();
        this.pdfUrl = null;
        this.pdfTitle = '';
        this.pdfAnnotations = [];
        this.pdfAnnotationsUpdatedAt = 0;
        this.activePdfItemKey = null;
        this.activePdfAttachmentKey = null;
        this.activePdfZoteroUrl = '';
      },

      schedulePdfAnnotationRefresh() {
        const itemKey = this.activePdfItemKey;
        if (!itemKey) return;

        this.clearPdfAnnotationRefreshTimer();
        let tries = 0;
        const maxTries = 8;
        const tick = async () => {
          if (!this.pdfUrl || this.activePdfItemKey !== itemKey) {
            this.clearPdfAnnotationRefreshTimer();
            return;
          }
          tries += 1;
          await this.loadPdfAnnotations(itemKey, { force: true });
          if (tries >= maxTries) {
            this.clearPdfAnnotationRefreshTimer();
            return;
          }
          this._pdfAnnotationRefreshTimer = setTimeout(tick, 3000);
        };

        this._pdfAnnotationRefreshTimer = setTimeout(tick, 2500);

        window.addEventListener(
          'focus',
          async () => {
            if (this.pdfUrl && this.activePdfItemKey === itemKey) {
              await this.loadPdfAnnotations(itemKey, { force: true });
            }
          },
          { once: true }
        );
      },

      async openPdfInZoteroReader() {
        if (!this.activePdfAttachmentKey) {
          this.showToast(this.aiLanguage === 'en' ? 'No active PDF attachment' : 'Etkin PDF eki bulunamadı');
          return;
        }
        const zoteroUrl = this.activePdfZoteroUrl || `zotero://open-pdf/library/items/${this.activePdfAttachmentKey}`;
        await this.launchZoteroUrl(zoteroUrl, { scheduleRefresh: true });
      },

      async resolvePdfAttachmentForItem(item) {
        if (!item?.key) return null;

        let attachment = this.items.find(
          (i) =>
            i.data.itemType === 'attachment' &&
            i.data.contentType === 'application/pdf' &&
            i.data.parentItem === item.key
        );
        if (attachment) return attachment;

        try {
          const children = await fetch(`${ns.API}/items/${item.key}/children?format=json`).then((r) => r.json());
          attachment = children.find((c) => c.data?.contentType === 'application/pdf') || null;
          return attachment;
        } catch (e) {
          return null;
        }
      },

      async openItemPdfInZoteroReader(item) {
        const attachment = await this.resolvePdfAttachmentForItem(item);
        if (!attachment) {
          this.showToast(this.aiLanguage === 'en' ? 'PDF not found' : 'PDF bulunamadı');
          return;
        }

        this.setActivePdfAttachmentMeta(attachment);
        const zoteroUrl = this.zoteroPdfUrlForAttachment(attachment);
        if (!zoteroUrl) {
          this.showToast(this.aiLanguage === 'en' ? 'Could not open Zotero Reader' : 'Zotero Reader açılamadı');
          return;
        }
        await this.launchZoteroUrl(zoteroUrl, {
          scheduleRefresh: !!(this.activePdfItemKey && this.activePdfItemKey === item.key && this.pdfUrl),
        });
      },

      markPdfItems() {
        const pdfKeys = new Set();
        this.items.forEach((item) => {
          if (
            item.data.itemType === 'attachment' &&
            item.data.contentType === 'application/pdf' &&
            item.data.parentItem
          ) {
            pdfKeys.add(item.data.parentItem);
          }
        });
        this.items.forEach((item) => {
          item._hasPdf = pdfKeys.has(item.key);
        });
      },

      async openPdf(item) {
        let attachment = this.items.find(
          (i) =>
            i.data.itemType === 'attachment' &&
            i.data.contentType === 'application/pdf' &&
            i.data.parentItem === item.key
        );

        this.activePdfItemKey = item.key;
        if (attachment) {
          this.setActivePdfAttachmentMeta(attachment);
        } else {
          this.activePdfAttachmentKey = null;
          this.activePdfZoteroUrl = '';
        }
        const enclosure = attachment?.links?.enclosure?.href;
        const storagePath = this.relativeStoragePathFromEnclosure(enclosure);

        if (storagePath) {
          this.pdfUrl = '/pdf/' + encodeURI(storagePath);
          this.pdfTitle = item.data.title || 'PDF';
        } else {
          try {
            const children = await fetch(
              `${ns.API}/items/${item.key}/children?format=json`
            ).then((r) => r.json());
            const pdf = children.find((c) => c.data.contentType === 'application/pdf');
            if (pdf) {
              attachment = attachment || pdf;
              this.pdfUrl = `/pdf/${pdf.key}/${encodeURIComponent(
                pdf.data.filename || pdf.data.title + '.pdf'
              )}`;
              this.pdfTitle = item.data.title || 'PDF';
              this.setActivePdfAttachmentMeta(pdf);
            } else {
              this.showToast(this.aiLanguage === 'en' ? 'PDF not found' : 'PDF bulunamadı');
              return;
            }
          } catch (e) {
            this.showToast(this.aiLanguage === 'en' ? 'PDF could not be opened' : 'PDF açılamadı');
            return;
          }
        }

        await this.loadPdfAnnotations(item.key);
      },

      async loadPdfAnnotations(itemKey, options = {}) {
        const force = !!options.force;
        if (!force && this.annotationCache[itemKey]) {
          const cached = this.annotationCache[itemKey];
          const rows = Array.isArray(cached) ? cached : (Array.isArray(cached?.items) ? cached.items : []);
          this.pdfAnnotations = [...rows];
          this.pdfAnnotationsUpdatedAt = this.getPdfAnnotationsTimestamp(itemKey) || Date.now();
          this.showPdfAnnotations = this.pdfAnnotations.length > 0;
          return;
        }

        try {
          const children = await fetch(`${ns.API}/items/${itemKey}/children?format=json`).then((r) =>
            r.json()
          );
          const annotations = this.normalizeAnnotationRows(children);
          this.setPdfAnnotationsState(itemKey, annotations);
        } catch (e) {
          this.pdfAnnotations = [];
          this.pdfAnnotationsUpdatedAt = 0;
        }
      },

      async refreshPdfAnnotationsNow() {
        if (!this.activePdfItemKey) return;
        await this.loadPdfAnnotations(this.activePdfItemKey, { force: true });
        this.showToast(
          this.aiLanguage === 'en'
            ? `Annotations refreshed (${this.pdfAnnotations.length})`
            : `Notlar yenilendi (${this.pdfAnnotations.length})`
        );
      },

      async loadItemAnnotationsForDetail(itemKey, options = {}) {
        if (!itemKey) return;
        const force = !!options.force;
        if (!force && this.detailAnnotationCache[itemKey]) {
          this.itemAnnotations = [...this.detailAnnotationCache[itemKey]];
          return;
        }

        try {
          const parentChildren = await fetch(`${ns.API}/items/${itemKey}/children?format=json`).then((r) => r.json());
          const directAnnotations = this.normalizeAnnotationRows(parentChildren);
          const attachments = parentChildren.filter(
            (c) => c?.data?.itemType === 'attachment' && c?.data?.contentType === 'application/pdf'
          );

          const nestedLists = await Promise.all(
            attachments.map(async (attachment) => {
              try {
                const rows = await fetch(`${ns.API}/items/${attachment.key}/children?format=json`).then((r) => r.json());
                return this.normalizeAnnotationRows(rows);
              } catch (e) {
                return [];
              }
            })
          );

          const merged = [...directAnnotations, ...nestedLists.flat()];
          const seen = new Set();
          const deduped = merged.filter((ann) => {
            if (!ann?.key || seen.has(ann.key)) return false;
            seen.add(ann.key);
            return true;
          });

          this.detailAnnotationCache[itemKey] = deduped;
          this.itemAnnotations = [...deduped];
        } catch (e) {
          this.itemAnnotations = [];
        }
      },

      startPdfResize(e) {
        if ((e?.button ?? 0) !== 0) return;
        if (e?.preventDefault) e.preventDefault();
        const startY = e.clientY;
        const startHeight = this.pdfPanelHeight;
        document.body.classList.add('pdf-resizing');

        const onWindowBlur = () => {
          onUp();
        };
        const onVisibilityChange = () => {
          if (document.visibilityState === 'hidden') {
            onUp();
          }
        };

        const onMove = (ev) => {
          if ((ev.buttons & 1) === 0) {
            onUp();
            return;
          }
          const delta = startY - ev.clientY;
          this.pdfPanelHeight = Math.min(
            80,
            Math.max(20, startHeight + (delta / window.innerHeight) * 100)
          );
        };

        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          window.removeEventListener('blur', onWindowBlur);
          document.removeEventListener('visibilitychange', onVisibilityChange);
          document.body.classList.remove('pdf-resizing');
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        window.addEventListener('blur', onWindowBlur);
        document.addEventListener('visibilitychange', onVisibilityChange);
      },
    };
  });
})(window);

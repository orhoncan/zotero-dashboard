(function (window) {
  const ns = window.ZoteroDashboard;
  const PDF_WORKER_SRC = '/assets/vendor/pdfjs/2.10.377/pdf.worker.min.js?v=20260223f';

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

      zoteroWebScopeForAttachment(attachment) {
        const libraryType = attachment?.library?.type || 'user';
        const libraryId = attachment?.library?.id;
        if (libraryType === 'group' && libraryId) {
          return `groups/${libraryId}`;
        }
        const userId = Number(libraryId || this.userId || 0);
        if (!Number.isFinite(userId) || userId <= 0) return '';
        return `users/${userId}`;
      },

      zoteroWebUrlsForAttachment(attachment) {
        const key = attachment?.key || attachment?.data?.key;
        if (!key) return [];
        const scope = this.zoteroWebScopeForAttachment(attachment);
        if (!scope) return [];
        const parentKey = attachment?.data?.parentItem || '';
        const urls = [
          `https://www.zotero.org/${scope}/items/${key}/reader`,
          `https://www.zotero.org/${scope}/items/${key}/library`,
        ];
        if (parentKey) {
          urls.push(`https://www.zotero.org/${scope}/items/${parentKey}/library`);
        }
        const deduped = [];
        urls.forEach((url) => {
          if (url && !deduped.includes(url)) deduped.push(url);
        });
        return deduped;
      },

      pdfSyncStatusText() {
        if (!this.pdfSyncInProgress) {
          return this.aiLanguage === 'en' ? 'Idle' : 'Hazır';
        }
        if (this.pdfSyncSource === 'web') {
          return this.aiLanguage === 'en' ? 'Auto sync: Zotero Web' : 'Oto senkron: Zotero Web';
        }
        return this.aiLanguage === 'en' ? 'Auto sync: Zotero Reader' : 'Oto senkron: Zotero Reader';
      },

      pdfSyncHistoryLimit() {
        return 18;
      },

      formatPdfSyncTime(ts) {
        const value = Number(ts || 0);
        if (!value) return '';
        try {
          const locale = this.aiLanguage === 'en' ? 'en-US' : 'tr-TR';
          return new Date(value).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        } catch (e) {
          return '';
        }
      },

      appendPdfSyncHistory(entry = {}) {
        const at = Number(entry.at || Date.now());
        const source = String(entry.source || this.pdfSyncSource || 'manual').trim().toLowerCase();
        const annotations = Math.max(0, Number(entry.annotations || 0));
        const notes = Math.max(0, Number(entry.notes || 0));
        const delta = Number(entry.delta || 0);
        const row = {
          at,
          source,
          itemKey: String(entry.itemKey || this.activePdfItemKey || '').trim(),
          annotations,
          notes,
          delta,
        };
        const current = Array.isArray(this.pdfSyncHistory) ? this.pdfSyncHistory : [];
        this.pdfSyncHistory = [row, ...current].slice(0, this.pdfSyncHistoryLimit());
      },

      pdfSyncLastSummary() {
        const history = Array.isArray(this.pdfSyncHistory) ? this.pdfSyncHistory : [];
        const activeKey = String(this.activePdfItemKey || '').trim();
        const last = activeKey
          ? (history.find((row) => String(row?.itemKey || '') === activeKey) || history[0] || null)
          : (history[0] || null);
        if (!last) {
          return this.aiLanguage === 'en' ? 'Last sync: -' : 'Son senkron: -';
        }
        const timeLabel = this.formatPdfSyncTime(last.at);
        if (this.aiLanguage === 'en') {
          return `Last sync: ${timeLabel || '-'}`;
        }
        return `Son senkron: ${timeLabel || '-'}`;
      },

      currentPdfNoteCount(itemKey = this.activePdfItemKey) {
        const key = String(itemKey || '').trim();
        if (!key) return 0;
        if (key === String(this.selectedItem?.key || '')) {
          return Math.max(0, Number((this.itemNotes || []).length || 0));
        }
        return 0;
      },

      pdfSyncHistoryRows(limit = 4) {
        const maxRows = Math.max(1, Number(limit || 4));
        const rows = Array.isArray(this.pdfSyncHistory) ? this.pdfSyncHistory : [];
        const activeKey = String(this.activePdfItemKey || '').trim();
        const scoped = activeKey
          ? rows.filter((row) => String(row?.itemKey || '') === activeKey)
          : rows;
        return scoped.slice(0, maxRows);
      },

      setActivePdfAttachmentMeta(attachment) {
        this.activePdfAttachmentKey = attachment?.key || attachment?.data?.key || null;
        this.activePdfZoteroUrl = this.zoteroPdfUrlForAttachment(attachment);
        const webUrls = this.zoteroWebUrlsForAttachment(attachment);
        this.activePdfZoteroWebUrl = webUrls[0] || '';
      },

      stripHtmlPlain(value) {
        return (value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      },

      async fetchPdfApiRows(url, options = {}) {
        if (typeof this.fetchJsonAbsolute === 'function') {
          const res = await this.fetchJsonAbsolute(url, options);
          return Array.isArray(res.data) ? res.data : [];
        }
        const fallbackRes = await fetch(url, { signal: options?.signal });
        if (!fallbackRes.ok) {
          throw new Error(`API ${fallbackRes.status}`);
        }
        const payload = await fallbackRes.json();
        return Array.isArray(payload) ? payload : [];
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
        this.showPdfAnnotations = rows.length > 0 || this.pdfSearchResults.length > 0;
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
        const syncSource = String(options.source || '').trim().toLowerCase();
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
            this.schedulePdfAnnotationRefresh(syncSource);
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
        this.pdfSyncInProgress = false;
        this.pdfSyncSource = '';
      },

      teardownPdfIntersectionObserver() {
        if (this._pdfIntersectionObserver) {
          this._pdfIntersectionObserver.disconnect();
          this._pdfIntersectionObserver = null;
        }
      },

      cancelPdfRenderTasks() {
        const tasks = this._pdfRenderTasks && typeof this._pdfRenderTasks === 'object' ? this._pdfRenderTasks : {};
        Object.values(tasks).forEach((task) => {
          try {
            task?.cancel?.();
          } catch (e) {
            // no-op
          }
        });
        this._pdfRenderTasks = {};
        this._pdfRenderJobs = {};
        this._pdfRenderEpoch = Number(this._pdfRenderEpoch || 0) + 1;
      },

      destroyPdfViewer() {
        this._pdfLoadToken = Number(this._pdfLoadToken || 0) + 1;
        this.teardownPdfIntersectionObserver();
        if (this._pdfScrollRaf) {
          cancelAnimationFrame(this._pdfScrollRaf);
          this._pdfScrollRaf = 0;
        }
        this.cancelPdfRenderTasks();

        const loadingTask = this._pdfLoadingTask;
        this._pdfLoadingTask = null;
        if (loadingTask?.destroy) {
          Promise.resolve(loadingTask.destroy()).catch(() => {});
        }

        const doc = this._pdfDocument;
        this._pdfDocument = null;
        if (doc?.destroy) {
          Promise.resolve(doc.destroy()).catch(() => {});
        }

        this._pdfPageTextCache = {};
        this.pdfViewerReady = false;
        this.pdfViewerError = '';
        this.pdfPageCount = 0;
        this.pdfCurrentPage = 1;
        this.pdfPageNumbers = [];
        this.pdfRenderedPages = {};
        this.pdfSearchQuery = '';
        this.pdfSearchResults = [];
        this.pdfSearchActiveIndex = -1;
        this.pdfSearchBusy = false;
        this.pdfUseIframeFallback = false;
      },

      closePdfPanel() {
        this.clearPdfAnnotationRefreshTimer();
        this.destroyPdfViewer();
        this.pdfUrl = null;
        this.pdfTitle = '';
        this.pdfAnnotations = [];
        this.pdfAnnotationsUpdatedAt = 0;
        this.activePdfItemKey = null;
        this.activePdfAttachmentKey = null;
        this.activePdfZoteroUrl = '';
        this.activePdfZoteroWebUrl = '';
      },

      schedulePdfAnnotationRefresh(source = '') {
        const itemKey = this.activePdfItemKey;
        if (!itemKey) return;

        this.clearPdfAnnotationRefreshTimer();
        this.pdfSyncInProgress = true;
        this.pdfSyncSource = String(source || '').trim().toLowerCase();
        let tries = 0;
        const maxTries = 8;
        const tick = async () => {
          if (!this.pdfUrl || this.activePdfItemKey !== itemKey) {
            this.clearPdfAnnotationRefreshTimer();
            return;
          }
          tries += 1;
          const update = await this.loadPdfAnnotations(itemKey, { force: true });
          if (update?.changed || tries === 1) {
            this.appendPdfSyncHistory({
              itemKey,
              source: this.pdfSyncSource || source || 'reader',
              annotations: update?.annotations ?? this.pdfAnnotations.length,
              notes: this.currentPdfNoteCount(itemKey),
              delta: (update?.annotations ?? this.pdfAnnotations.length) - (update?.previous ?? this.pdfAnnotations.length),
            });
          }
          if (tries >= maxTries) {
            this.clearPdfAnnotationRefreshTimer();
            this.showToast(
              this.aiLanguage === 'en'
                ? `Auto sync completed (${this.pdfAnnotations.length})`
                : `Oto senkron tamamlandı (${this.pdfAnnotations.length})`
            );
            return;
          }
          this._pdfAnnotationRefreshTimer = setTimeout(tick, 3000);
        };

        this._pdfAnnotationRefreshTimer = setTimeout(tick, 2500);

        window.addEventListener(
          'focus',
          async () => {
            if (this.pdfUrl && this.activePdfItemKey === itemKey) {
              const update = await this.loadPdfAnnotations(itemKey, { force: true });
              this.appendPdfSyncHistory({
                itemKey,
                source: this.pdfSyncSource || source || 'reader',
                annotations: update?.annotations ?? this.pdfAnnotations.length,
                notes: this.currentPdfNoteCount(itemKey),
                delta: (update?.annotations ?? this.pdfAnnotations.length) - (update?.previous ?? this.pdfAnnotations.length),
              });
              this.showToast(
                this.aiLanguage === 'en'
                  ? `Annotations synced (${this.pdfAnnotations.length})`
                  : `Anotasyonlar senkronlandı (${this.pdfAnnotations.length})`
              );
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
        await this.launchZoteroUrl(zoteroUrl, { scheduleRefresh: true, source: 'reader' });
      },

      async openPdfInZoteroWeb() {
        if (!this.activePdfAttachmentKey) {
          this.showToast(this.aiLanguage === 'en' ? 'No active PDF attachment' : 'Etkin PDF eki bulunamadı');
          return;
        }
        const targetUrl = String(this.activePdfZoteroWebUrl || '').trim();
        if (!targetUrl) {
          this.showToast(
            this.aiLanguage === 'en'
              ? 'Zotero Web URL could not be resolved'
              : 'Zotero Web bağlantısı çözümlenemedi'
          );
          return;
        }
        try {
          window.open(targetUrl, '_blank', 'noopener,noreferrer');
          this.showToast(
            this.aiLanguage === 'en'
              ? 'Opened in Zotero Web (annotate there, auto-sync here)'
              : 'Zotero Web’de açıldı (oradan anotasyon yap, burada oto senkron)'
          );
          this.schedulePdfAnnotationRefresh('web');
        } catch (e) {
          this.showToast(
            this.aiLanguage === 'en'
              ? 'Could not open Zotero Web'
              : 'Zotero Web açılamadı'
          );
        }
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
          const children = await this.fetchPdfApiRows(`${ns.API}/items/${item.key}/children?format=json`);
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
          source: 'reader',
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

      isPdfJsAvailable() {
        return !!(window.pdfjsLib && typeof window.pdfjsLib.getDocument === 'function');
      },

      ensurePdfJsReady() {
        const lib = window.pdfjsLib;
        if (!lib || typeof lib.getDocument !== 'function') {
          throw new Error(this.aiLanguage === 'en' ? 'PDF.js could not be loaded' : 'PDF.js yüklenemedi');
        }
        // Guard against cached/foreign global script mismatch.
        const version = String(lib.version || '').trim();
        if (version && !version.startsWith('2.10.')) {
          throw new Error(
            this.aiLanguage === 'en'
              ? `Incompatible PDF.js version (${version}). Please hard refresh.`
              : `Uyumsuz PDF.js sürümü (${version}). Lütfen tam yenileyin.`
          );
        }
        // CDN worker fetch can fail in some local/network setups.
        // Keep worker path if available, but runtime also forces disableWorker below.
        if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
          lib.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
        }
        return lib;
      },

      waitForPdfCanvasAndShell(pageNum, timeoutMs = 2200) {
        const startedAt = Date.now();
        return new Promise((resolve) => {
          const tick = () => {
            const canvas = this.pdfPageCanvas(pageNum);
            const shell = this.pdfPageShell(pageNum);
            if (canvas && shell) {
              resolve({ canvas, shell });
              return;
            }
            if (Date.now() - startedAt >= timeoutMs) {
              resolve({ canvas: null, shell: null });
              return;
            }
            requestAnimationFrame(tick);
          };
          tick();
        });
      },

      pdfScrollRoot() {
        return this.$refs?.pdfScrollContainer || null;
      },

      pdfPageListRoot() {
        return this.$refs?.pdfPageList || null;
      },

      pdfPageShell(pageNum) {
        const list = this.pdfPageListRoot();
        if (!list) return null;
        return list.querySelector(`[data-pdf-page="${pageNum}"]`);
      },

      pdfPageCanvas(pageNum) {
        const list = this.pdfPageListRoot();
        if (!list) return null;
        return list.querySelector(`[data-pdf-canvas-page="${pageNum}"]`);
      },

      parsePdfPageNumber(value) {
        const raw = String(value ?? '').trim();
        if (!raw) return 0;
        const numeric = raw.match(/\d+/);
        const parsed = parseInt(numeric ? numeric[0] : raw, 10);
        if (!Number.isFinite(parsed)) return 0;
        return parsed;
      },

      pdfRenderCacheLimit() {
        return 16;
      },

      pdfRenderKeepRadius() {
        return 5;
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
          this.activePdfZoteroWebUrl = '';
        }

        this.destroyPdfViewer();

        const enclosure = attachment?.links?.enclosure?.href;
        const storagePath = this.relativeStoragePathFromEnclosure(enclosure);

        if (storagePath) {
          this.pdfUrl = '/pdf/' + encodeURI(storagePath);
          this.pdfTitle = item.data.title || 'PDF';
        } else {
          try {
            const children = await this.fetchPdfApiRows(`${ns.API}/items/${item.key}/children?format=json`);
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

        await this.loadPdfViewerDocument(item.key);
        const initial = await this.loadPdfAnnotations(item.key);
        this.appendPdfSyncHistory({
          itemKey: item.key,
          source: 'manual',
          annotations: initial?.annotations ?? this.pdfAnnotations.length,
          notes: this.currentPdfNoteCount(item.key),
          delta: 0,
        });
      },

      async retryPdfJsViewer() {
        const itemKey = String(this.activePdfItemKey || '').trim();
        if (!itemKey || !this.pdfUrl) return;
        this.pdfUseIframeFallback = false;
        this.pdfViewerError = '';
        await this.loadPdfViewerDocument(itemKey);
      },

      resolvePdfLoadErrorMessage(error) {
        const raw = String(error?.message || error || '').trim();
        if (!raw) return this.aiLanguage === 'en' ? 'PDF could not be rendered' : 'PDF görüntülenemedi';
        const normalized = raw.toLowerCase();
        const parseLike =
          normalized.includes('cannot read number') ||
          normalized.includes('invalidpdfexception') ||
          normalized.includes('formaterror') ||
          normalized.includes('xref') ||
          normalized.includes('corrupt');
        if (parseLike) {
          return this.aiLanguage === 'en'
            ? 'This PDF could not be parsed by advanced viewer. Fallback viewer is active.'
            : 'Bu PDF gelişmiş görüntüleyici ile çözümlenemedi. Yedek görüntüleyici aktif.';
        }
        if (this.aiLanguage === 'en') return `PDF render failed: ${raw}`;
        return `PDF görüntüleme hatası: ${raw}`;
      },

      async loadPdfViewerDocument(itemKey) {
        if (!this.pdfUrl || !itemKey) return;
        const loadToken = Number(this._pdfLoadToken || 0) + 1;
        this._pdfLoadToken = loadToken;
        this.pdfViewerReady = false;
        this.pdfViewerError = '';
        this.pdfUseIframeFallback = false;
        this.pdfPageCount = 0;
        this.pdfCurrentPage = 1;
        this.pdfPageNumbers = [];
        this.pdfRenderedPages = {};
        this.pdfSearchResults = [];
        this.pdfSearchActiveIndex = -1;
        this.pdfSearchBusy = false;
        this._pdfPageTextCache = {};
        this.cancelPdfRenderTasks();
        this.teardownPdfIntersectionObserver();

        let pdfjsLib;
        try {
          pdfjsLib = this.ensurePdfJsReady();
        } catch (e) {
          this.pdfUseIframeFallback = true;
          this.pdfViewerError = this.resolvePdfLoadErrorMessage(e);
          return;
        }

        const loadingTask = pdfjsLib.getDocument({
          url: this.pdfUrl,
          withCredentials: false,
          // More robust for malformed PDFs and custom local HTTP range behavior.
          disableRange: true,
          disableStream: true,
          disableAutoFetch: true,
          disableWorker: true,
        });
        this._pdfLoadingTask = loadingTask;

        let doc = null;
        try {
          doc = await loadingTask.promise;
        } catch (e) {
          if (loadToken !== this._pdfLoadToken) return;
          this.pdfUseIframeFallback = true;
          this.pdfViewerError = this.resolvePdfLoadErrorMessage(e);
          return;
        }

        if (loadToken !== this._pdfLoadToken) {
          try {
            await doc?.destroy?.();
          } catch (e) {
            // no-op
          }
          return;
        }

        this._pdfDocument = doc;
        this.pdfPageCount = Number(doc?.numPages || 0);
        this.pdfPageNumbers = Array.from({ length: this.pdfPageCount }, (_, idx) => idx + 1);
        this.pdfViewerReady = true;

        await this.$nextTick();
        if (loadToken !== this._pdfLoadToken) return;

        this.setupPdfIntersectionObserver();
        this.goToPdfPage(1, { smooth: false, ensureRendered: false });
        let renderedFirstPage = await Promise.race([
          this.ensurePdfPageRendered(1, 'initial'),
          new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
        ]);
        if (!renderedFirstPage && loadToken === this._pdfLoadToken) {
          await new Promise((resolve) => setTimeout(resolve, 220));
          renderedFirstPage = await Promise.race([
            this.ensurePdfPageRendered(1, 'initial-retry'),
            new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
          ]);
        }
        if (!renderedFirstPage && loadToken === this._pdfLoadToken) {
          this.cancelPdfRenderTasks();
          this.pdfUseIframeFallback = true;
          this.pdfViewerError =
            this.aiLanguage === 'en'
              ? 'PDF.js render failed, switched to fallback viewer'
              : 'PDF.js render başarısız oldu, yedek görüntüleyiciye geçildi';
          return;
        }
        if (this.pdfPageCount >= 2) {
          void this.ensurePdfPageRendered(2, 'initial');
        }
      },

      setupPdfIntersectionObserver() {
        this.teardownPdfIntersectionObserver();
        const root = this.pdfScrollRoot();
        const list = this.pdfPageListRoot();
        if (!root || !list || !this.pdfPageCount) return;

        const shells = Array.from(list.querySelectorAll('[data-pdf-page]'));
        if (!shells.length) return;

        if (!('IntersectionObserver' in window)) {
          const targetPages = [1, 2, 3].filter((p) => p <= this.pdfPageCount);
          targetPages.forEach((pageNum) => {
            void this.ensurePdfPageRendered(pageNum, 'fallback');
          });
          return;
        }

        this._pdfIntersectionObserver = new IntersectionObserver(
          (entries) => {
            entries.forEach((entry) => {
              if (!entry.isIntersecting) return;
              const pageNum = this.parsePdfPageNumber(entry.target?.dataset?.pdfPage);
              if (pageNum > 0) {
                void this.ensurePdfPageRendered(pageNum, 'intersection');
              }
            });
          },
          {
            root,
            rootMargin: '1200px 0px 1200px 0px',
            threshold: 0.01,
          }
        );

        shells.forEach((shell) => this._pdfIntersectionObserver.observe(shell));
      },

      async ensurePdfPageRendered(pageNum, reason = 'manual') {
        const parsedPage = this.parsePdfPageNumber(pageNum);
        if (!parsedPage || !this._pdfDocument || parsedPage > this.pdfPageCount) return false;
        if (this.pdfRenderedPages?.[parsedPage]) return true;

        const loadToken = this._pdfLoadToken;
        const renderEpoch = Number(this._pdfRenderEpoch || 0);
        const jobs = this._pdfRenderJobs && typeof this._pdfRenderJobs === 'object' ? this._pdfRenderJobs : {};
        this._pdfRenderJobs = jobs;

        const existingJob = jobs[parsedPage];
        if (existingJob?.promise) {
          try {
            await existingJob.promise;
          } catch (e) {
            // no-op
          }
          return !!this.pdfRenderedPages?.[parsedPage];
        }

        let renderTask = null;
        const jobPromise = (async () => {
          let canvas = this.pdfPageCanvas(parsedPage);
          let shell = this.pdfPageShell(parsedPage);
          if (!canvas || !shell) {
            await this.$nextTick();
            const waited = await this.waitForPdfCanvasAndShell(parsedPage, 2200);
            if (!this._pdfDocument || loadToken !== this._pdfLoadToken || renderEpoch !== Number(this._pdfRenderEpoch || 0)) {
              return false;
            }
            canvas = waited.canvas;
            shell = waited.shell;
          }
          if (!canvas || !shell) return false;

          try {
            const page = await this._pdfDocument.getPage(parsedPage);
            if (!this._pdfDocument || loadToken !== this._pdfLoadToken || renderEpoch !== Number(this._pdfRenderEpoch || 0)) {
              return false;
            }
            const viewport = page.getViewport({ scale: Number(this.pdfViewerScale || 1.1) });
            const dpr = window.devicePixelRatio || 1;
            const ctx = canvas.getContext('2d', { alpha: false });
            if (!ctx) return false;

            const surface = shell.querySelector('.pdf-page-surface');
            if (surface) {
              surface.style.minHeight = `${Math.max(200, Math.ceil(viewport.height))}px`;
              surface.style.minWidth = `${Math.max(180, Math.ceil(viewport.width))}px`;
            }

            canvas.width = Math.max(1, Math.ceil(viewport.width * dpr));
            canvas.height = Math.max(1, Math.ceil(viewport.height * dpr));
            canvas.style.width = `${Math.ceil(viewport.width)}px`;
            canvas.style.height = `${Math.ceil(viewport.height)}px`;

            const renderContext = {
              canvasContext: ctx,
              viewport,
              transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
            };
            renderTask = page.render(renderContext);
            this._pdfRenderTasks[parsedPage] = renderTask;
            await renderTask.promise;
            if (!this._pdfDocument || loadToken !== this._pdfLoadToken || renderEpoch !== Number(this._pdfRenderEpoch || 0)) {
              return false;
            }

            this.pdfRenderedPages = {
              ...(this.pdfRenderedPages || {}),
              [parsedPage]: {
                width: viewport.width,
                height: viewport.height,
                reason,
                renderedAt: Date.now(),
              },
            };
            this.evictPdfRenderCache();
            return true;
          } catch (e) {
            const name = String(e?.name || '');
            const message = String(e?.message || '');
            const isCanvasConcurrencyError =
              message.includes('Cannot use the same canvas during multiple render() operations');
            if (isCanvasConcurrencyError && loadToken === this._pdfLoadToken && renderEpoch === Number(this._pdfRenderEpoch || 0)) {
              setTimeout(() => {
                if (this._pdfDocument && loadToken === this._pdfLoadToken && renderEpoch === Number(this._pdfRenderEpoch || 0)) {
                  void this.ensurePdfPageRendered(parsedPage, 'retry-canvas-lock');
                }
              }, 90);
              return false;
            }
            if (name !== 'RenderingCancelledException' && loadToken === this._pdfLoadToken) {
              this.pdfViewerError = this.resolvePdfLoadErrorMessage(e);
            }
            return false;
          } finally {
            if (this._pdfRenderTasks?.[parsedPage] === renderTask) {
              delete this._pdfRenderTasks[parsedPage];
            }
          }
        })();

        jobs[parsedPage] = {
          promise: jobPromise,
          epoch: renderEpoch,
        };

        try {
          return await jobPromise;
        } finally {
          if (this._pdfRenderJobs?.[parsedPage]?.promise === jobPromise) {
            delete this._pdfRenderJobs[parsedPage];
          }
        }
      },

      evictPdfRenderCache() {
        const rendered = { ...(this.pdfRenderedPages || {}) };
        const keys = Object.keys(rendered).map((k) => parseInt(k, 10)).filter((n) => Number.isFinite(n));
        const limit = this.pdfRenderCacheLimit();
        if (keys.length <= limit) return;

        const currentPage = this.parsePdfPageNumber(this.pdfCurrentPage) || 1;
        const keepRadius = this.pdfRenderKeepRadius();
        const sorted = keys
          .map((page) => ({
            page,
            distance: Math.abs(page - currentPage),
            renderedAt: Number(rendered[page]?.renderedAt || 0),
          }))
          .sort((a, b) => b.distance - a.distance || a.renderedAt - b.renderedAt);

        let removable = keys.length - limit;
        for (const row of sorted) {
          if (removable <= 0) break;
          if (row.distance <= keepRadius) continue;
          const canvas = this.pdfPageCanvas(row.page);
          const shell = this.pdfPageShell(row.page);
          const prevHeight = Number(rendered[row.page]?.height || 0);
          const prevWidth = Number(rendered[row.page]?.width || 0);
          if (shell) {
            const surface = shell.querySelector('.pdf-page-surface');
            if (surface && prevHeight > 0) {
              surface.style.minHeight = `${Math.ceil(prevHeight)}px`;
              surface.style.minWidth = prevWidth > 0 ? `${Math.ceil(prevWidth)}px` : surface.style.minWidth;
            }
          }
          if (canvas) {
            canvas.width = 1;
            canvas.height = 1;
            canvas.style.width = '1px';
            canvas.style.height = '1px';
          }
          delete rendered[row.page];
          removable -= 1;
        }

        this.pdfRenderedPages = rendered;
      },

      onPdfScroll() {
        if (this._pdfScrollRaf) return;
        this._pdfScrollRaf = requestAnimationFrame(() => {
          this._pdfScrollRaf = 0;
          this.updatePdfCurrentPageFromScroll();
        });
      },

      updatePdfCurrentPageFromScroll() {
        const root = this.pdfScrollRoot();
        if (!root) return;
        const list = this.pdfPageListRoot();
        if (!list) return;
        const shells = Array.from(list.querySelectorAll('[data-pdf-page]'));
        if (!shells.length) return;

        const rootRect = root.getBoundingClientRect();
        const focusY = rootRect.top + (root.clientHeight * 0.45);
        let bestPage = this.parsePdfPageNumber(this.pdfCurrentPage) || 1;
        let bestDist = Number.POSITIVE_INFINITY;

        shells.forEach((shell) => {
          const page = this.parsePdfPageNumber(shell?.dataset?.pdfPage);
          if (!page) return;
          const rect = shell.getBoundingClientRect();
          const center = rect.top + (rect.height / 2);
          const dist = Math.abs(center - focusY);
          if (dist < bestDist) {
            bestDist = dist;
            bestPage = page;
          }
        });

        if (bestPage !== this.pdfCurrentPage) {
          this.pdfCurrentPage = bestPage;
        }
        this.prefetchPdfAroundPage(bestPage);
        this.evictPdfRenderCache();
      },

      prefetchPdfAroundPage(page) {
        const current = this.parsePdfPageNumber(page);
        if (!current || !this.pdfPageCount) return;
        const candidates = [current - 1, current, current + 1, current + 2];
        candidates
          .filter((p) => p >= 1 && p <= this.pdfPageCount)
          .forEach((p) => {
            void this.ensurePdfPageRendered(p, 'prefetch');
          });
      },

      goToPdfPage(pageNumber, options = {}) {
        const page = this.parsePdfPageNumber(pageNumber);
        if (!page || !this.pdfPageCount) return;
        const bounded = Math.max(1, Math.min(this.pdfPageCount, page));
        const shell = this.pdfPageShell(bounded);
        const root = this.pdfScrollRoot();
        this.pdfCurrentPage = bounded;

        if (options.ensureRendered !== false) {
          void this.ensurePdfPageRendered(bounded, 'goto');
        }

        if (root && shell) {
          const top = Math.max(0, shell.offsetTop - 10);
          root.scrollTo({
            top,
            behavior: options.smooth === false ? 'auto' : 'smooth',
          });
        }
      },

      goToPdfPageFromLabel(pageLabel) {
        const parsed = this.parsePdfPageNumber(pageLabel);
        if (!parsed) return;
        this.goToPdfPage(parsed, { smooth: true });
      },

      prevPdfPage() {
        if (!this.pdfPageCount) return;
        this.goToPdfPage(this.pdfCurrentPage - 1, { smooth: true });
      },

      nextPdfPage() {
        if (!this.pdfPageCount) return;
        this.goToPdfPage(this.pdfCurrentPage + 1, { smooth: true });
      },

      formatPdfZoomLabel() {
        const value = Number(this.pdfViewerScale || 1);
        return `${Math.round(value * 100)}%`;
      },

      setPdfZoom(nextScale) {
        const parsed = Number(nextScale || 1.1);
        if (!Number.isFinite(parsed)) return;
        const bounded = Math.max(0.55, Math.min(2.6, parsed));
        if (Math.abs(bounded - Number(this.pdfViewerScale || 1.1)) < 0.001) return;
        this.pdfViewerScale = bounded;
        this.rerenderPdfForZoom();
      },

      zoomInPdf() {
        this.setPdfZoom(Number(this.pdfViewerScale || 1.1) + 0.15);
      },

      zoomOutPdf() {
        this.setPdfZoom(Number(this.pdfViewerScale || 1.1) - 0.15);
      },

      rerenderPdfForZoom() {
        if (!this._pdfDocument || !this.pdfPageCount) return;
        this.cancelPdfRenderTasks();
        this.pdfRenderedPages = {};
        const current = this.parsePdfPageNumber(this.pdfCurrentPage) || 1;
        requestAnimationFrame(() => {
          if (!this._pdfDocument || !this.pdfPageCount) return;
          this.prefetchPdfAroundPage(current);
        });
      },

      pdfSearchLocale() {
        return this.aiLanguage === 'en' ? 'en-US' : 'tr-TR';
      },

      pdfSearchResultLabel() {
        if (this.pdfSearchBusy) {
          return this.aiLanguage === 'en' ? '...' : '...';
        }
        if (!this.pdfSearchQuery.trim()) {
          return '';
        }
        if (!this.pdfSearchResults.length) {
          return this.aiLanguage === 'en' ? '0/0' : '0/0';
        }
        const current = this.pdfSearchActiveIndex >= 0 ? this.pdfSearchActiveIndex + 1 : 0;
        return `${current}/${this.pdfSearchResults.length}`;
      },

      async getPdfPageText(pageNum) {
        const page = this.parsePdfPageNumber(pageNum);
        if (!page || !this._pdfDocument) return '';
        const cache = this._pdfPageTextCache || {};
        if (typeof cache[page] === 'string') {
          return cache[page];
        }
        try {
          const pageRef = await this._pdfDocument.getPage(page);
          const textContent = await pageRef.getTextContent();
          const text = (textContent?.items || [])
            .map((row) => row?.str || '')
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          this._pdfPageTextCache = {
            ...cache,
            [page]: text,
          };
          return text;
        } catch (e) {
          return '';
        }
      },

      buildPdfSearchSnippet(text, index, queryLen) {
        const raw = String(text || '').replace(/\s+/g, ' ').trim();
        if (!raw) return '';
        const start = Math.max(0, index - 72);
        const end = Math.min(raw.length, index + Math.max(24, queryLen) + 96);
        const prefix = start > 0 ? '... ' : '';
        const suffix = end < raw.length ? ' ...' : '';
        return `${prefix}${raw.slice(start, end).trim()}${suffix}`;
      },

      async runPdfSearch() {
        const query = String(this.pdfSearchQuery || '').trim();
        const token = Number(this._pdfSearchToken || 0) + 1;
        this._pdfSearchToken = token;

        if (!query || !this._pdfDocument || !this.pdfPageCount) {
          this.pdfSearchResults = [];
          this.pdfSearchActiveIndex = -1;
          this.pdfSearchBusy = false;
          return;
        }

        this.pdfSearchBusy = true;
        const locale = this.pdfSearchLocale();
        const q = query.toLocaleLowerCase(locale);
        const results = [];

        for (let page = 1; page <= this.pdfPageCount; page += 1) {
          if (token !== this._pdfSearchToken) return;
          const text = await this.getPdfPageText(page);
          if (!text) continue;
          const haystack = text.toLocaleLowerCase(locale);
          let cursor = 0;
          let perPageCount = 0;
          while (cursor < haystack.length && perPageCount < 4) {
            const found = haystack.indexOf(q, cursor);
            if (found < 0) break;
            results.push({
              page,
              index: found,
              snippet: this.buildPdfSearchSnippet(text, found, q.length),
            });
            cursor = found + q.length;
            perPageCount += 1;
            if (results.length >= 240) break;
          }
          if (results.length >= 240) break;
        }

        if (token !== this._pdfSearchToken) return;
        this.pdfSearchResults = results;
        this.pdfSearchBusy = false;
        this.showPdfAnnotations = this.showPdfAnnotations || results.length > 0;

        if (results.length > 0) {
          this.pdfSearchActiveIndex = 0;
          this.goToPdfPage(results[0].page, { smooth: true });
        } else {
          this.pdfSearchActiveIndex = -1;
        }
      },

      goToPdfSearchResult(index) {
        const total = this.pdfSearchResults.length;
        if (!total) return;
        const parsed = Number(index);
        if (!Number.isFinite(parsed)) return;
        const bounded = Math.max(0, Math.min(total - 1, parsed));
        this.pdfSearchActiveIndex = bounded;
        const row = this.pdfSearchResults[bounded];
        if (!row?.page) return;
        this.goToPdfPage(row.page, { smooth: true });
      },

      goToPrevPdfSearchResult() {
        const total = this.pdfSearchResults.length;
        if (!total) return;
        const current = this.pdfSearchActiveIndex >= 0 ? this.pdfSearchActiveIndex : 0;
        const next = (current - 1 + total) % total;
        this.goToPdfSearchResult(next);
      },

      goToNextPdfSearchResult() {
        const total = this.pdfSearchResults.length;
        if (!total) return;
        const current = this.pdfSearchActiveIndex >= 0 ? this.pdfSearchActiveIndex : -1;
        const next = (current + 1 + total) % total;
        this.goToPdfSearchResult(next);
      },

      async loadPdfAnnotations(itemKey, options = {}) {
        const force = !!options.force;
        const currentRows = Array.isArray(this.annotationCache?.[itemKey]) ? this.annotationCache[itemKey] : [];
        const currentSignature = currentRows.map((row) => `${row?.key || ''}:${row?.text || ''}:${row?.comment || ''}`).join('|');
        if (!force && this.annotationCache[itemKey]) {
          const cached = this.annotationCache[itemKey];
          const rows = Array.isArray(cached) ? cached : (Array.isArray(cached?.items) ? cached.items : []);
          this.pdfAnnotations = [...rows];
          this.pdfAnnotationsUpdatedAt = this.getPdfAnnotationsTimestamp(itemKey) || Date.now();
          this.showPdfAnnotations = this.pdfAnnotations.length > 0 || this.pdfSearchResults.length > 0;
          return {
            itemKey,
            fromCache: true,
            changed: false,
            annotations: this.pdfAnnotations.length,
            previous: rows.length,
          };
        }

        try {
          const children = await this.fetchPdfApiRows(`${ns.API}/items/${itemKey}/children?format=json`);
          const annotations = this.normalizeAnnotationRows(children);
          this.setPdfAnnotationsState(itemKey, annotations);
          const nextSignature = annotations.map((row) => `${row?.key || ''}:${row?.text || ''}:${row?.comment || ''}`).join('|');
          return {
            itemKey,
            fromCache: false,
            changed: nextSignature !== currentSignature,
            annotations: annotations.length,
            previous: currentRows.length,
          };
        } catch (e) {
          this.pdfAnnotations = [];
          this.pdfAnnotationsUpdatedAt = 0;
          return {
            itemKey,
            fromCache: false,
            changed: currentRows.length > 0,
            annotations: 0,
            previous: currentRows.length,
            error: String(e?.message || ''),
          };
        }
      },

      async refreshPdfAnnotationsNow() {
        if (!this.activePdfItemKey) return;
        const itemKey = this.activePdfItemKey;
        const update = await this.loadPdfAnnotations(itemKey, { force: true });
        this.pdfSyncInProgress = false;
        this.pdfSyncSource = '';
        this.appendPdfSyncHistory({
          itemKey,
          source: 'manual',
          annotations: update?.annotations ?? this.pdfAnnotations.length,
          notes: this.currentPdfNoteCount(itemKey),
          delta: (update?.annotations ?? this.pdfAnnotations.length) - (update?.previous ?? this.pdfAnnotations.length),
        });
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
          const parentChildren = await this.fetchPdfApiRows(`${ns.API}/items/${itemKey}/children?format=json`);
          const directAnnotations = this.normalizeAnnotationRows(parentChildren);
          const attachments = parentChildren.filter(
            (c) => c?.data?.itemType === 'attachment' && c?.data?.contentType === 'application/pdf'
          );

          const attachmentTasks = attachments.map((attachment) => async () => {
            try {
              const rows = await this.fetchPdfApiRows(`${ns.API}/items/${attachment.key}/children?format=json`);
              return this.normalizeAnnotationRows(rows);
            } catch (e) {
              return [];
            }
          });
          const nestedLists = typeof this.runTasksWithConcurrency === 'function'
            ? await this.runTasksWithConcurrency(attachmentTasks, Math.min(4, this.fetchConcurrencyLimit?.() || 4))
            : await Promise.all(
                attachments.map(async (attachment) => {
                  try {
                    const rows = await this.fetchPdfApiRows(`${ns.API}/items/${attachment.key}/children?format=json`);
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

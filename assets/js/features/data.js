(function (window) {
  const ns = window.ZoteroDashboard;

  ns.detectUserId = async function detectUserId() {
    try {
      const res = await fetch('/api/users/0/items?format=json&limit=1');
      const data = await res.json();
      if (data.length > 0 && data[0].library?.id) return data[0].library.id;
    } catch (e) {
      // no-op
    }
    return 0;
  };

  ns.registerMixin(function registerData() {
    return {
      toggleCollapse(key) {
        const idx = this.expandedCollections.indexOf(key);
        if (idx >= 0) this.expandedCollections.splice(idx, 1);
        else this.expandedCollections.push(key);
      },

      bumpItemsVersion() {
        this._itemsVersion = Number(this._itemsVersion || 0) + 1;
      },

      setItems(items) {
        this.items = Array.isArray(items) ? items : [];
        this.bumpItemsVersion();
      },

      fetchConcurrencyLimit() {
        return 6;
      },

      fetchRetryAttempts() {
        return 3;
      },

      fetchRetryBaseDelayMs() {
        return 280;
      },

      isAbortError(error) {
        return error?.name === 'AbortError';
      },

      async sleepMs(ms) {
        return new Promise((resolve) => {
          window.setTimeout(resolve, Math.max(0, Number(ms) || 0));
        });
      },

      async readApiErrorDetail(res) {
        try {
          const text = (await res.text() || '').trim();
          if (!text) return '';
          try {
            const parsed = JSON.parse(text);
            return parsed?.error || parsed?.message || text;
          } catch (e) {
            return text;
          }
        } catch (e) {
          return '';
        }
      },

      async fetchWithRetry(url, options = {}) {
        const attempts = Math.max(1, Number(options.attempts || this.fetchRetryAttempts()));
        const baseDelay = Math.max(120, Number(options.baseDelayMs || this.fetchRetryBaseDelayMs()));
        const method = options.method || 'GET';
        const headers = options.headers || {};
        const body = options.body;
        const signal = options.signal;

        let lastError = null;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          try {
            const res = await fetch(url, { method, headers, body, signal });
            if (res.ok) return res;

            const detail = await this.readApiErrorDetail(res);
            const retryableStatus = res.status === 429 || res.status >= 500;
            const canRetry = attempt < attempts && retryableStatus;
            if (!canRetry) {
              const nonRetryError = new Error(`API ${res.status}${detail ? `: ${detail}` : ''}`);
              nonRetryError.nonRetry = true;
              throw nonRetryError;
            }
            lastError = new Error(`API ${res.status}${detail ? `: ${detail}` : ''}`);
          } catch (e) {
            if (this.isAbortError(e)) throw e;
            if (e?.nonRetry) throw e;
            lastError = e;
            if (attempt >= attempts) break;
          }
          const backoffMs = baseDelay * Math.pow(2, attempt - 1);
          await this.sleepMs(backoffMs);
        }
        throw lastError || new Error('Unknown network error');
      },

      async fetchJsonAbsolute(url, options = {}) {
        const res = await this.fetchWithRetry(url, options);
        let data = null;
        try {
          data = await res.json();
        } catch (e) {
          throw new Error(this.aiLanguage === 'en' ? 'Invalid JSON response' : 'Geçersiz JSON yanıtı');
        }
        return { res, data };
      },

      async runTasksWithConcurrency(taskFns, limit = this.fetchConcurrencyLimit()) {
        const tasks = Array.isArray(taskFns) ? taskFns : [];
        if (!tasks.length) return [];
        const maxWorkers = Math.max(1, Math.min(Number(limit) || 1, tasks.length));
        const results = new Array(tasks.length);
        let nextIdx = 0;
        const worker = async () => {
          while (true) {
            const idx = nextIdx;
            nextIdx += 1;
            if (idx >= tasks.length) return;
            results[idx] = await tasks[idx]();
          }
        };
        await Promise.all(Array.from({ length: maxWorkers }, () => worker()));
        return results;
      },

      beginVisibleItemsRequest() {
        if (this._visibleItemsAbortController) {
          this._visibleItemsAbortController.abort();
        }
        const controller = new AbortController();
        this._visibleItemsAbortController = controller;
        this._visibleItemsRequestSeq = Number(this._visibleItemsRequestSeq || 0) + 1;
        return {
          controller,
          requestSeq: this._visibleItemsRequestSeq,
        };
      },

      isLatestVisibleItemsRequest(requestSeq) {
        return Number(requestSeq || 0) === Number(this._visibleItemsRequestSeq || 0);
      },

      async apiFetch(path) {
        return this.fetchJsonAbsolute(`${ns.API}${path}`);
      },

      selfCheckStatusLabel(status) {
        const normalized = String(status || 'unknown').toLowerCase();
        if (this.aiLanguage === 'en') {
          if (normalized === 'ok') return 'OK';
          if (normalized === 'degraded') return 'Degraded';
          if (normalized === 'down') return 'Down';
          return 'Unknown';
        }
        if (normalized === 'ok') return 'İyi';
        if (normalized === 'degraded') return 'Sorunlu';
        if (normalized === 'down') return 'Kapalı';
        return 'Bilinmiyor';
      },

      selfCheckStatusClass(status) {
        const normalized = String(status || 'unknown').toLowerCase();
        if (normalized === 'ok') return 'text-emerald-400';
        if (normalized === 'degraded') return 'text-amber-400';
        if (normalized === 'down') return 'text-red-400';
        return 'text-slate-400';
      },

      selfCheckRowLabel(key) {
        const labels = this.aiLanguage === 'en'
          ? {
              zoteroDesktop: 'Zotero Desktop',
              zoteroMcp: 'Zotero Bridge',
              claudeCli: 'Claude CLI',
              codexCli: 'Codex CLI',
              geminiCli: 'Gemini CLI',
            }
          : {
              zoteroDesktop: 'Zotero Desktop',
              zoteroMcp: 'Zotero Köprüsü',
              claudeCli: 'Claude CLI',
              codexCli: 'Codex CLI',
              geminiCli: 'Gemini CLI',
            };
        return labels[key] || key;
      },

      orderedSelfCheckRows() {
        return ['zoteroDesktop', 'zoteroMcp', 'claudeCli', 'codexCli', 'geminiCli'];
      },

      cliProviderLabel(provider) {
        if (provider === 'claude') return 'Claude';
        if (provider === 'codex') return 'Codex';
        if (provider === 'gemini') return 'Gemini';
        return provider;
      },

      normalizeCliOverrides(raw = {}) {
        const source = raw && typeof raw === 'object' ? raw : {};
        return {
          claude: String(source.claude || '').trim(),
          codex: String(source.codex || '').trim(),
          gemini: String(source.gemini || '').trim(),
        };
      },

      async loadCliConfig() {
        this.cliConfigLoading = true;
        try {
          const res = await fetch('/cli-config');
          const raw = await res.text();
          let data = {};
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch (e) {
            throw new Error(this.aiLanguage === 'en' ? 'CLI config response is not valid JSON' : 'CLI yapılandırma yanıtı geçerli JSON değil');
          }
          if (!res.ok) {
            throw new Error(data?.error || `/cli-config ${res.status}`);
          }
          this.cliCommandOverrides = this.normalizeCliOverrides(data?.overrides || {});
        } catch (e) {
          this.showToast(e?.message || (this.aiLanguage === 'en' ? 'CLI config could not be loaded' : 'CLI yapılandırması yüklenemedi'));
        } finally {
          this.cliConfigLoading = false;
        }
      },

      async saveCliConfig() {
        if (this.cliConfigSaving) return;
        this.cliConfigSaving = true;
        try {
          const payload = this.normalizeCliOverrides(this.cliCommandOverrides || {});
          const res = await fetch('/cli-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const raw = await res.text();
          let data = {};
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch (e) {
            throw new Error(this.aiLanguage === 'en' ? 'CLI config response is not valid JSON' : 'CLI yapılandırma yanıtı geçerli JSON değil');
          }
          if (!res.ok) {
            throw new Error(data?.error || `/cli-config ${res.status}`);
          }
          this.cliCommandOverrides = this.normalizeCliOverrides(data?.overrides || {});
          this.showToast(this.aiLanguage === 'en' ? 'CLI paths saved' : 'CLI yolları kaydedildi');
          if (typeof this.runStartupSelfCheck === 'function') {
            await this.runStartupSelfCheck(true);
          }
          if (typeof this.refreshProviderHealth === 'function') {
            await this.refreshProviderHealth();
          }
        } catch (e) {
          this.showToast(e?.message || (this.aiLanguage === 'en' ? 'CLI config could not be saved' : 'CLI yapılandırması kaydedilemedi'));
        } finally {
          this.cliConfigSaving = false;
        }
      },

      selfCheckRowOk(key) {
        return String(this.selfCheck?.[key]?.status || '').toLowerCase() === 'ok';
      },

      selfCheckAnyCliOk() {
        return ['claudeCli', 'codexCli', 'geminiCli'].some((key) => this.selfCheckRowOk(key));
      },

      aiPreflightState() {
        if (!this.selfCheckRan) {
          return {
            ready: false,
            code: 'CHECK_PENDING',
            message: this.aiLanguage === 'en'
              ? 'Self-check not completed yet.'
              : 'Self-check henüz tamamlanmadı.',
          };
        }

        if (String(this.selfCheckError || '').trim()) {
          return {
            ready: false,
            code: 'CHECK_ERROR',
            message: this.aiLanguage === 'en'
              ? 'Self-check failed. Refresh checks before sending AI requests.'
              : 'Self-check başarısız. AI isteği göndermeden önce kontrolü yenileyin.',
          };
        }

        if (!this.selfCheckRowOk('zoteroDesktop')) {
          return {
            ready: false,
            code: 'ZOTERO_DOWN',
            message: this.aiLanguage === 'en'
              ? 'Zotero Desktop is not reachable.'
              : 'Zotero Desktop erişilemez durumda.',
          };
        }

        if (!this.selfCheckRowOk('zoteroMcp')) {
          return {
            ready: false,
            code: 'MCP_DOWN',
            message: this.aiLanguage === 'en'
              ? 'Zotero bridge is not ready.'
              : 'Zotero köprüsü hazır değil.',
          };
        }

        if (!this.selfCheckAnyCliOk()) {
          return {
            ready: false,
            code: 'CLI_DOWN',
            message: this.aiLanguage === 'en'
              ? 'No AI CLI is healthy.'
              : 'Sağlıklı AI CLI bulunamadı.',
          };
        }

        return {
          ready: true,
          code: 'OK',
          message: this.aiLanguage === 'en'
            ? 'AI requests are ready.'
            : 'AI istekleri hazır.',
        };
      },

      aiPreflightReady() {
        return this.aiPreflightState().ready;
      },

      aiPreflightMessage() {
        return this.aiPreflightState().message;
      },

      clearSelfCheckAutoHideTimer() {
        if (this._selfCheckAutoHideTimer) {
          clearTimeout(this._selfCheckAutoHideTimer);
          this._selfCheckAutoHideTimer = null;
        }
      },

      startSelfCheckPolling() {
        if (this._selfCheckPollTimer) return;
        const tick = () => {
          if (document.hidden) return;
          this.runStartupSelfCheck(false);
        };
        this._selfCheckPollTimer = setInterval(tick, 30000);
      },

      scheduleSelfCheckAutoHide(delayMs = 9000) {
        this.clearSelfCheckAutoHideTimer();
        this._selfCheckAutoHideTimer = setTimeout(() => {
          this.selfCheckOpen = false;
          this._selfCheckAutoHideTimer = null;
        }, Math.max(4000, Number(delayMs) || 9000));
      },

      async runStartupSelfCheck(forceOpen = false) {
        if (this.selfCheckLoading) return;
        if (forceOpen) {
          this.selfCheckOpen = true;
          this.clearSelfCheckAutoHideTimer();
        }
        this.selfCheckLoading = true;
        this.selfCheckError = '';
        try {
          const res = await fetch('/self-check');
          const raw = await res.text();
          let data = {};
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch (e) {
            throw new Error(this.aiLanguage === 'en' ? 'Self-check response is not valid JSON' : 'Self-check yanıtı geçerli JSON değil');
          }
          if (!res.ok) {
            throw new Error(data?.error || `/self-check ${res.status}`);
          }
          const checks = data?.checks && typeof data.checks === 'object' ? data.checks : {};
          this.selfCheck = {
            ...this.selfCheck,
            ...checks,
          };
          this.selfCheckRan = true;
          this.selfCheckLastRunAt = Date.now();
          const checkOk = data?.ok === true;
          const hasIssue = Object.values(this.selfCheck || {}).some((row) => {
            const normalized = String(row?.status || 'unknown').toLowerCase();
            return normalized !== 'ok';
          });
          if (forceOpen) {
            // Manual open from header should stay visible until user closes it.
            this.selfCheckOpen = true;
          } else if (checkOk && !hasIssue) {
            this.clearSelfCheckAutoHideTimer();
            this.selfCheckOpen = false;
          } else {
            // Auto-open only when there is a problem (degraded/down/unknown).
            this.selfCheckOpen = true;
            this.scheduleSelfCheckAutoHide(9000);
          }
        } catch (e) {
          this.selfCheckRan = true;
          this.selfCheckLastRunAt = Date.now();
          this.selfCheckError = e?.message || (this.aiLanguage === 'en' ? 'Self-check failed' : 'Self-check başarısız');
          this.selfCheckOpen = true;
          if (!forceOpen) {
            this.scheduleSelfCheckAutoHide(9000);
          }
        } finally {
          this.selfCheckLoading = false;
          if (typeof this.runChatTaskQueue === 'function' && this.aiPreflightReady()) {
            this.runChatTaskQueue();
          }
        }
      },

      async init() {
        this.loading = true;
        this.connectionError = '';
        try {
          try {
            const savedProvider = localStorage.getItem('zotero-ai-provider');
            if (savedProvider && this.aiProviders.some((p) => p.value === savedProvider)) {
              this.aiProvider = savedProvider;
            }
            const savedLanguage = localStorage.getItem('zotero-ui-language') || localStorage.getItem('zotero-ai-language');
            if (savedLanguage && this.aiLanguages.some((l) => l.value === savedLanguage)) {
              this.aiLanguage = savedLanguage;
            }
          } catch (e) {
            // no-op
          }

          if (typeof this.loadAiModelPreference === 'function') {
            this.loadAiModelPreference(this.aiProvider);
          }
          if (typeof this.loadAiAnalysisModePreference === 'function') {
            this.loadAiAnalysisModePreference();
          }
          if (typeof this.loadChatTopicPreference === 'function') {
            this.loadChatTopicPreference();
          }
          if (typeof this.loadPipelineTemplatePreference === 'function') {
            this.loadPipelineTemplatePreference();
          }
          if (typeof this.loadPipelineChunkLimitPreference === 'function') {
            this.loadPipelineChunkLimitPreference();
          }
          if (typeof this.loadSourceRoutingModePreference === 'function') {
            this.loadSourceRoutingModePreference();
          }
          if (typeof this.loadListDensityPreference === 'function') {
            this.loadListDensityPreference();
          }
          if (typeof this.loadDetailPanelWidthPreference === 'function') {
            this.loadDetailPanelWidthPreference();
          }
          if (typeof this.bindDetailPanelViewportSync === 'function') {
            this.bindDetailPanelViewportSync();
          }
          if (typeof this.runStartupSelfCheck === 'function') {
            await this.runStartupSelfCheck(false);
          }
          if (typeof this.loadCliConfig === 'function') {
            await this.loadCliConfig();
          }
          if (typeof this.startSelfCheckPolling === 'function') {
            this.startSelfCheckPolling();
          }
          if (typeof this.refreshProviderHealth === 'function') {
            await this.refreshProviderHealth();
          }
          if (typeof this.startProviderHealthPolling === 'function') {
            this.startProviderHealthPolling();
          }

          if (typeof this.applyUiLanguage === 'function') {
            this.applyUiLanguage();
          }

          this.theme = localStorage.getItem('zotero-theme') || 'light';
          this.applyTheme();

          if (typeof this.loadPersistedChatCache === 'function') {
            this.loadPersistedChatCache();
          }

          if (typeof this.loadObsidianConfig === 'function') {
            await this.loadObsidianConfig();
          }

          this.userId = await ns.detectUserId();
          ns.API = `/api/users/${this.userId}`;

          const [itemsR, colsR, tagsR] = await Promise.all([
            this.apiFetch('/items?format=json&limit=100&start=0'),
            this.apiFetch('/collections?format=json'),
            this.apiFetch('/tags?format=json'),
          ]);

          this.setItems(itemsR.data);
          if (typeof this.rememberItems === 'function') {
            this.rememberItems(this.items);
          }
          this.collections = colsR.data;
          this.allTags = tagsR.data
            .map((t) => ({ tag: t.tag, count: t.meta?.numItems || 0 }))
            .sort((a, b) => b.count - a.count);
          this.topTags = this.allTags.slice(0, 40);
          this.allItemsCount = this.items.filter((i) => this.isPrimaryLibraryItem(i)).length;
          this.connected = true;

          const total = parseInt(itemsR.res.headers.get('Total-Results') || '0', 10);
          if (total > 100) await this.loadAllItems(total);
          this.markPdfItems();

          this.$watch('showAllTags', (v) => {
            this.topTags = v ? this.allTags : this.allTags.slice(0, 40);
          });

          this.$watch('aiLanguage', () => {
            if (typeof this.applyUiLanguage === 'function') {
              this.applyUiLanguage();
            }
          });

          if (!this._keyboardBound) {
            document.addEventListener('keydown', (e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                this.$refs.searchInput?.focus();
              }
              if (e.key === 'Escape') {
                if (this.chatLoading && typeof this.stopChatRequest === 'function') {
                  this.stopChatRequest();
                  return;
                }
                if (this.pdfUrl) {
                  if (typeof this.closePdfPanel === 'function') {
                    this.closePdfPanel();
                  } else {
                    this.pdfUrl = null;
                    this.pdfAnnotations = [];
                    this.activePdfItemKey = null;
                  }
                } else if (this.selectedItem) {
                  this.persistChatForCurrentItem();
                  this.selectedItem = null;
                }
              }
            });
            this._keyboardBound = true;
          }
        } catch (e) {
          console.error(e);
          this.connectionError = e?.message || 'Unknown connection error';
          this.connected = false;
        }
        this.loading = false;
      },

      async loadAllItems(total) {
        const tasks = [];
        for (let start = 100; start < total; start += 100) {
          const pageUrl = `${ns.API}/items?format=json&limit=100&start=${start}`;
          tasks.push(async () => {
            const page = await this.fetchJsonAbsolute(pageUrl);
            return Array.isArray(page.data) ? page.data : [];
          });
        }
        const batches = await this.runTasksWithConcurrency(tasks, this.fetchConcurrencyLimit());
        const merged = [...this.items];
        batches.forEach((batch) => {
          if (Array.isArray(batch) && batch.length) {
            merged.push(...batch);
          }
        });
        this.setItems(merged);

        if (typeof this.rememberItems === 'function') {
          this.rememberItems(this.items);
        }
        this.allItemsCount = this.items.filter((i) => this.isPrimaryLibraryItem(i)).length;
        this.markPdfItems();
      },

      currentItemsBaseUrl() {
        let url = this.selectedCollection
          ? `${ns.API}/collections/${this.selectedCollection}/items?format=json`
          : `${ns.API}/items?format=json`;
        const q = this.searchQuery.trim();
        if (q) url += `&q=${encodeURIComponent(q)}`;
        return url;
      },

      async fetchAllPages(baseUrl, options = {}) {
        const signal = options.signal;
        const first = await this.fetchJsonAbsolute(`${baseUrl}&limit=100&start=0`, { signal });
        let rows = Array.isArray(first.data) ? first.data : [];
        const total = parseInt(first.res.headers.get('Total-Results') || `${rows.length}`, 10);
        if (total > 100) {
          const tasks = [];
          for (let start = 100; start < total; start += 100) {
            const pageUrl = `${baseUrl}&limit=100&start=${start}`;
            tasks.push(async () => {
              const page = await this.fetchJsonAbsolute(pageUrl, { signal });
              return Array.isArray(page.data) ? page.data : [];
            });
          }
          const batches = await this.runTasksWithConcurrency(tasks, this.fetchConcurrencyLimit());
          batches.forEach((batch) => {
            if (Array.isArray(batch) && batch.length) {
              rows = rows.concat(batch);
            }
          });
        }
        return rows;
      },

      async reloadVisibleItems() {
        const { controller, requestSeq } = this.beginVisibleItemsRequest();
        try {
          const rows = await this.fetchAllPages(this.currentItemsBaseUrl(), { signal: controller.signal });
          if (!this.isLatestVisibleItemsRequest(requestSeq)) return false;
          this.setItems(rows);
          if (typeof this.rememberItems === 'function') {
            this.rememberItems(this.items);
          }
          this.markPdfItems();
          return true;
        } catch (e) {
          if (this.isAbortError(e)) return false;
          throw e;
        } finally {
          if (this._visibleItemsAbortController === controller) {
            this._visibleItemsAbortController = null;
          }
        }
      },

      async search() {
        this.currentPage = 1;
        this.activeView = 'items';
        try {
          await this.reloadVisibleItems();
        } catch (e) {
          if (this.isAbortError(e)) return;
          this.showToast(this.aiLanguage === 'en' ? 'Search failed' : 'Arama sırasında hata oluştu');
        }
      },

      async selectCollection(key) {
        this.selectedCollection = key;
        this.currentPage = 1;
        this.activeView = 'items';
        try {
          await this.reloadVisibleItems();
        } catch (e) {
          if (this.isAbortError(e)) return;
          this.showToast(this.aiLanguage === 'en' ? 'Collection could not be loaded' : 'Koleksiyon yüklenemedi');
        }
      },

      toggleTag(tag) {
        this.selectedTag = this.selectedTag === tag ? null : tag;
        this.currentPage = 1;
      },

      hasActiveItemFilters() {
        return Boolean(
          this.selectedCollection ||
          this.selectedTag ||
          this.selectedItemType !== 'all' ||
          this.searchQuery.trim() ||
          this.localFilterQuery.trim()
        );
      },

      async clearAllFiltersAndReload() {
        this.selectedCollection = null;
        this.selectedTag = null;
        this.selectedItemType = 'all';
        this.searchQuery = '';
        this.localFilterQuery = '';
        this.currentPage = 1;
        this.activeView = 'items';
        try {
          await this.reloadVisibleItems();
        } catch (e) {
          if (this.isAbortError(e)) return;
          this.showToast(this.aiLanguage === 'en' ? 'Filters could not be reset' : 'Filtreler sıfırlanamadı');
        }
      },
    };
  });
})(window);

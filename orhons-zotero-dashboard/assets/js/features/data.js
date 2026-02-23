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

      async apiFetch(path) {
        const res = await fetch(`${ns.API}${path}`);
        if (!res.ok) {
          let detail = '';
          try {
            const text = (await res.text() || '').trim();
            if (text) {
              let parsed = null;
              try {
                parsed = JSON.parse(text);
              } catch (e) {
                // no-op
              }
              detail = parsed?.error || text;
            }
          } catch (e) {
            // no-op
          }
          throw new Error(`API ${res.status}${detail ? `: ${detail}` : ''}`);
        }
        return { res, data: await res.json() };
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
              zoteroMcp: 'zotero-mcp',
              claudeCli: 'Claude CLI',
              codexCli: 'Codex CLI',
              geminiCli: 'Gemini CLI',
            }
          : {
              zoteroDesktop: 'Zotero Desktop',
              zoteroMcp: 'zotero-mcp',
              claudeCli: 'Claude CLI',
              codexCli: 'Codex CLI',
              geminiCli: 'Gemini CLI',
            };
        return labels[key] || key;
      },

      orderedSelfCheckRows() {
        return ['zoteroDesktop', 'zoteroMcp', 'claudeCli', 'codexCli', 'geminiCli'];
      },

      clearSelfCheckAutoHideTimer() {
        if (this._selfCheckAutoHideTimer) {
          clearTimeout(this._selfCheckAutoHideTimer);
          this._selfCheckAutoHideTimer = null;
        }
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
          this.selfCheckError = e?.message || (this.aiLanguage === 'en' ? 'Self-check failed' : 'Self-check başarısız');
          this.selfCheckOpen = true;
          if (!forceOpen) {
            this.scheduleSelfCheckAutoHide(9000);
          }
        } finally {
          this.selfCheckLoading = false;
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
          if (typeof this.loadListDensityPreference === 'function') {
            this.loadListDensityPreference();
          }
          if (typeof this.runStartupSelfCheck === 'function') {
            await this.runStartupSelfCheck(false);
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

          this.theme = localStorage.getItem('zotero-theme') || 'dark';
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

          this.items = itemsR.data;
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
        const promises = [];
        for (let start = 100; start < total; start += 100) {
          promises.push(fetch(`${ns.API}/items?format=json&limit=100&start=${start}`).then((r) => r.json()));
        }
        for (const batch of await Promise.all(promises)) this.items = this.items.concat(batch);

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

      async fetchAllPages(baseUrl) {
        const firstRes = await fetch(`${baseUrl}&limit=100&start=0`);
        if (!firstRes.ok) throw new Error(`API ${firstRes.status}`);

        let rows = await firstRes.json();
        const total = parseInt(firstRes.headers.get('Total-Results') || `${rows.length}`, 10);
        if (total > 100) {
          const rest = [];
          for (let start = 100; start < total; start += 100) {
            rest.push(fetch(`${baseUrl}&limit=100&start=${start}`).then((r) => r.json()));
          }
          for (const batch of await Promise.all(rest)) rows = rows.concat(batch);
        }
        return rows;
      },

      async reloadVisibleItems() {
        this.items = await this.fetchAllPages(this.currentItemsBaseUrl());
        const currentKeys = new Set(this.items.map((i) => i.key));
        this.selectedCompareKeys = this.selectedCompareKeys.filter((k) => currentKeys.has(k));
        this.markPdfItems();
      },

      async search() {
        this.currentPage = 1;
        this.activeView = 'items';
        try {
          await this.reloadVisibleItems();
        } catch (e) {
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
          this.showToast(this.aiLanguage === 'en' ? 'Filters could not be reset' : 'Filtreler sıfırlanamadı');
        }
      },
    };
  });
})(window);

(function (window) {
  const ns = window.ZoteroDashboard;

  window.dashboard = function dashboard() {
    const state = {
      connected: false,
      connectionError: '',
      loading: true,
      userId: null,

      searchQuery: '',
      localFilterQuery: '',
      sortBy: 'dateAdded-desc',
      activeView: 'items',
      listDensity: 'comfortable',

      selectedCollection: null,
      selectedTag: null,
      selectedItem: null,
      selectedItemType: 'all',
      selectedCompareKeys: [],
      compareChatActive: false,
      compareChatKeys: [],
      detailTab: 'info',
      aiContextKeys: [],

      items: [],
      itemCacheByKey: {},
      _itemsVersion: 0,
      _displayItemsMemoKey: '',
      _displayItemsMemoRows: [],
      _visibleItemsAbortController: null,
      _visibleItemsRequestSeq: 0,
      collections: [],
      allTags: [],
      topTags: [],
      showAllTags: false,
      itemNotes: [],
      itemAnnotations: [],
      itemAttachments: [],
      detailAnnotationCache: {},

      currentPage: 1,
      perPage: 50,
      expandedCollections: [],

      toast: '',
      sidebarCollapsed: false,
      theme: 'dark',
      allItemsCount: 0,
      _keyboardBound: false,
      detailPanelWidth: 380,
      detailPanelMinWidth: 320,
      detailPanelMaxWidth: 760,
      _detailPanelResizeHandler: null,

      pdfUrl: null,
      pdfTitle: '',
      pdfPanelHeight: 45,
      pdfUseIframeFallback: false,
      pdfViewerReady: false,
      pdfViewerError: '',
      pdfViewerScale: 1.1,
      pdfPageCount: 0,
      pdfCurrentPage: 1,
      pdfPageNumbers: [],
      pdfRenderedPages: {},
      pdfSearchQuery: '',
      pdfSearchResults: [],
      pdfSearchActiveIndex: -1,
      pdfSearchBusy: false,
      pdfAnnotations: [],
      pdfAnnotationsUpdatedAt: 0,
      showPdfAnnotations: true,
      annotationCache: {},
      annotationUpdatedAtCache: {},
      activePdfItemKey: null,
      activePdfAttachmentKey: null,
      activePdfZoteroUrl: '',
      _pdfAnnotationRefreshTimer: null,
      _pdfLoadToken: 0,
      _pdfLoadingTask: null,
      _pdfDocument: null,
      _pdfRenderTasks: {},
      _pdfRenderJobs: {},
      _pdfRenderEpoch: 0,
      _pdfIntersectionObserver: null,
      _pdfScrollRaf: 0,
      _pdfSearchToken: 0,
      _pdfPageTextCache: {},

      chatMessages: [],
      chatInput: '',
      chatLoading: false,
      chatAbortController: null,
      activeChatTaskId: null,
      chatTaskQueue: [],
      _chatTaskSeq: 0,
      chatQueueOpen: true,
      chatError: '',
      chatCache: {},
      _chatCacheWarned: false,
      noteEditorContent: '',
      savingNoteToZotero: false,
      savingNoteToObsidian: false,
      noteEditorOpen: false,
      contextPanelOpen: false,
      metadataEditorOpen: false,
      metadataSaving: false,
      metadataUndoStack: [],
      metadataUndoLimit: 20,
      editAbstract: '',
      editTagInput: '',
      editTags: [],
      obsidianDirectory: '',
      obsidianActiveDirectory: '',
      obsidianConfigLoaded: false,
      obsidianConfigurable: true,
      aiProvider: 'claude',
      aiModel: '',
      aiAnalysisMode: 'balanced',
      pipelineTemplate: 'none',
      pipelineChunkLimit: 'auto',
      sourceRoutingMode: false,
      aiLanguage: 'tr',
      aiProviders: [
        { value: 'claude', label: 'Claude' },
        { value: 'codex', label: 'Codex' },
        { value: 'gemini', label: 'Gemini' },
      ],
      aiLanguages: [
        { value: 'tr', label: 'Türkçe' },
        { value: 'en', label: 'English' },
      ],
      providerHealth: {
        claude: { status: 'unknown', available: true, lastError: '', latencyMs: 0, lastCheckedAt: 0, cooldownSec: 0, cooldownReason: '' },
        codex: { status: 'unknown', available: true, lastError: '', latencyMs: 0, lastCheckedAt: 0, cooldownSec: 0, cooldownReason: '' },
        gemini: { status: 'unknown', available: true, lastError: '', latencyMs: 0, lastCheckedAt: 0, cooldownSec: 0, cooldownReason: '' },
      },
      providerHealthUpdatedAt: 0,
      _providerHealthTimer: null,
      selfCheckOpen: false,
      _selfCheckAutoHideTimer: null,
      _selfCheckPollTimer: null,
      selfCheckLoading: false,
      selfCheckRan: false,
      selfCheckLastRunAt: 0,
      selfCheckError: '',
      selfCheck: {
        zoteroDesktop: { status: 'unknown', detail: '', latencyMs: 0 },
        zoteroMcp: { status: 'unknown', detail: '' },
        claudeCli: { status: 'unknown', detail: '' },
        codexCli: { status: 'unknown', detail: '' },
        geminiCli: { status: 'unknown', detail: '' },
      },

      get totalItems() {
        return this.allItemsCount;
      },

      get localeCode() {
        return this.aiLanguage === 'en' ? 'en' : 'tr';
      },

      get itemTypeOptions() {
        const types = new Set();
        this.items.forEach((i) => {
          if (this.isPrimaryLibraryItem(i)) {
            types.add(i.data.itemType);
          }
        });
        return [...types].sort((a, b) =>
          this.formatItemType(a).localeCompare(this.formatItemType(b), this.localeCode)
        );
      },

      get displayItems() {
        const normalizedLocalFilter = this.normalizeText(this.localFilterQuery.trim());
        const cacheKey = [
          this._itemsVersion,
          this.selectedTag || '',
          this.selectedItemType || 'all',
          this.sortBy || 'dateAdded-desc',
          normalizedLocalFilter,
          this.localeCode,
        ].join('|');

        if (cacheKey === this._displayItemsMemoKey && Array.isArray(this._displayItemsMemoRows)) {
          return this._displayItemsMemoRows;
        }

        let result = this.items.filter((i) => this.isPrimaryLibraryItem(i));

        if (this.selectedTag) {
          result = result.filter((i) => (i.data.tags || []).some((t) => t.tag === this.selectedTag));
        }

        if (this.selectedItemType !== 'all') {
          result = result.filter((i) => i.data.itemType === this.selectedItemType);
        }

        if (normalizedLocalFilter) {
          result = result.filter((i) => {
            const data = i.data;
            const haystack = [
              data.title || '',
              this.formatAuthors(data.creators),
              data.publicationTitle || '',
              this.extractYear(data.date) || '',
              (data.tags || []).map((t) => t.tag).join(' '),
            ].join(' ');
            return this.normalizeText(haystack).includes(normalizedLocalFilter);
          });
        }

        const [field, dir] = this.sortBy.split('-');
        const multiplier = dir === 'asc' ? 1 : -1;

        result.sort((a, b) => {
          if (field === 'title') {
            return multiplier * (a.data.title || '').localeCompare(b.data.title || '', this.localeCode);
          }
          if (field === 'year') {
            return multiplier * ((this.extractYear(a.data.date) || '0') - (this.extractYear(b.data.date) || '0'));
          }
          if (field === 'author') {
            return (
              multiplier *
              this
                .formatAuthors(a.data.creators)
                .localeCompare(this.formatAuthors(b.data.creators), this.localeCode)
            );
          }
          return multiplier * (a.data.dateAdded || '').localeCompare(b.data.dateAdded || '');
        });

        this._displayItemsMemoKey = cacheKey;
        this._displayItemsMemoRows = result;
        return result;
      },

      get paginatedItems() {
        const start = (this.currentPage - 1) * this.pageSize;
        return this.displayItems.slice(start, start + this.pageSize);
      },

      get totalPages() {
        return Math.max(1, Math.ceil(this.displayItems.length / this.pageSize));
      },

      get pageSize() {
        return this.listDensity === 'compact' ? 72 : this.perPage;
      },

      get recentItems() {
        return [...this.items]
          .filter((i) => this.isPrimaryLibraryItem(i))
          .sort((a, b) => new Date(b.data.dateAdded) - new Date(a.data.dateAdded))
          .slice(0, 30);
      },

      get collectionTree() {
        const roots = this.collections.filter((c) => !c.data.parentCollection);
        return roots
          .map((root) => ({
            key: root.key,
            name: root.data.name,
            numItems: root.meta?.numItems || 0,
            children: this.collections
              .filter((c) => c.data.parentCollection === root.key)
              .map((c) => ({ key: c.key, name: c.data.name, numItems: c.meta?.numItems || 0 }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
      },

      get aiProviderLabel() {
        return this.aiProviders.find((p) => p.value === this.aiProvider)?.label || 'AI';
      },

      get aiLanguageLabel() {
        return this.aiLanguages.find((l) => l.value === this.aiLanguage)?.label || 'Türkçe';
      },

      get detailFields() {
        if (this.aiLanguage === 'en') {
          return [
            { key: 'date', label: 'Date' },
            { key: 'publicationTitle', label: 'Publication' },
            { key: 'volume', label: 'Volume' },
            { key: 'issue', label: 'Issue' },
            { key: 'pages', label: 'Pages' },
            { key: 'publisher', label: 'Publisher' },
            { key: 'language', label: 'Language' },
            { key: 'ISBN', label: 'ISBN' },
          ];
        }
        return [
          { key: 'date', label: 'Tarih' },
          { key: 'publicationTitle', label: 'Yayın' },
          { key: 'volume', label: 'Cilt' },
          { key: 'issue', label: 'Sayı' },
          { key: 'pages', label: 'Sayfalar' },
          { key: 'publisher', label: 'Yayıncı' },
          { key: 'language', label: 'Dil' },
          { key: 'ISBN', label: 'ISBN' },
        ];
      },

      applyUiLanguage() {
        const isEn = this.aiLanguage === 'en';
        document.documentElement.lang = isEn ? 'en' : 'tr';
        document.title = isEn
          ? "Orhon's Zotero Dashboard"
          : "Orhon'un Zotero Paneli";
      },

      toggleUiLanguage() {
        this.aiLanguage = this.aiLanguage === 'en' ? 'tr' : 'en';
        this.applyUiLanguage();
        if (typeof this.persistAiLanguage === 'function') {
          this.persistAiLanguage();
        }
      },

      listDensityStorageKey() {
        return 'zotero-list-density';
      },

      loadListDensityPreference() {
        const allowed = ['compact', 'comfortable'];
        try {
          const saved = localStorage.getItem(this.listDensityStorageKey());
          if (allowed.includes(saved)) {
            this.listDensity = saved;
          }
        } catch (e) {
          // no-op
        }
      },

      persistListDensityPreference() {
        try {
          localStorage.setItem(this.listDensityStorageKey(), this.listDensity);
        } catch (e) {
          // no-op
        }
      },

      setListDensity(nextDensity) {
        const allowed = ['compact', 'comfortable'];
        if (!allowed.includes(nextDensity)) return;
        if (this.listDensity === nextDensity) return;
        this.listDensity = nextDensity;
        this.currentPage = 1;
        this.persistListDensityPreference();
      },

      detailPanelWidthStorageKey() {
        return 'zotero-detail-panel-width';
      },

      dynamicDetailPanelMaxWidth() {
        const min = Number(this.detailPanelMinWidth || 320);
        const configuredMax = Number(this.detailPanelMaxWidth || 760);
        const viewportCap = Math.max(min + 40, window.innerWidth - 280);
        return Math.max(min, Math.min(configuredMax, viewportCap));
      },

      clampDetailPanelWidth(nextWidth) {
        const min = Number(this.detailPanelMinWidth || 320);
        const max = this.dynamicDetailPanelMaxWidth();
        const value = Number.isFinite(Number(nextWidth)) ? Math.round(Number(nextWidth)) : min;
        return Math.max(min, Math.min(max, value));
      },

      syncDetailPanelWidthToViewport(persist = false) {
        const clamped = this.clampDetailPanelWidth(this.detailPanelWidth);
        if (clamped === this.detailPanelWidth) return;
        this.detailPanelWidth = clamped;
        if (persist) {
          this.persistDetailPanelWidthPreference();
        }
      },

      bindDetailPanelViewportSync() {
        if (this._detailPanelResizeHandler) return;
        this._detailPanelResizeHandler = () => {
          this.syncDetailPanelWidthToViewport(true);
        };
        window.addEventListener('resize', this._detailPanelResizeHandler, { passive: true });
      },

      loadDetailPanelWidthPreference() {
        try {
          const raw = localStorage.getItem(this.detailPanelWidthStorageKey());
          if (raw !== null) {
            this.detailPanelWidth = this.clampDetailPanelWidth(parseInt(raw, 10));
            this.syncDetailPanelWidthToViewport(false);
            return;
          }
        } catch (e) {
          // no-op
        }
        this.detailPanelWidth = this.clampDetailPanelWidth(this.detailPanelWidth);
        this.syncDetailPanelWidthToViewport(false);
      },

      persistDetailPanelWidthPreference() {
        try {
          localStorage.setItem(this.detailPanelWidthStorageKey(), String(this.clampDetailPanelWidth(this.detailPanelWidth)));
        } catch (e) {
          // no-op
        }
      },

      startDetailPanelResize(e) {
        if ((e?.button ?? 0) !== 0) return;
        if (e?.preventDefault) e.preventDefault();

        const startX = e.clientX;
        const startWidth = this.detailPanelWidth;
        document.body.classList.add('detail-resizing');

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
          const delta = startX - ev.clientX;
          this.detailPanelWidth = this.clampDetailPanelWidth(startWidth + delta);
        };

        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          window.removeEventListener('blur', onWindowBlur);
          document.removeEventListener('visibilitychange', onVisibilityChange);
          document.body.classList.remove('detail-resizing');
          this.persistDetailPanelWidthPreference();
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        window.addEventListener('blur', onWindowBlur);
        document.addEventListener('visibilitychange', onVisibilityChange);
      },
    };

    ns.mixins.forEach((mixinFactory) => {
      Object.assign(state, mixinFactory(state) || {});
    });

    return state;
  };
})(window);

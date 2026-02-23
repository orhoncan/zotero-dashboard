(function (window) {
  const ns = window.ZoteroDashboard;

  ns.registerMixin(function registerChat() {
    return {
      chatCacheStorageKey() {
        return 'zotero-chat-cache-v2';
      },

      chatCacheLimits() {
        return {
          maxEntries: 120,
          ttlMs: 1000 * 60 * 60 * 24 * 30,
        };
      },

      nowMs() {
        return Date.now();
      },

      normalizeCacheEntry(entry) {
        const raw = entry && typeof entry === 'object' ? entry : {};
        const messages = Array.isArray(raw.messages) ? raw.messages : [];
        const error = typeof raw.error === 'string' ? raw.error : '';
        const editor = typeof raw.editor === 'string' ? raw.editor : '';
        const contextKeys = Array.isArray(raw.contextKeys) ? raw.contextKeys : [];
        const savedAt = Number(raw.savedAt || raw.updatedAt || raw.createdAt || 0);
        const lastAccessedAt = Number(raw.lastAccessedAt || savedAt || 0);
        return {
          messages,
          error,
          editor,
          contextKeys,
          savedAt: Number.isFinite(savedAt) ? savedAt : 0,
          lastAccessedAt: Number.isFinite(lastAccessedAt) ? lastAccessedAt : 0,
        };
      },

      pruneChatCache(options = {}) {
        const limits = this.chatCacheLimits();
        const ttlMs = Math.max(60 * 1000, Number(limits.ttlMs || 0));
        const maxEntries = Math.max(8, Number(limits.maxEntries || 0));
        const now = this.nowMs();
        const next = {};
        const rows = [];

        Object.entries(this.chatCache || {}).forEach(([key, value]) => {
          const normalized = this.normalizeCacheEntry(value);
          const lastSeen = Number(normalized.lastAccessedAt || normalized.savedAt || 0);
          if (lastSeen > 0 && now - lastSeen > ttlMs) return;
          rows.push({ key, value: normalized, lastSeen });
        });

        rows.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
        rows.slice(0, maxEntries).forEach((row) => {
          next[row.key] = row.value;
        });

        const changed = Object.keys(next).length !== Object.keys(this.chatCache || {}).length;
        this.chatCache = next;
        if (!options.skipPersist && changed) {
          this.persistChatCacheToStorage({ skipPrune: true, silent: true });
        }
        return changed;
      },

      normalizeAiProvider(provider) {
        return ['claude', 'codex', 'gemini'].includes(provider) ? provider : 'claude';
      },

      normalizeAiModel(model) {
        const normalized = String(model || '').trim();
        return normalized || '__default__';
      },

      normalizeAiAnalysisMode(mode) {
        return ['fast', 'balanced', 'deep'].includes(mode) ? mode : 'balanced';
      },

      chatScopeKey(itemKey = this.selectedItem?.key || '__global__', provider = this.aiProvider, model = this.aiModel, mode = this.aiAnalysisMode) {
        const safeItemKey = String(itemKey || '__global__');
        const safeProvider = this.normalizeAiProvider(provider);
        const safeModel = this.normalizeAiModel(model);
        const safeMode = this.normalizeAiAnalysisMode(mode);
        return `${safeItemKey}::${safeProvider}::${safeModel}::${safeMode}`;
      },

      currentChatScopeKey() {
        return this.chatScopeKey(this.selectedItem?.key || '__global__', this.aiProvider, this.aiModel, this.aiAnalysisMode);
      },

      clearChatScopesForItem(itemKey = this.selectedItem?.key || '__global__') {
        const safeItemKey = String(itemKey || '__global__');
        if (!this.chatCache || typeof this.chatCache !== 'object') return;
        Object.keys(this.chatCache).forEach((key) => {
          if (key === safeItemKey || key.startsWith(`${safeItemKey}::`)) {
            delete this.chatCache[key];
          }
        });
      },

      applyChatStateFromCache(cacheKey) {
        const requestedKey = String(cacheKey || this.currentChatScopeKey());
        const normalizedKey = requestedKey.includes('::')
          ? requestedKey
          : this.chatScopeKey(requestedKey, this.aiProvider, this.aiModel, this.aiAnalysisMode);
        const itemFallbackKey = requestedKey.includes('::') ? requestedKey.split('::')[0] : requestedKey;
        const hitKey = this.chatCache?.[normalizedKey] ? normalizedKey : (this.chatCache?.[itemFallbackKey] ? itemFallbackKey : '');
        const cachedRaw = hitKey ? this.chatCache?.[hitKey] : null;
        const cached = this.normalizeCacheEntry(cachedRaw || {});

        this.chatMessages = cached.messages ? [...cached.messages] : [];
        this.chatError = cached.error || '';
        this.noteEditorContent = cached.editor || '';
        this.aiContextKeys = Array.isArray(cached.contextKeys) ? [...cached.contextKeys] : [];
        this.sanitizeAiContextKeys();

        if (hitKey) {
          this.chatCache[hitKey] = {
            ...cached,
            lastAccessedAt: this.nowMs(),
            savedAt: cached.savedAt || this.nowMs(),
          };
          this.persistChatCacheToStorage({ skipPrune: false, silent: true });
        }
      },

      loadPersistedChatCache() {
        try {
          const raw = localStorage.getItem(this.chatCacheStorageKey());
          if (!raw) return;
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
          this.chatCache = parsed;
          this.pruneChatCache({ skipPersist: true });
          if (!this.selectedItem) {
            this.applyChatStateFromCache(this.chatScopeKey('__global__', this.aiProvider, this.aiModel, this.aiAnalysisMode));
          }
        } catch (e) {
          // no-op
        }
      },

      persistChatCacheToStorage(options = {}) {
        if (!options.skipPrune) {
          this.pruneChatCache({ skipPersist: true });
        }
        try {
          localStorage.setItem(this.chatCacheStorageKey(), JSON.stringify(this.chatCache || {}));
        } catch (e) {
          const isQuotaError = e?.name === 'QuotaExceededError' || e?.code === 22;
          if (!isQuotaError) return;
          this.pruneChatCache({ skipPersist: true });
          try {
            localStorage.setItem(this.chatCacheStorageKey(), JSON.stringify(this.chatCache || {}));
          } catch (retryErr) {
            if (!options.silent && !this._chatCacheWarned) {
              this._chatCacheWarned = true;
              this.showToast(
                this.aiLanguage === 'en'
                  ? 'Chat cache is full, older history was trimmed'
                  : 'Sohbet önbelleği dolu, eski geçmiş kırpıldı'
              );
            }
          }
        }
      },

      persistAiProvider() {
        try {
          localStorage.setItem('zotero-ai-provider', this.aiProvider);
        } catch (e) {
          // no-op
        }
      },

      modelStorageKey(provider) {
        return `zotero-ai-model-${provider}`;
      },

      defaultModelForProvider(provider) {
        const defaults = {
          claude: 'sonnet',
          codex: 'gpt-5-codex',
          gemini: 'gemini-2.5-flash',
        };
        return defaults[provider] || '';
      },

      modelOptions(provider = this.aiProvider) {
        const labels = this.aiLanguage === 'en'
          ? {
              provider: 'Provider',
              modelDefault: 'CLI default',
              recommended: 'recommended',
            }
          : {
              provider: 'Sağlayıcı',
              modelDefault: 'CLI varsayılanı',
              recommended: 'önerilen',
            };

        const withRecommended = (label) => `${label} (${labels.recommended})`;

        const optionsByProvider = {
          claude: [
            { value: 'sonnet', label: withRecommended('Sonnet') },
            { value: 'opus', label: 'Opus' },
            { value: '', label: labels.modelDefault },
          ],
          codex: [
            { value: 'gpt-5-codex', label: withRecommended('gpt-5-codex') },
            { value: 'gpt-5.3-codex', label: 'gpt-5.3-codex' },
            { value: 'gpt-5', label: 'gpt-5' },
            { value: '', label: labels.modelDefault },
          ],
          gemini: [
            { value: 'gemini-2.5-flash', label: withRecommended('gemini-2.5-flash') },
            { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
            { value: 'auto', label: 'auto' },
            { value: '', label: labels.modelDefault },
          ],
        };
        return optionsByProvider[provider] || [];
      },

      loadAiModelPreference(provider = this.aiProvider) {
        const safeProvider = ['claude', 'codex', 'gemini'].includes(provider) ? provider : 'claude';
        const defaultModel = this.defaultModelForProvider(safeProvider);
        let chosen = defaultModel;
        try {
          const saved = localStorage.getItem(this.modelStorageKey(safeProvider));
          if (saved !== null) {
            chosen = saved;
          }
        } catch (e) {
          // no-op
        }
        this.aiModel = chosen;
      },

      persistAiModel() {
        const provider = ['claude', 'codex', 'gemini'].includes(this.aiProvider) ? this.aiProvider : 'claude';
        try {
          localStorage.setItem(this.modelStorageKey(provider), this.aiModel || '');
        } catch (e) {
          // no-op
        }
      },

      analysisModeStorageKey() {
        return 'zotero-ai-analysis-mode';
      },

      pipelineTemplateStorageKey() {
        return 'zotero-pipeline-template';
      },

      pipelineChunkLimitStorageKey() {
        return 'zotero-pipeline-chunk-limit';
      },

      pipelineTemplateOptions() {
        if (this.aiLanguage === 'en') {
          return [
            { value: 'study', label: 'Study Note' },
            { value: 'presentation', label: 'Presentation' },
            { value: 'review', label: 'Peer Review' },
            { value: 'thesis_notes', label: 'Research Notes' },
            { value: 'policy_brief', label: 'Policy Brief' },
          ];
        }
        return [
          { value: 'study', label: 'Çalışma Notu' },
          { value: 'presentation', label: 'Sunum' },
          { value: 'review', label: 'Hakem Değerlendirmesi' },
          { value: 'thesis_notes', label: 'Araştırma Notu' },
          { value: 'policy_brief', label: 'Politika Özeti' },
        ];
      },

      pipelineChunkLimitOptions() {
        return [
          { value: 'auto', label: this.aiLanguage === 'en' ? 'Auto' : 'Otomatik' },
          { value: '4', label: '4' },
          { value: '8', label: '8' },
          { value: '12', label: '12' },
          { value: '16', label: '16' },
        ];
      },

      normalizePipelineTemplate(value) {
        const allowed = new Set(['study', 'presentation', 'review', 'thesis_notes', 'policy_brief']);
        const normalized = String(value || '').trim();
        return allowed.has(normalized) ? normalized : 'study';
      },

      normalizePipelineChunkLimit(value) {
        const normalized = String(value || '').trim().toLowerCase();
        if (!normalized || normalized === 'auto') return 'auto';
        const parsed = parseInt(normalized, 10);
        if (!Number.isFinite(parsed)) return 'auto';
        if (![4, 8, 12, 16].includes(parsed)) return 'auto';
        return String(parsed);
      },

      loadPipelineTemplatePreference() {
        try {
          const saved = localStorage.getItem(this.pipelineTemplateStorageKey());
          this.pipelineTemplate = this.normalizePipelineTemplate(saved || this.pipelineTemplate);
        } catch (e) {
          this.pipelineTemplate = this.normalizePipelineTemplate(this.pipelineTemplate);
        }
      },

      persistPipelineTemplatePreference() {
        this.pipelineTemplate = this.normalizePipelineTemplate(this.pipelineTemplate);
        try {
          localStorage.setItem(this.pipelineTemplateStorageKey(), this.pipelineTemplate);
        } catch (e) {
          // no-op
        }
      },

      onPipelineTemplateChange() {
        this.persistPipelineTemplatePreference();
      },

      loadPipelineChunkLimitPreference() {
        this.pipelineChunkLimit = 'auto';
        try {
          localStorage.removeItem(this.pipelineChunkLimitStorageKey());
        } catch (e) {
          // no-op
        }
      },

      persistPipelineChunkLimitPreference() {
        this.pipelineChunkLimit = 'auto';
        try {
          localStorage.removeItem(this.pipelineChunkLimitStorageKey());
        } catch (e) {
          // no-op
        }
      },

      onPipelineChunkLimitChange() {
        this.persistPipelineChunkLimitPreference();
      },

      analysisModeOptions() {
        const labels = this.aiLanguage === 'en'
          ? {
              fast: 'Fast',
              balanced: 'Balanced',
              deep: 'Deep',
              recommended: 'recommended',
            }
          : {
              fast: 'Hızlı',
              balanced: 'Dengeli',
              deep: 'Derin',
              recommended: 'önerilen',
            };

        return [
          { value: 'fast', label: labels.fast },
          { value: 'balanced', label: `${labels.balanced} (${labels.recommended})` },
          { value: 'deep', label: labels.deep },
        ];
      },

      loadAiAnalysisModePreference() {
        const allowed = ['fast', 'balanced', 'deep'];
        let selected = 'balanced';
        try {
          const saved = localStorage.getItem(this.analysisModeStorageKey());
          if (allowed.includes(saved)) {
            selected = saved;
          }
        } catch (e) {
          // no-op
        }
        this.aiAnalysisMode = selected;
      },

      persistAiAnalysisMode() {
        const allowed = ['fast', 'balanced', 'deep'];
        if (!allowed.includes(this.aiAnalysisMode)) {
          this.aiAnalysisMode = 'balanced';
        }
        try {
          localStorage.setItem(this.analysisModeStorageKey(), this.aiAnalysisMode);
        } catch (e) {
          // no-op
        }
      },

      analysisModeContextConfig(mode = this.aiAnalysisMode) {
        if (mode === 'fast') {
          return { abstractMax: 380, noteCount: 1, noteMax: 120, abstractSentences: 2, noteSentences: 1 };
        }
        if (mode === 'deep') {
          return { abstractMax: 2500, noteCount: 6, noteMax: 760, abstractSentences: 10, noteSentences: 5 };
        }
        return { abstractMax: 1200, noteCount: 3, noteMax: 320, abstractSentences: 6, noteSentences: 3 };
      },

      truncateContextText(value, maxLen) {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        if (!text || !maxLen || text.length <= maxLen) return text;
        return `${text.slice(0, Math.max(0, maxLen - 3)).trim()}...`;
      },

      splitSentencesForCompaction(value) {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        if (!text) return [];
        return text
          .split(/(?<=[.!?])\s+|(?<=[。！？])\s+/)
          .map((s) => s.trim())
          .filter(Boolean);
      },

      compactContextText(value, maxLen, maxSentences = 6) {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        if (!text) return '';
        if (!maxLen || text.length <= maxLen) return text;

        const sentences = this.splitSentencesForCompaction(text);
        if (!sentences.length) {
          return this.truncateContextText(text, maxLen);
        }

        const keywordPattern = this.aiLanguage === 'en'
          ? /\b(method|data|result|finding|conclusion|limitation|evidence|sample|model|effect|impact|policy)\b/gi
          : /\b(yöntem|veri|bulgu|sonuç|sınırlılık|kanıt|örneklem|model|etki|politika)\b/gi;

        const scored = sentences.map((sentence, index) => {
          const keywordHits = (sentence.match(keywordPattern) || []).length;
          const hasNumber = /\d/.test(sentence) ? 1 : 0;
          const lenScore = sentence.length >= 45 && sentence.length <= 260 ? 1 : 0;
          const leadBoost = index === 0 ? 2 : 0;
          const score = leadBoost + (keywordHits * 2) + hasNumber + lenScore;
          return { sentence, index, score };
        });

        const sentenceCap = Math.max(2, Number(maxSentences) || 6);
        const picked = scored
          .sort((a, b) => b.score - a.score || a.index - b.index)
          .slice(0, sentenceCap)
          .sort((a, b) => a.index - b.index);

        let compacted = '';
        for (const row of picked) {
          const next = compacted ? `${compacted} ${row.sentence}` : row.sentence;
          if (next.length > maxLen) break;
          compacted = next;
        }

        if (!compacted) {
          compacted = this.truncateContextText(text, maxLen);
        } else if (compacted.length < text.length) {
          compacted = `${compacted}${compacted.endsWith('...') ? '' : ' ...'}`;
        }

        return compacted;
      },

      analysisModeDirective(supportsMcp = false) {
        if (this.aiLanguage === 'en') {
          if (this.aiAnalysisMode === 'fast') {
            return supportsMcp
              ? 'Speed mode: FAST. Prioritize metadata/abstract/notes. Avoid full-text retrieval unless absolutely necessary. Keep the answer concise (max ~120 words or up to 6 bullets).'
              : 'Speed mode: FAST. Use only the provided context and keep the answer concise (max ~120 words or up to 6 bullets).';
          }
          if (this.aiAnalysisMode === 'deep') {
            return supportsMcp
              ? 'Depth mode: DEEP. Use available tools thoroughly (including full text if relevant) and provide a structured, detailed analysis (up to ~450 words).'
              : 'Depth mode: DEEP. Use the provided context for a structured and detailed analysis (up to ~450 words).';
          }
          return supportsMcp
            ? 'Mode: BALANCED. Use tools when needed and provide a practical medium-length answer (around 180-260 words).'
            : 'Mode: BALANCED. Use the provided context and provide a practical medium-length answer (around 180-260 words).';
        }

        if (this.aiAnalysisMode === 'fast') {
          return supportsMcp
            ? 'Hız modu: HIZLI. Önce metadata/özet/notları kullan. Zorunlu olmadıkça tam metin çağırma. Yanıt kısa olsun (yaklaşık en fazla 120 kelime veya 6 madde).'
            : 'Hız modu: HIZLI. Yalnızca verilen bağlamı kullan ve yanıtı kısa tut (yaklaşık en fazla 120 kelime veya 6 madde).';
        }
        if (this.aiAnalysisMode === 'deep') {
          return supportsMcp
            ? 'Derinlik modu: DERİN. Uygun araçları kapsamlı kullan (gerekliyse tam metin dahil) ve yapılandırılmış, detaylı analiz üret (yaklaşık en fazla 450 kelime).'
            : 'Derinlik modu: DERİN. Verilen bağlamla yapılandırılmış ve detaylı analiz üret (yaklaşık en fazla 450 kelime).';
        }
        return supportsMcp
          ? 'Mod: DENGELİ. Araçları gerektiğinde kullan ve orta uzunlukta, pratik bir yanıt ver (yaklaşık 180-260 kelime).'
          : 'Mod: DENGELİ. Verilen bağlamı kullan ve orta uzunlukta, pratik bir yanıt ver (yaklaşık 180-260 kelime).';
      },

      languagePurityDirective() {
        if (this.aiLanguage === 'en') {
          return 'Language rule: Write ONLY in English with proper English grammar, punctuation, and wording. Do not use Turkish words, except unavoidable proper nouns from the source text. Do not include process narration such as "I now have enough content" or "I will now produce the output".';
        }
        return 'Dil kuralı: YANITI TAMAMEN Türkçe yaz. Türkçe dilbilgisi, noktalama ve anlatım kurallarına uy. Kaynak metindeki zorunlu özel adlar dışında yabancı kelime kullanma. "Yeterli içerik elde ettim" veya "Çıktıyı şimdi üretiyorum" gibi süreç cümleleri yazma.';
      },

      sourceGroundingDirective(supportsMcp = false) {
        if (this.aiLanguage === 'en') {
          if (supportsMcp) {
            return 'Grounding rule: Use ONLY the provided Zotero context and the text returned by Zotero MCP tools in this turn. Do not use outside knowledge. If information is missing in the available text, explicitly say it is missing.';
          }
          return 'Grounding rule: Use ONLY the provided Zotero context in this prompt. Do not add outside knowledge. If information is missing in the context, explicitly say it is missing.';
        }
        if (supportsMcp) {
          return 'Kaynak kuralı: SADECE bu turda verilen Zotero bağlamı ve Zotero MCP araçlarından dönen metni kullan. Dış bilgi ekleme. Bilgi yoksa açıkça bilgi eksik olduğunu belirt.';
        }
        return 'Kaynak kuralı: SADECE bu promptta verilen Zotero bağlamını kullan. Dış bilgi ekleme. Bağlamda bilgi yoksa açıkça bilgi eksik olduğunu belirt.';
      },

      outputConstraintDirective(supportsMcp = false) {
        const mode = this.analysisModeDirective(supportsMcp);
        const language = this.languagePurityDirective();
        const grounding = this.sourceGroundingDirective(supportsMcp);
        if (this.aiLanguage === 'en') {
          return `MANDATORY OUTPUT RULES:\n- ${mode}\n- ${language}\n- ${grounding}`;
        }
        return `ZORUNLU CIKTI KURALLARI:\n- ${mode}\n- ${language}\n- ${grounding}`;
      },

      applyAnalysisModeToPrompt(prompt, supportsMcp = false) {
        if (!prompt) return '';
        const outputDirective = this.outputConstraintDirective(supportsMcp);
        if (!outputDirective) return prompt;
        const alreadyTagged =
          prompt.includes('MANDATORY OUTPUT RULES:') || prompt.includes('ZORUNLU CIKTI KURALLARI:');
        if (alreadyTagged) return prompt;
        const contextToken = this.aiLanguage === 'en' ? '\n\nZotero context:\n' : '\n\nZotero bağlamı:\n';
        const index = prompt.indexOf(contextToken);
        if (index < 0) {
          return `${prompt}\n\n${outputDirective}`;
        }
        return `${prompt.slice(0, index)}\n\n${outputDirective}${prompt.slice(index)}`;
      },

      onAiProviderChange() {
        this.aiProvider = this.normalizeAiProvider(this.aiProvider);
        this.persistAiProvider();
        this.loadAiModelPreference(this.aiProvider);
        this.applyChatStateFromCache(this.currentChatScopeKey());
        if (typeof this.refreshProviderHealth === 'function') {
          this.refreshProviderHealth();
        }
      },

      onAiModelChange() {
        this.persistAiModel();
        this.applyChatStateFromCache(this.currentChatScopeKey());
      },

      onAiAnalysisModeChange() {
        this.persistAiAnalysisMode();
        this.applyChatStateFromCache(this.currentChatScopeKey());
      },

      providerSupportsMcp(provider = this.aiProvider) {
        return provider === 'claude' || provider === 'codex' || provider === 'gemini';
      },

      fallbackChainFor(provider = this.aiProvider) {
        const preferred = ['codex', 'gemini', 'claude'];
        const current = preferred.includes(provider) ? provider : 'claude';
        return [current, ...preferred.filter((p) => p !== current)];
      },

      providerHealthFallbackFromSelfCheck(provider = this.aiProvider) {
        const rowByProvider = {
          claude: 'claudeCli',
          codex: 'codexCli',
          gemini: 'geminiCli',
        };
        const row = this.selfCheck?.[rowByProvider[provider]];
        if (!row || typeof row !== 'object') return null;
        const status = String(row.status || '').trim().toLowerCase();
        if (!status || status === 'unknown') return null;
        if (!['ok', 'degraded', 'down', 'cooldown'].includes(status)) return null;
        return {
          status,
          available: status !== 'down',
          lastError: status === 'ok' ? '' : (row.detail || ''),
          lastCheckedAt: Math.floor(Date.now() / 1000),
        };
      },

      providerHealthFor(provider = this.aiProvider) {
        const base = this.providerHealth?.[provider] || {
          status: 'unknown',
          available: true,
          latencyMs: 0,
          lastError: '',
          lastCheckedAt: 0,
          cooldownSec: 0,
          cooldownReason: '',
        };
        const normalized = String(base.status || 'unknown').trim().toLowerCase();
        if (normalized !== 'unknown') return base;
        const fallback = this.providerHealthFallbackFromSelfCheck(provider);
        if (!fallback) return base;
        return {
          ...base,
          ...fallback,
        };
      },

      providerHealthStatusLabel(provider = this.aiProvider) {
        const health = this.providerHealthFor(provider);
        const status = health.status || 'unknown';
        if (this.aiLanguage === 'en') {
          if (status === 'ok') return 'Healthy';
          if (status === 'degraded') return 'Degraded';
          if (status === 'cooldown') return 'Cooldown';
          if (status === 'down') return 'Down';
          return 'Unknown';
        }
        if (status === 'ok') return 'Sağlıklı';
        if (status === 'degraded') return 'Sorunlu';
        if (status === 'cooldown') return 'Beklemede';
        if (status === 'down') return 'Kapalı';
        return 'Bilinmiyor';
      },

      providerHealthStatusClass(provider = this.aiProvider) {
        const status = this.providerHealthFor(provider).status || 'unknown';
        if (status === 'ok') return 'text-emerald-300';
        if (status === 'degraded') return 'text-amber-300';
        if (status === 'cooldown') return 'text-orange-300';
        if (status === 'down') return 'text-red-300';
        return 'text-slate-400';
      },

      fallbackChainLabel(provider = this.aiProvider) {
        const chain = this.fallbackChainFor(provider).map((p) => {
          if (p === 'claude') return 'Claude';
          if (p === 'codex') return 'Codex';
          if (p === 'gemini') return 'Gemini';
          return p;
        });
        return chain.join(' -> ');
      },

      applyProviderHealthPayload(payload) {
        if (!payload || typeof payload !== 'object') return;
        const providers = payload.providers && typeof payload.providers === 'object'
          ? payload.providers
          : payload;
        let changed = false;
        ['claude', 'codex', 'gemini'].forEach((provider) => {
          const incoming = providers?.[provider];
          if (!incoming || typeof incoming !== 'object') return;
          const current = this.providerHealth?.[provider] || {};
          const next = {
            ...current,
            ...incoming,
          };
          const hasChange = [
            'status',
            'available',
            'latencyMs',
            'lastError',
            'lastCheckedAt',
            'lastSuccessAt',
            'cooldownSec',
            'cooldownReason',
          ].some((key) => String(current?.[key] ?? '') !== String(next?.[key] ?? ''));
          if (!hasChange) return;
          this.providerHealth[provider] = next;
          changed = true;
        });
        if (changed) {
          this.providerHealthUpdatedAt = Date.now();
        }
      },

      async refreshProviderHealth() {
        try {
          const res = await fetch('/ai-health');
          const data = await this.parseJsonResponse(res, '/ai-health');
          this.applyProviderHealthPayload(data?.providers ? data : (data || {}));
        } catch (e) {
          // no-op: keep last known health
        }
      },

      startProviderHealthPolling() {
        if (this._providerHealthTimer) return;
        const run = () => {
          if (document.hidden) return;
          if (this.detailTab !== 'chat') return;
          if (!this.selectedItem) return;
          this.refreshProviderHealth();
        };
        this._providerHealthTimer = window.setInterval(() => {
          run();
        }, 30000);
      },

      markCompareChat(keys) {
        this.compareChatActive = true;
        this.compareChatKeys = Array.isArray(keys) ? [...keys] : [];
      },

      clearCompareChatMode() {
        this.compareChatActive = false;
        this.compareChatKeys = [];
      },

      clearChatMessages() {
        if (this.chatLoading) return;
        const itemKey = this.selectedItem?.key || '__global__';
        this.clearChatScopesForItem(itemKey);
        this.chatMessages = [];
        this.chatError = '';
        this.noteEditorContent = '';
        this.clearCompareChatMode();
        this.persistChatForCurrentItem();
        this.showToast(this.aiLanguage === 'en' ? 'Chat cleared' : 'Sohbet temizlendi');
      },

      aiContextSelectionLimit() {
        return 8;
      },

      sanitizeAiContextKeys() {
        const selectedKey = String(this.selectedItem?.key || '');
        const existing = Array.isArray(this.aiContextKeys) ? this.aiContextKeys : [];
        const seen = new Set();
        const next = [];
        existing.forEach((key) => {
          const normalized = String(key || '').trim();
          if (!normalized || normalized === selectedKey || seen.has(normalized)) return;
          const item = typeof this.findItemByKey === 'function'
            ? this.findItemByKey(normalized)
            : this.items.find((row) => row.key === normalized);
          if (!item || !this.isPrimaryLibraryItem(item)) return;
          seen.add(normalized);
          next.push(normalized);
        });
        this.aiContextKeys = next.slice(0, this.aiContextSelectionLimit());
      },

      aiContextIncludes(itemKey) {
        const key = String(itemKey || '').trim();
        if (!key) return false;
        return Array.isArray(this.aiContextKeys) && this.aiContextKeys.includes(key);
      },

      aiContextSelectedItems() {
        const selected = [];
        const seen = new Set();
        const push = (item, force = false) => {
          if (!item?.key || seen.has(item.key)) return;
          if (!force && !this.isPrimaryLibraryItem(item)) return;
          selected.push(item);
          seen.add(item.key);
        };

        if (this.selectedItem) {
          // Always keep active item in context, even if type metadata is imperfect.
          push(this.selectedItem, true);
        }
        (this.selectedCompareKeys || []).forEach((key) => {
          const item = typeof this.findItemByKey === 'function'
            ? this.findItemByKey(key)
            : this.items.find((row) => row.key === key);
          if (item) push(item);
        });
        (this.aiContextKeys || []).forEach((key) => {
          const item = typeof this.findItemByKey === 'function'
            ? this.findItemByKey(key)
            : this.items.find((row) => row.key === key);
          if (item) push(item);
        });
        return selected;
      },

      aiContextCandidateItems(limit = 12) {
        const maxOthers = Math.max(4, Number(limit || 12));
        const byKey = new Map();
        const push = (item) => {
          if (!item?.key || byKey.has(item.key)) return;
          if (!this.isPrimaryLibraryItem(item)) return;
          byKey.set(item.key, item);
        };

        if (this.selectedItem) push(this.selectedItem);
        (this.aiContextKeys || []).forEach((key) => {
          const item = typeof this.findItemByKey === 'function'
            ? this.findItemByKey(key)
            : this.items.find((row) => row.key === key);
          if (item) push(item);
        });
        (this.selectedCompareKeys || []).forEach((key) => {
          const item = typeof this.findItemByKey === 'function'
            ? this.findItemByKey(key)
            : this.items.find((row) => row.key === key);
          if (item) push(item);
        });
        (this.paginatedItems || []).forEach((item) => push(item));
        if (byKey.size < maxOthers + 1) {
          (this.recentItems || []).forEach((item) => push(item));
        }

        const selectedKey = this.selectedItem?.key || '';
        const all = Array.from(byKey.values());
        const primary = selectedKey ? all.find((item) => item.key === selectedKey) : null;
        const others = all.filter((item) => item.key !== selectedKey);
        return primary ? [primary, ...others.slice(0, maxOthers)] : others.slice(0, maxOthers + 1);
      },

      toggleAiContextItem(itemKey, checked) {
        const key = String(itemKey || '').trim();
        if (!key || key === String(this.selectedItem?.key || '')) return;
        this.sanitizeAiContextKeys();
        const exists = this.aiContextIncludes(key);

        if (checked && !exists) {
          if (this.aiContextKeys.length >= this.aiContextSelectionLimit()) {
            this.showToast(
              this.aiLanguage === 'en'
                ? `You can add up to ${this.aiContextSelectionLimit()} extra papers`
                : `En fazla ${this.aiContextSelectionLimit()} ek makale ekleyebilirsiniz`
            );
            return;
          }
          this.aiContextKeys = [...this.aiContextKeys, key];
          this.persistChatForCurrentItem();
          return;
        }

        if (!checked && exists) {
          this.aiContextKeys = this.aiContextKeys.filter((k) => k !== key);
          this.persistChatForCurrentItem();
        }
      },

      clearAiContextSelection() {
        const hasManual = Array.isArray(this.aiContextKeys) && this.aiContextKeys.length > 0;
        const hasCompare = Array.isArray(this.selectedCompareKeys) && this.selectedCompareKeys.length > 0;
        if (!hasManual && !hasCompare) return;
        this.aiContextKeys = [];
        if (hasCompare && typeof this.clearCompareSelection === 'function') {
          this.clearCompareSelection();
        }
        this.persistChatForCurrentItem();
      },

      zoteroItemApiBase(item = this.selectedItem) {
        const libraryType = String(item?.library?.type || '').trim().toLowerCase();
        const rawLibraryId = item?.library?.id ?? item?.data?.libraryID ?? this.userId;
        const libraryId = Number(rawLibraryId);
        if (libraryType === 'group' && Number.isFinite(libraryId) && libraryId > 0) {
          return `/api/groups/${libraryId}`;
        }
        if (Number.isFinite(libraryId) && libraryId >= 0) {
          return `/api/users/${libraryId}`;
        }
        if (typeof ns.API === 'string' && /^\/api\/(users|groups)\/\d+$/.test(ns.API)) {
          return ns.API;
        }
        return '/api/users/0';
      },

      persistAiLanguage() {
        try {
          localStorage.setItem('zotero-ui-language', this.aiLanguage);
          localStorage.setItem('zotero-ai-language', this.aiLanguage);
        } catch (e) {
          // no-op
        }
      },

      quickPromptLabels() {
        if (this.aiLanguage === 'en') {
          return {
            summarize: 'Summarize',
            notes: 'Analyze Notes',
            related: 'Related Works',
            critique: 'Critical Review',
          };
        }
        return {
          summarize: 'Özetle',
          notes: 'Notları Analiz Et',
          related: 'İlgili Çalışmalar',
          critique: 'Eleştirel Değerlendirme',
        };
      },

      quickPromptButtonLabel(type) {
        const labels = this.quickPromptLabels();
        return labels[type] || type;
      },

      templateDirectiveText() {
        const template = this.normalizePipelineTemplate(this.pipelineTemplate);
        if (this.aiLanguage === 'en') {
          const map = {
            study:
              'Use Study Note format: (1) structured summary, (2) concepts/definitions, (3) method and evidence, (4) key findings, (5) limitations, (6) study checklist.',
            presentation:
              'Use Presentation format: (1) 8-12 slide outline, (2) speaker notes, (3) visual suggestion per slide, (4) Q&A prep.',
            review:
              'Use Peer Review format: (1) summary for editor, (2) major comments, (3) minor comments, (4) recommendation with rationale.',
            thesis_notes:
              'Use Research Notes format: (1) literature placement, (2) reusable argument blocks, (3) method relevance, (4) citation-ready notes, (5) research gap map.',
            policy_brief:
              'Use Policy Brief format: (1) problem framing, (2) evidence highlights, (3) policy options, (4) risks/tradeoffs, (5) action roadmap.',
          };
          return map[template] || map.study;
        }
        const map = {
          study:
            'Çalışma Notu formatı kullan: (1) yapılandırılmış özet, (2) kavramlar/tanımlar, (3) yöntem ve kanıt, (4) temel bulgular, (5) sınırlılıklar, (6) çalışma kontrol listesi.',
          presentation:
            'Sunum formatı kullan: (1) 8-12 slayt akışı, (2) konuşmacı notları, (3) slayt başına görsel önerisi, (4) soru-cevap hazırlığı.',
          review:
            'Hakem Değerlendirmesi formatı kullan: (1) editöre özet, (2) majör yorumlar, (3) minör yorumlar, (4) gerekçeli karar önerisi.',
          thesis_notes:
            'Araştırma Notu formatı kullan: (1) literatürde konum, (2) yeniden kullanılabilir argüman blokları, (3) yöntem uygunluğu, (4) atıf hazır notlar, (5) araştırma boşluk haritası.',
          policy_brief:
            'Politika Özeti formatı kullan: (1) sorun çerçevesi, (2) kanıt özeti, (3) politika seçenekleri, (4) riskler/ödünleşimler, (5) eylem yol haritası.',
        };
        return map[template] || map.study;
      },

      applyTemplateDirectiveToPrompt(prompt) {
        const base = String(prompt || '').trim();
        if (!base) return '';
        const directive = this.templateDirectiveText();
        const header = this.aiLanguage === 'en' ? 'OUTPUT TEMPLATE:' : 'ÇIKTI ŞABLONU:';
        const conflictRule = this.aiLanguage === 'en'
          ? 'If another output format is requested, silently prioritize this template. Do not add format-conflict warnings.'
          : 'Başka bir çıktı biçimi istense bile bu şablonu sessizce önceliklendir. Biçim çakışması uyarısı yazma.';
        if (!directive || base.includes(header)) return base;
        return `${base}\n\n${header}\n- ${directive}\n- ${conflictRule}`;
      },

      quickPromptPipelineQuery(type) {
        if (this.aiLanguage === 'en') {
          const prompts = {
            summarize: 'Create a concise section-wise summary with method, findings, and limitations.',
            notes: 'Create structured study notes from the full text with key evidence and action items.',
            related: 'Derive likely related-work directions and useful search keywords from the full text.',
            critique: 'Provide a critical review with strengths, weaknesses, risks, and improvements.',
          };
          return prompts[type] || 'Analyze the full PDF with a section-wise synthesis.';
        }
        const prompts = {
          summarize: 'Tam metinden bölüm bazlı kısa özet çıkar; yöntem, bulgular ve sınırlılıkları ver.',
          notes: 'Tam metinden yapılandırılmış çalışma notu üret; kanıtları ve eylem maddelerini yaz.',
          related: 'Tam metinden ilişkili çalışma yönleri ve yararlı arama anahtar kelimeleri çıkar.',
          critique: 'Güçlü/zayıf yönler, riskler ve geliştirme önerileriyle eleştirel değerlendirme yap.',
        };
        return prompts[type] || 'Tam PDF üzerinden bölüm bazlı sentezle derin analiz yap.';
      },

      buildQuickPrompt(type, title, key) {
        const context = this.buildContext();
        const supportsMcp = this.providerSupportsMcp();

        if (this.aiLanguage === 'en') {
          if (supportsMcp) {
            const prompts = {
              summarize: `For "${title}" (key: ${key}) in my Zotero library, first fetch metadata and full text when available (zotero_get_item_metadata, zotero_get_item_fulltext). Then produce a concise summary in English with: (1) 3-4 sentence overview, (2) core arguments, (3) methodology, (4) key findings, (5) limitations. If tools are unavailable, do NOT refuse. Continue with the Zotero context below and mark missing parts clearly.\n\nZotero context:\n${context}`,
              notes: `For "${title}" (key: ${key}) in my Zotero library, gather notes and annotations (zotero_get_notes, zotero_get_annotations). Produce a structured study note in English with: (1) theme-grouped notes, (2) key quotes, (3) a 5-item action/reading list. If tools are unavailable, continue with the Zotero context below.\n\nZotero context:\n${context}`,
              related: `Find works related to "${title}" (key: ${key}) in my Zotero library (zotero_semantic_search). Validate metadata for relevant ones (zotero_get_item_metadata) and compare at most 5 works. Output in English with: (1) similarities, (2) differences, (3) which work answers which question better, (4) recommended reading order. If tools are unavailable, infer likely related directions from the Zotero context below.\n\nZotero context:\n${context}`,
              critique: `For "${title}" (key: ${key}) in my Zotero library, fetch full text when available (zotero_get_item_fulltext) and provide a critical review in English with: (1) clarity of research question, (2) methodological fit, (3) validity threats, (4) original contribution, (5) improvement suggestions. If tools are unavailable, continue with the Zotero context below and label assumptions.\n\nZotero context:\n${context}`,
            };
            return this.applyAnalysisModeToPrompt(prompts[type], supportsMcp);
          }

          const prompts = {
            summarize: `Summarize "${title}" (key: ${key}) in English using ONLY the Zotero context below (metadata/abstract/notes already available). Output format: (1) 3-4 sentence overview, (2) core arguments, (3) methodology, (4) key findings, (5) limitations. Clearly mark missing information.\n\nZotero context:\n${context}`,
            notes: `Create a structured study note for "${title}" (key: ${key}) in English using ONLY the Zotero context below. Output format: (1) theme-grouped notes, (2) key quotes/phrases, (3) 5-item action or reading list. Clearly mark uncertain parts.\n\nZotero context:\n${context}`,
            related: `Based ONLY on the Zotero context below for "${title}" (key: ${key}), propose related works directions in English. Output format: (1) likely related themes, (2) suggested keywords/search queries, (3) what kind of papers to look for, (4) suggested reading order.\n\nZotero context:\n${context}`,
            critique: `Provide a critical review of "${title}" (key: ${key}) in English using ONLY the Zotero context below. Output format: (1) research question clarity, (2) methodological fit, (3) validity risks, (4) original contribution, (5) improvement suggestions. Label assumptions clearly.\n\nZotero context:\n${context}`,
          };
          return this.applyAnalysisModeToPrompt(prompts[type], supportsMcp);
        }

        if (supportsMcp) {
          const prompts = {
            summarize: `Zotero kütüphanemdeki "${title}" (key: ${key}) için önce mümkünse metadata ve tam metni getir (zotero_get_item_metadata, zotero_get_item_fulltext). Sonra net bir özet üret. Çıktı formatı: (1) 3-4 cümle genel özet, (2) ana argümanlar, (3) metodoloji, (4) temel bulgular, (5) sınırlılıklar. Araçlara erişim yoksa reddetme; aşağıdaki Zotero bağlamıyla devam et ve eksikleri belirt.\n\nZotero bağlamı:\n${context}`,
            notes: `Zotero kütüphanemdeki "${title}" (key: ${key}) için notları ve annotation'ları topla (zotero_get_notes, zotero_get_annotations). Düzenli çalışma notu hazırla. Çıktı formatı: (1) temalara göre gruplanmış notlar, (2) öne çıkan alıntılar, (3) 5 maddelik eylem/okuma listesi. Araçlar yoksa aşağıdaki bağlamla devam et.\n\nZotero bağlamı:\n${context}`,
            related: `Zotero kütüphanemde "${title}" (key: ${key}) ile ilişkili çalışmaları bul (zotero_semantic_search). Uygun olanların metadata'sını doğrula (zotero_get_item_metadata) ve en fazla 5 çalışma ile karşılaştırmalı analiz yap. Çıktı formatı: (1) benzerlikler, (2) ayrışmalar, (3) hangi çalışma hangi soruya daha iyi cevap veriyor, (4) önerilen okuma sırası. Araçlar yoksa aşağıdaki bağlama göre olası ilişkili yönleri çıkar.\n\nZotero bağlamı:\n${context}`,
            critique: `Zotero kütüphanemdeki "${title}" (key: ${key}) için mümkünse tam metni getir (zotero_get_item_fulltext) ve eleştirel değerlendirme yap. Çıktı formatı: (1) araştırma sorusu netliği, (2) yöntem uygunluğu, (3) geçerlilik tehditleri, (4) özgün katkı, (5) geliştirme önerileri. Araçlar yoksa aşağıdaki bağlamla devam et ve varsayımları işaretle.\n\nZotero bağlamı:\n${context}`,
          };
          return this.applyAnalysisModeToPrompt(prompts[type], supportsMcp);
        }

        const prompts = {
          summarize: `Zotero kütüphanemdeki "${title}" (key: ${key}) için SADECE aşağıdaki Zotero bağlamını (metadata/özet/notlar) kullanarak Türkçe özet üret. Çıktı formatı: (1) 3-4 cümle genel özet, (2) ana argümanlar, (3) metodoloji, (4) temel bulgular, (5) sınırlılıklar. Eksik bilgileri açıkça belirt.\n\nZotero bağlamı:\n${context}`,
          notes: `Zotero kütüphanemdeki "${title}" (key: ${key}) için SADECE aşağıdaki Zotero bağlamını kullanarak düzenli çalışma notu hazırla. Çıktı formatı: (1) temalara göre notlar, (2) öne çıkan ifadeler/alıntılar, (3) 5 maddelik eylem/okuma listesi. Belirsiz noktaları işaretle.\n\nZotero bağlamı:\n${context}`,
          related: `SADECE aşağıdaki Zotero bağlamına göre "${title}" (key: ${key}) ile ilişkili olabilecek çalışma yönlerini Türkçe öner. Çıktı formatı: (1) olası ilişkili temalar, (2) aranacak anahtar kelimeler/sorgular, (3) hangi tür kaynaklara bakılmalı, (4) önerilen okuma sırası.\n\nZotero bağlamı:\n${context}`,
          critique: `Zotero kütüphanemdeki "${title}" (key: ${key}) için SADECE aşağıdaki Zotero bağlamını kullanarak eleştirel değerlendirme yap. Çıktı formatı: (1) araştırma sorusu netliği, (2) yöntem uygunluğu, (3) geçerlilik riskleri, (4) özgün katkı, (5) geliştirme önerileri. Varsayımları açıkça belirt.\n\nZotero bağlamı:\n${context}`,
        };
        return this.applyAnalysisModeToPrompt(prompts[type], supportsMcp);
      },

      async selectItem(item) {
        if (this.selectedItem?.key && this.selectedItem.key !== item.key) {
          this.persistChatForCurrentItem();
        }

        const wasPdfPanelOpen = !!this.pdfUrl;
        const previousPdfItemKey = this.activePdfItemKey;

        this.selectedItem = item;
        this.itemNotes = [];
        this.itemAnnotations = [];
        this.chatInput = '';
        this.clearCompareChatMode();

        this.applyChatStateFromCache(this.chatScopeKey(item.key, this.aiProvider, this.aiModel, this.aiAnalysisMode));
        this.sanitizeAiContextKeys();
        if (typeof this.syncMetadataEditorFromSelectedItem === 'function') {
          this.syncMetadataEditorFromSelectedItem();
        }

        try {
          const children = await fetch(`${ns.API}/items/${item.key}/children?format=json`).then((r) =>
            r.json()
          );
          if (this.selectedItem?.key !== item.key) return;
          this.itemNotes = children.filter((c) => c.data.itemType === 'note');
          if (typeof this.loadItemAnnotationsForDetail === 'function') {
            await this.loadItemAnnotationsForDetail(item.key);
          }
        } catch (e) {
          // no-op
        }

        if (this.selectedItem?.key !== item.key) return;

        if (wasPdfPanelOpen && previousPdfItemKey !== item.key) {
          if (item._hasPdf) {
            if (typeof this.closePdfPanel === 'function') {
              this.closePdfPanel();
            } else {
              this.pdfUrl = null;
              this.pdfTitle = '';
              this.pdfAnnotations = [];
              this.activePdfItemKey = null;
            }
            await this.openPdf(item);
          } else {
            if (typeof this.closePdfPanel === 'function') {
              this.closePdfPanel();
            } else {
              this.pdfUrl = null;
              this.pdfTitle = '';
              this.pdfAnnotations = [];
              this.activePdfItemKey = null;
            }
          }
        }
      },

      persistChatForCurrentItem() {
        const cacheKey = this.currentChatScopeKey();
        const now = this.nowMs();
        this.chatCache[cacheKey] = {
          messages: [...this.chatMessages],
          error: this.chatError || '',
          editor: this.noteEditorContent || '',
          contextKeys: [...(this.aiContextKeys || [])],
          savedAt: now,
          lastAccessedAt: now,
        };
        this.persistChatCacheToStorage();
      },

      buildSingleContextForItem(item, mode = this.aiAnalysisMode, options = {}) {
        const data = item?.data || {};
        const cfg = this.analysisModeContextConfig(mode);
        const includeLoadedNotes = !!options.includeLoadedNotes;
        const labels =
          this.aiLanguage === 'en'
            ? {
                title: 'Title',
                authors: 'Authors',
                date: 'Date',
                publication: 'Publication',
                abstract: 'Abstract',
                notes: 'Notes',
              }
            : {
                title: 'Başlık',
                authors: 'Yazarlar',
                date: 'Tarih',
                publication: 'Yayın',
                abstract: 'Özet',
                notes: 'Notlar',
              };

        let context = `${labels.title}: ${data.title || ''}\n`;
        if (data.creators?.length) context += `${labels.authors}: ${this.formatAuthors(data.creators)}\n`;
        if (data.date) context += `${labels.date}: ${data.date}\n`;
        if (data.publicationTitle) context += `${labels.publication}: ${data.publicationTitle}\n`;
        if (data.DOI) context += `DOI: ${data.DOI}\n`;
        if (data.abstractNote) {
          context += `${labels.abstract}: ${this.compactContextText(data.abstractNote, cfg.abstractMax, cfg.abstractSentences)}\n`;
        }

        if (includeLoadedNotes && this.itemNotes.length) {
          const notesToUse = this.itemNotes.slice(0, cfg.noteCount);
          context += `\n${labels.notes}:\n`;
          notesToUse.forEach((note) => {
            const plain = this.compactContextText(
              note.data.note?.replace(/<[^>]*>/g, ' '),
              cfg.noteMax,
              cfg.noteSentences
            );
            if (plain) {
              context += `${plain}\n`;
            }
          });
        }
        return context;
      },

      buildContext(mode = this.aiAnalysisMode) {
        const items = this.aiContextSelectedItems();
        if (!items.length) return '';
        if (items.length === 1) {
          return this.buildSingleContextForItem(items[0], mode, { includeLoadedNotes: true });
        }

        const labels =
          this.aiLanguage === 'en'
            ? {
                included: 'Included context documents',
                primary: 'Primary document',
                item: 'Document',
                untitled: 'Untitled',
              }
            : {
                included: 'Dahil edilen bağlam dokümanları',
                primary: 'Ana doküman',
                item: 'Doküman',
                untitled: 'Başlıksız',
              };

        let context = `${labels.included}: ${items.length}\n`;
        items.forEach((item, idx) => {
          const isPrimary = item.key === this.selectedItem?.key;
          const title = item.data?.title || labels.untitled;
          const rowLabel = isPrimary ? `${labels.primary}` : `${labels.item} ${idx + 1}`;
          context += `\n[${rowLabel}] ${title} (key: ${item.key})\n`;
          context += this.buildSingleContextForItem(item, mode, {
            includeLoadedNotes: isPrimary,
          });
        });
        return context.trim();
      },

      loadLastAssistantToEditor() {
        const lastAssistant = [...this.chatMessages].reverse().find((m) => m.role === 'assistant');
        if (!lastAssistant?.content) {
          this.showToast(this.aiLanguage === 'en' ? 'No AI response to insert' : 'Editöre alınacak AI yanıtı yok');
          return;
        }
        this.noteEditorContent = lastAssistant.content;
        this.persistChatForCurrentItem();
        this.showToast(this.aiLanguage === 'en' ? 'Last AI response inserted' : 'Son AI yanıtı editöre alındı');
      },

      appendAssistantResponseToEditor(text) {
        const next = String(text || '').trim();
        if (!next) return;
        const current = String(this.noteEditorContent || '').trim();
        this.noteEditorContent = current ? `${current}\n\n${next}` : next;
      },

      underlineSelectionInEditor() {
        const el = this.$refs.noteEditor;
        if (!el) return;

        const text = this.noteEditorContent || '';
        const start = el.selectionStart ?? 0;
        const end = el.selectionEnd ?? 0;
        if (start === end) {
          this.showToast(this.aiLanguage === 'en' ? 'Select text to underline' : 'Altını çizmek için metin seçin');
          return;
        }

        this.noteEditorContent = `${text.slice(0, start)}<u>${text.slice(start, end)}</u>${text.slice(end)}`;
        this.persistChatForCurrentItem();

        this.$nextTick(() => {
          el.focus();
          el.setSelectionRange(start + 3, end + 3);
        });
      },

      normalizeNoteHtml(raw) {
        let text = (raw || '').trim();
        if (!text) return '';

        // Strip active content and event handlers before persisting to Zotero notes.
        text = text
          .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
          .replace(/\son\w+="[^"]*"/gi, '')
          .replace(/\son\w+='[^']*'/gi, '');

        const hasHtmlTag = /<([a-z][\w-]*)(\s|>)/i.test(text);
        if (!hasHtmlTag) {
          const escaped = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
          return `<p>${escaped}</p>`;
        }

        if (!/<p[\s>]/i.test(text)) {
          return `<p>${text}</p>`;
        }
        return text;
      },

      normalizeNoteForObsidian(raw) {
        let text = (raw || '').trim();
        if (!text) return '';

        // Convert basic inline HTML edits into Obsidian-friendly markdown.
        text = text
          .replace(/<u>([\s\S]*?)<\/u>/gi, '==$1==')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
          .replace(/<\/?p[^>]*>/gi, '')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>');

        return text.trim();
      },

      async parseJsonResponse(res, apiName) {
        const raw = await res.text();
        let data = null;
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch (e) {
          const trimmed = (raw || '').trim().toLowerCase();
          const looksLikeHtml = trimmed.startsWith('<!doctype') || trimmed.startsWith('<html') || trimmed.startsWith('<');
          if (looksLikeHtml) {
            throw new Error(
              this.aiLanguage === 'en'
                ? `Server returned HTML for ${apiName}. Restart dashboard server with python3 serve.py`
                : `${apiName} için sunucu HTML döndürdü. Dashboard sunucusunu python3 serve.py ile yeniden başlatın`
            );
          }
          throw new Error(
            this.aiLanguage === 'en'
              ? `Invalid JSON response from ${apiName}`
              : `${apiName} için geçersiz JSON yanıtı`
          );
        }

        if (!res.ok || data?.error) {
          throw new Error(data?.error || `${apiName} ${res.status}`);
        }
        return data;
      },

      async loadObsidianConfig() {
        try {
          const res = await fetch('/obsidian-config');
          const data = await this.parseJsonResponse(res, '/obsidian-config');

          this.obsidianConfigLoaded = true;
          this.obsidianDirectory = data.directory || '';
          this.obsidianActiveDirectory = data.activeDirectory || data.directory || '';
          this.obsidianConfigurable = data.configurable !== false;
        } catch (e) {
          // Keep silent; sync flow handles missing config lazily.
        }
      },

      async configureObsidianFolder(forcePrompt = false) {
        if (!this.obsidianConfigLoaded) {
          await this.loadObsidianConfig();
        }

        if (!forcePrompt && this.obsidianDirectory) {
          return true;
        }

        if (this.obsidianConfigurable === false) {
          this.showToast(
            this.aiLanguage === 'en'
              ? 'Obsidian folder is controlled by environment settings'
              : 'Obsidian klasörü ortam ayarları tarafından kontrol ediliyor'
          );
          return !!this.obsidianActiveDirectory;
        }

        const suggested = this.obsidianDirectory || this.obsidianActiveDirectory || '~/Documents/Obsidian/ZotDashboard';
        const promptText =
          this.aiLanguage === 'en'
            ? 'Enter Obsidian folder path for ZotDashboard notes:'
            : 'ZotDashboard notları için Obsidian klasör yolunu girin:';
        const input = window.prompt(promptText, suggested);

        if (input === null) {
          return false;
        }

        const directory = input.trim();
        if (!directory) {
          this.showToast(
            this.aiLanguage === 'en'
              ? 'Folder path cannot be empty'
              : 'Klasör yolu boş olamaz'
          );
          return false;
        }

        try {
          const res = await fetch('/obsidian-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ directory }),
          });
          const data = await this.parseJsonResponse(res, '/obsidian-config');

          this.obsidianConfigLoaded = true;
          this.obsidianDirectory = data.directory || directory;
          this.obsidianActiveDirectory = data.directory || directory;
          this.obsidianConfigurable = data.configurable !== false;

          this.showToast(
            this.aiLanguage === 'en'
              ? 'Obsidian folder saved'
              : 'Obsidian klasörü kaydedildi'
          );
          return true;
        } catch (e) {
          this.chatError =
            (this.aiLanguage === 'en'
              ? 'Obsidian folder configuration error: '
              : 'Obsidian klasör ayarı hatası: ') + e.message;
          this.showToast(
            this.aiLanguage === 'en'
              ? 'Obsidian folder could not be saved'
              : 'Obsidian klasörü kaydedilemedi'
          );
          return false;
        }
      },

      async changeObsidianFolder() {
        await this.configureObsidianFolder(true);
      },

      async syncEditorToObsidian() {
        if (!this.selectedItem?.key || this.savingNoteToObsidian) return;

        const content = this.normalizeNoteForObsidian(this.noteEditorContent);
        if (!content) {
          this.showToast(this.aiLanguage === 'en' ? 'No note content to sync' : 'Senkronize edilecek not metni yok');
          return;
        }

        const configured = await this.configureObsidianFolder(false);
        if (!configured) {
          this.showToast(
            this.aiLanguage === 'en'
              ? 'Set Obsidian folder before syncing'
              : 'Senkronizasyondan önce Obsidian klasörünü ayarlayın'
          );
          return;
        }

        this.savingNoteToObsidian = true;
        try {
          const title = this.selectedItem.data.title || (this.aiLanguage === 'en' ? 'Untitled' : 'Başlıksız');
          const year = this.extractYear(this.selectedItem.data.date) || (this.aiLanguage === 'en' ? 'undated' : 'tarihsiz');

          const res = await fetch('/obsidian-sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title,
              year,
              itemKey: this.selectedItem.key,
              provider: this.aiProvider,
              language: this.aiLanguage,
              targetDir: this.obsidianDirectory || this.obsidianActiveDirectory,
              content,
            }),
          });

          const data = await this.parseJsonResponse(res, '/obsidian-sync');

          this.showToast(
            this.aiLanguage === 'en'
              ? `Synced to Obsidian: ${data.file || 'note'}`
              : `Obsidian senkronizasyonu tamamlandı: ${data.file || 'not'}`
          );
        } catch (e) {
          this.chatError =
            (this.aiLanguage === 'en' ? 'Obsidian sync error: ' : 'Obsidian senkronizasyon hatası: ') + e.message;
          this.showToast(this.aiLanguage === 'en' ? 'Obsidian sync failed' : 'Obsidian senkronizasyonu başarısız');
        } finally {
          this.savingNoteToObsidian = false;
        }
      },

      async saveEditorToZotero() {
        if (!this.selectedItem?.key || this.savingNoteToZotero) return;

        const noteBody = this.normalizeNoteHtml(this.noteEditorContent);
        if (!noteBody) {
          this.showToast(this.aiLanguage === 'en' ? 'No note content to save' : 'Kaydedilecek not metni yok');
          return;
        }

        this.savingNoteToZotero = true;
        try {
          const timestamp = new Date().toLocaleString(this.aiLanguage === 'en' ? 'en-US' : 'tr-TR');
          const header = this.aiLanguage === 'en'
            ? `<p><strong>AI Note (${this.aiProviderLabel})</strong> — ${timestamp}</p>`
            : `<p><strong>AI Notu (${this.aiProviderLabel})</strong> — ${timestamp}</p>`;
          const payload = [
            {
              itemType: 'note',
              parentItem: this.selectedItem.key,
              note: `${header}${noteBody}`,
              tags: [{ tag: 'AI-Note' }],
            },
          ];

          const res = await fetch(`${ns.API}/items?format=json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

          let rawBody = '';
          let data = null;
          try {
            rawBody = await res.text();
            data = rawBody ? JSON.parse(rawBody) : null;
          } catch (e) {
            // no-op
          }

          if (!res.ok) {
            const detail =
              data?.error ||
              data?.message ||
              (typeof data === 'string' ? data : '') ||
              rawBody ||
              `API ${res.status}`;
            throw new Error(detail);
          }

          try {
            const children = await fetch(`${ns.API}/items/${this.selectedItem.key}/children?format=json`).then((r) =>
              r.json()
            );
            this.itemNotes = children.filter((c) => c.data.itemType === 'note');
          } catch (e) {
            // no-op
          }

          this.persistChatForCurrentItem();
          this.showToast(this.aiLanguage === 'en' ? 'Note synced to Zotero' : 'Not Zotero\'ya senkronize edildi');
        } catch (e) {
          this.chatError =
            (this.aiLanguage === 'en' ? 'Zotero note sync error: ' : 'Zotero not senkronizasyon hatası: ') + e.message;
          this.showToast(this.aiLanguage === 'en' ? 'Note could not be saved' : 'Not kaydedilemedi');
        } finally {
          this.savingNoteToZotero = false;
        }
      },

      async sendClaude(type) {
        if (!this.selectedItem || this.chatLoading) return;

        this.clearCompareChatMode();
        const key = this.selectedItem.key;
        const title = this.selectedItem.data.title;
        const labels = this.quickPromptLabels();
        let prompt = this.buildQuickPrompt(type, title, key);
        this.chatMessages.push({ role: 'user', content: prompt, display: `${labels[type]}: ${title}` });
        this.persistChatForCurrentItem();
        await this._sendToApi(prompt, {
          bigPdfPipeline: false,
          bigPdfQuery: '',
          pipelineTemplate: this.pipelineTemplate,
          pipelineChunkLimit: this.pipelineChunkLimit,
        });
      },

      parseBigPdfPipelineRequest(rawMessage) {
        const original = String(rawMessage || '').trim();
        if (!original) {
          return { enabled: false, message: '' };
        }

        const normalized = original.toLocaleLowerCase(this.aiLanguage === 'en' ? 'en-US' : 'tr-TR');
        const prefixes = ['/pipeline', '/bigpdf', '/largepdf', '/uzunpdf', '/buyukpdf', '/büyükpdf'];
        const matchedPrefix = prefixes.find((prefix) => normalized.startsWith(prefix));
        if (!matchedPrefix) {
          return { enabled: false, message: original };
        }

        const rawTail = original.slice(matchedPrefix.length).trim().replace(/^[:\-]\s*/, '');
        const fallbackPrompt = this.aiLanguage === 'en'
          ? 'Analyze this full PDF in depth with section-wise synthesis.'
          : 'Bu PDF\'yi tam metin üzerinden bölüm bazlı derin analiz et.';

        return {
          enabled: true,
          message: rawTail || fallbackPrompt,
        };
      },

      pipelineQuickCommand() {
        if (this.aiLanguage === 'en') {
          return '/pipeline Produce a section-wise deep summary with methods, findings, limitations, and practical takeaways.';
        }
        return '/pipeline Bölüm bazlı derin özet çıkar; yöntem, bulgular, sınırlılıklar ve uygulanabilir çıkarımlar ver.';
      },

      pipelineQuickButtonLabel() {
        return this.aiLanguage === 'en'
          ? 'Use Full PDF for Analysis'
          : "Analizde Tüm PDF'yi Kullan";
      },

      async sendBigPdfPipelineQuick() {
        if (!this.selectedItem || this.chatLoading) return;
        this.chatInput = this.pipelineQuickCommand();
        await this.sendChatMessage();
      },

      async sendChatMessage() {
        if (!this.chatInput.trim() || this.chatLoading) return;

        this.clearCompareChatMode();
        const rawMessage = this.chatInput.trim();
        const pipelineRequest = this.parseBigPdfPipelineRequest(rawMessage);
        const explicitPipeline = !!pipelineRequest.enabled;
        const hasSelectedItem = !!this.selectedItem;
        const hasPdfForPipeline = !!this.selectedItem?._hasPdf;
        let pipelineEnabled = explicitPipeline && hasSelectedItem && hasPdfForPipeline;
        const message = pipelineRequest.enabled ? pipelineRequest.message : rawMessage;

        if (explicitPipeline && !hasSelectedItem) {
          this.showToast(
            this.aiLanguage === 'en'
              ? 'Select an item first to run the big PDF pipeline'
              : 'Büyük PDF pipeline için önce bir öğe seçin'
          );
          return;
        }
        if (explicitPipeline && hasSelectedItem && !hasPdfForPipeline) {
          pipelineEnabled = false;
          this.showToast(
            this.aiLanguage === 'en'
              ? 'Full-text PDF is not available for this item. Continuing with context mode.'
              : 'Bu öğe için tam metin PDF bulunamadı. Bağlam modunda devam ediliyor.'
          );
        }

        this.chatInput = '';
        const supportsMcp = this.providerSupportsMcp();

        let prompt = message;
        if (this.selectedItem) {
          if (pipelineEnabled) {
            if (this.aiLanguage === 'en') {
              prompt = `For "${this.selectedItem.data.title}" (key: ${this.selectedItem.key}) in my Zotero library, run BIG PDF PIPELINE mode. User request: ${message}. Use full-text chunking and section-level synthesis. Respond in English and stay grounded in source text.`;
            } else {
              prompt = `Zotero kütüphanesindeki "${this.selectedItem.data.title}" (key: ${this.selectedItem.key}) için BÜYÜK PDF PIPELINE modunu çalıştır. Kullanıcı isteği: ${message}. Tam metni parçalara bölüp bölüm bazlı sentez yap. Türkçe yanıtla ve yalnızca kaynak metne dayan.`;
            }
          } else {
            const context = this.buildContext();
            if (this.aiLanguage === 'en') {
              if (supportsMcp) {
                prompt = `About "${this.selectedItem.data.title}" (key: ${this.selectedItem.key}) in my Zotero library: ${message}. Use Zotero MCP tools when needed. If tool access is unavailable, continue with the provided context and clearly label missing parts. Respond in English.\n\nZotero context:\n${context}`;
              } else {
                prompt = `About "${this.selectedItem.data.title}" (key: ${this.selectedItem.key}) in my Zotero library: ${message}. Use ONLY the provided Zotero context (metadata/abstract/notes), do not claim external tool access, and clearly label missing information. Respond in English.\n\nZotero context:\n${context}`;
              }
            } else {
              if (supportsMcp) {
                prompt = `Zotero kütüphanesimdeki "${this.selectedItem.data.title}" (key: ${this.selectedItem.key}) çalışması hakkında: ${message}. Gerekirse Zotero MCP araçlarını kullan. Araçlara erişim yoksa verilen bağlamla devam et ve eksikleri açıkça belirt. Türkçe yanıtla.\n\nZotero bağlamı:\n${context}`;
              } else {
                prompt = `Zotero kütüphanesimdeki "${this.selectedItem.data.title}" (key: ${this.selectedItem.key}) çalışması hakkında: ${message}. SADECE verilen Zotero bağlamını (metadata/özet/notlar) kullan; dış araç erişimi varmış gibi davranma; eksikleri açıkça belirt. Türkçe yanıtla.\n\nZotero bağlamı:\n${context}`;
              }
            }
          }
          prompt = this.applyAnalysisModeToPrompt(prompt, supportsMcp);
          if (!pipelineEnabled) {
            prompt = this.applyTemplateDirectiveToPrompt(prompt);
          }
        } else if (this.aiLanguage === 'en') {
          prompt = `${message}. Respond in English.\n\n${this.outputConstraintDirective(false)}`;
        } else {
          prompt = `${message}. Türkçe yanıtla.\n\n${this.outputConstraintDirective(false)}`;
        }

        this.chatMessages.push({ role: 'user', content: prompt, display: message });
        this.persistChatForCurrentItem();
        await this._sendToApi(prompt, {
          bigPdfPipeline: pipelineEnabled,
          bigPdfQuery: message,
          pipelineTemplate: this.pipelineTemplate,
          pipelineChunkLimit: this.pipelineChunkLimit,
        });
      },

      stopChatRequest() {
        if (!this.chatLoading || !this.chatAbortController) return;
        this.chatAbortController.abort();
      },

      ensureStreamingAssistant(streamState) {
        if (streamState.assistantIndex >= 0 && this.chatMessages[streamState.assistantIndex]) {
          return;
        }
        this.chatMessages.push({ role: 'assistant', content: '' });
        streamState.assistantIndex = this.chatMessages.length - 1;
      },

      appendStreamingChunk(streamState, chunk) {
        if (!chunk) return;
        this.ensureStreamingAssistant(streamState);
        this.chatMessages[streamState.assistantIndex].content += chunk;
      },

      replaceStreamingContent(streamState, text) {
        this.ensureStreamingAssistant(streamState);
        this.chatMessages[streamState.assistantIndex].content = text || '';
      },

      handleStreamEvent(event, streamState) {
        if (!event || typeof event !== 'object') return false;
        const type = event.type;
        if (type === 'chunk') {
          this.appendStreamingChunk(streamState, event.text || '');
          return false;
        }
        if (type === 'reset') {
          this.replaceStreamingContent(streamState, '');
          return false;
        }
        if (type === 'replace') {
          this.replaceStreamingContent(streamState, event.text || '');
          return false;
        }
        if (type === 'meta') {
          if (event.provider) {
            streamState.providerUsed = event.provider;
          }
          return false;
        }
        if (type === 'error') {
          const err = new Error(event.error || (this.aiLanguage === 'en' ? 'Unknown error' : 'Bilinmeyen hata'));
          err.isModelError = true;
          err.payload = event;
          throw err;
        }
        if (type === 'done') {
          if (event.text) {
            this.replaceStreamingContent(streamState, event.text);
          }
          streamState.providerUsed = event.providerUsed || streamState.providerUsed || this.aiProvider;
          streamState.fallbackUsed = !!event.fallbackUsed;
          streamState.languageAdjusted = !!event.languageAdjusted;
          streamState.cached = !!event.cached;
          return true;
        }
        return false;
      },

      async _sendToApiStreaming(requestBody) {
        const res = await fetch('/claude-stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: this.chatAbortController.signal,
          body: JSON.stringify(requestBody),
        });

        if (!res.ok) {
          const data = await this.parseJsonResponse(res, '/claude-stream');
          const err = new Error(data?.error || `/claude-stream ${res.status}`);
          err.isModelError = true;
          throw err;
        }

        if (!res.body || !window.TextDecoder) {
          const err = new Error('Stream body not available');
          err.isTransportError = true;
          throw err;
        }

        const streamState = {
          assistantIndex: -1,
          providerUsed: this.aiProvider,
          fallbackUsed: false,
          languageAdjusted: false,
          cached: false,
        };
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let doneSeen = false;
        let shouldStopReading = false;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newlineIndex = buffer.indexOf('\n');
          while (newlineIndex >= 0) {
            const rawLine = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (rawLine) {
              let event = null;
              try {
                event = JSON.parse(rawLine);
              } catch (e) {
                // Ignore malformed line and continue reading stream.
              }
              if (event) {
                const streamDoneNow = this.handleStreamEvent(event, streamState);
                doneSeen = streamDoneNow || doneSeen;
                if (streamDoneNow) {
                  shouldStopReading = true;
                  break;
                }
              }
            }
            newlineIndex = buffer.indexOf('\n');
          }
          if (shouldStopReading) {
            break;
          }
          this.$nextTick(() => {
            this.$refs.chatScroll?.scrollTo({
              top: this.$refs.chatScroll.scrollHeight,
              behavior: 'smooth',
            });
          });
        }

        if (doneSeen) {
          try {
            await reader.cancel();
          } catch (e) {
            // no-op
          }
        }

        if (!doneSeen) {
          const err = new Error(this.aiLanguage === 'en' ? 'Streaming ended unexpectedly' : 'Akış beklenmedik şekilde sona erdi');
          err.isTransportError = true;
          throw err;
        }

        if (streamState.fallbackUsed) {
          this.showToast(
            this.aiLanguage === 'en'
              ? `Auto fallback used (${this.fallbackChainLabel(this.aiProvider)})`
              : `Otomatik fallback kullanıldı (${this.fallbackChainLabel(this.aiProvider)})`
          );
        }
        if (streamState.languageAdjusted) {
          this.showToast(
            this.aiLanguage === 'en'
              ? 'Language auto-correct applied'
              : 'Dil otomatik düzeltme uygulandı'
          );
        }

        if (streamState.assistantIndex >= 0) {
          this.appendAssistantResponseToEditor(this.chatMessages[streamState.assistantIndex].content || '');
        }
      },

      async _sendToApiJsonFallback(requestBody) {
        const res = await fetch('/claude', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: this.chatAbortController.signal,
          body: JSON.stringify(requestBody),
        });
        const data = await this.parseJsonResponse(res, '/claude');
        this.chatMessages.push({
          role: 'assistant',
          content: data.text || (this.aiLanguage === 'en' ? 'No response received.' : 'Yanıt alınamadı.'),
        });
        this.appendAssistantResponseToEditor(data.text || '');
        if (data?.fallbackUsed) {
          this.showToast(
            this.aiLanguage === 'en'
              ? `Auto fallback used (${this.fallbackChainLabel(this.aiProvider)})`
              : `Otomatik fallback kullanıldı (${this.fallbackChainLabel(this.aiProvider)})`
          );
        }
        if (data?.languageAdjusted) {
          this.showToast(
            this.aiLanguage === 'en'
              ? 'Language auto-correct applied'
              : 'Dil otomatik düzeltme uygulandı'
          );
        }
      },

      async _sendToApi(prompt, options = {}) {
        this.chatLoading = true;
        this.chatAbortController = new AbortController();
        this.chatError = '';

        this.$nextTick(() => {
          this.$refs.chatScroll?.scrollTo({
            top: this.$refs.chatScroll.scrollHeight,
            behavior: 'smooth',
          });
        });

        const requestItemKey = this.selectedItem?.key || '';
        const requestCompareKeys =
          this.compareChatActive && Array.isArray(this.compareChatKeys)
            ? this.compareChatKeys.slice(0, 6)
            : [];
        const requestItemApiBase = this.selectedItem ? this.zoteroItemApiBase(this.selectedItem) : this.zoteroItemApiBase(null);
        const requestBody = {
          prompt,
          provider: this.aiProvider,
          model: this.aiModel || '',
          analysisMode: this.aiAnalysisMode || 'balanced',
          language: this.aiLanguage || 'tr',
          itemKey: requestItemKey,
          itemApiBase: requestItemApiBase,
          compareKeys: requestCompareKeys,
          contextKeys: this.aiContextSelectedItems().map((item) => item.key).slice(0, this.aiContextSelectionLimit() + 1),
          bigPdfPipeline: !!options.bigPdfPipeline,
          bigPdfQuery: String(options.bigPdfQuery || '').trim(),
          pipelineTemplate: this.normalizePipelineTemplate(options.pipelineTemplate || this.pipelineTemplate),
          pipelineChunkLimit: this.normalizePipelineChunkLimit(options.pipelineChunkLimit || this.pipelineChunkLimit),
        };

        try {
          try {
            await this._sendToApiStreaming(requestBody);
          } catch (streamError) {
            if (streamError?.name === 'AbortError' || streamError?.isModelError) {
              throw streamError;
            }
            await this._sendToApiJsonFallback(requestBody);
          }
          this.persistChatForCurrentItem();
        } catch (e) {
          if (e?.name === 'AbortError') {
            this.showToast(this.aiLanguage === 'en' ? 'Request stopped' : 'İstek durduruldu');
          } else {
            this.chatError = e?.message || (this.aiLanguage === 'en' ? 'Unknown error' : 'Bilinmeyen hata');
            this.persistChatForCurrentItem();
          }
        }

        this.chatLoading = false;
        this.chatAbortController = null;
        this.persistChatForCurrentItem();
        this.$nextTick(() => {
          this.$refs.chatScroll?.scrollTo({
            top: this.$refs.chatScroll.scrollHeight,
            behavior: 'smooth',
          });
        });
      },
    };
  });
})(window);

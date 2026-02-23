(function (window) {
  const ns = window.ZoteroDashboard;

  ns.registerMixin(function registerChat() {
    return {
      chatCacheStorageKey() {
        return 'zotero-chat-cache-v1';
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
        const cached = this.chatCache?.[normalizedKey] || this.chatCache?.[itemFallbackKey];
        this.chatMessages = cached?.messages ? [...cached.messages] : [];
        this.chatError = cached?.error || '';
        this.noteEditorContent = cached?.editor || '';
      },

      loadPersistedChatCache() {
        try {
          const raw = localStorage.getItem(this.chatCacheStorageKey());
          if (!raw) return;
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
          this.chatCache = parsed;
          if (!this.selectedItem) {
            this.applyChatStateFromCache(this.chatScopeKey('__global__', this.aiProvider, this.aiModel, this.aiAnalysisMode));
          }
        } catch (e) {
          // no-op
        }
      },

      persistChatCacheToStorage() {
        try {
          localStorage.setItem(this.chatCacheStorageKey(), JSON.stringify(this.chatCache || {}));
        } catch (e) {
          // no-op
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
          return 'Language rule: Write ONLY in English with proper English grammar, punctuation, and wording. Do not use Turkish words, except unavoidable proper nouns from the source text.';
        }
        return 'Dil kuralı: YANITI TAMAMEN Türkçe yaz. Türkçe dilbilgisi, noktalama ve anlatım kurallarına uy. Kaynak metindeki zorunlu özel adlar dışında yabancı kelime kullanma.';
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
          critique: 'Kritik Değerlendir',
        };
      },

      quickPromptButtonLabel(type) {
        const labels = this.quickPromptLabels();
        return labels[type] || type;
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
        this.noteEditorOpen = true;
        this.clearCompareChatMode();

        this.applyChatStateFromCache(this.chatScopeKey(item.key, this.aiProvider, this.aiModel, this.aiAnalysisMode));
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
        this.chatCache[cacheKey] = {
          messages: [...this.chatMessages],
          error: this.chatError || '',
          editor: this.noteEditorContent || '',
        };
        this.persistChatCacheToStorage();
      },

      buildContext(mode = this.aiAnalysisMode) {
        const data = this.selectedItem?.data || {};
        const cfg = this.analysisModeContextConfig(mode);
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

        if (this.itemNotes.length) {
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
        const prompt = this.buildQuickPrompt(type, title, key);
        this.chatMessages.push({ role: 'user', content: prompt, display: `${labels[type]}: ${title}` });
        this.persistChatForCurrentItem();
        await this._sendToApi(prompt);
      },

      async sendChatMessage() {
        if (!this.chatInput.trim() || this.chatLoading) return;

        this.clearCompareChatMode();
        const message = this.chatInput.trim();
        this.chatInput = '';
        const supportsMcp = this.providerSupportsMcp();

        let prompt = message;
        if (this.selectedItem) {
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
          prompt = this.applyAnalysisModeToPrompt(prompt, supportsMcp);
        } else if (this.aiLanguage === 'en') {
          prompt = `${message}. Respond in English.\n\n${this.outputConstraintDirective(false)}`;
        } else {
          prompt = `${message}. Türkçe yanıtla.\n\n${this.outputConstraintDirective(false)}`;
        }

        this.chatMessages.push({ role: 'user', content: prompt, display: message });
        this.persistChatForCurrentItem();
        await this._sendToApi(prompt);
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

      async _sendToApi(prompt) {
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
        const requestBody = {
          prompt,
          provider: this.aiProvider,
          model: this.aiModel || '',
          analysisMode: this.aiAnalysisMode || 'balanced',
          language: this.aiLanguage || 'tr',
          itemKey: requestItemKey,
          compareKeys: requestCompareKeys,
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

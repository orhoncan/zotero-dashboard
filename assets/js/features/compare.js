(function (window) {
  const ns = window.ZoteroDashboard;

  ns.registerMixin(function registerCompare() {
    return {
      isCompareSelected(key) {
        return this.selectedCompareKeys.includes(key);
      },

      toggleCompare(item, checked) {
        if (checked && !this.selectedCompareKeys.includes(item.key)) {
          if (this.selectedCompareKeys.length >= 3) {
            this.showToast(this.aiLanguage === 'en' ? 'You can select up to 3 items' : 'En fazla 3 öğe seçebilirsiniz');
            return;
          }
          this.selectedCompareKeys.push(item.key);
          if (typeof this.prefetchItemContext === 'function') {
            void this.prefetchItemContext(item);
          }
        } else if (!checked) {
          this.selectedCompareKeys = this.selectedCompareKeys.filter((k) => k !== item.key);
          if (this.selectedCompareKeys.length < 2 && typeof this.clearCompareChatMode === 'function') {
            this.clearCompareChatMode();
          }
        }
      },

      clearCompareSelection() {
        this.selectedCompareKeys = [];
        if (typeof this.clearCompareChatMode === 'function') {
          this.clearCompareChatMode();
        }
      },

      async compareSelectedItems() {
        if (
          this.selectedCompareKeys.length < 2 ||
          this.selectedCompareKeys.length > 3
        ) {
          return;
        }
        if (typeof this.ensureAiReadyForRequest === 'function' && !this.ensureAiReadyForRequest()) {
          return;
        }

        const selected = this.selectedCompareKeys
          .map((key) => (typeof this.findItemByKey === 'function'
            ? this.findItemByKey(key)
            : this.items.find((i) => i.key === key)))
          .filter(Boolean);
        const supportsMcp = typeof this.providerSupportsMcp === 'function'
          ? this.providerSupportsMcp()
          : false;

        if (selected.length < 2) {
          this.showToast(this.aiLanguage === 'en' ? 'Select at least 2 items to compare' : 'Karşılaştırma için en az 2 öğe seçin');
          return;
        }

        if (typeof this.ensureContextEvidenceReady === 'function') {
          await this.ensureContextEvidenceReady(selected);
        }

        await this.selectItem(selected[0]);
        if (typeof this.setChatTopic === 'function') {
          this.setChatTopic('literature', { persistCurrent: true, skipQueue: true });
        }
        this.detailTab = 'chat';

        const list = selected
          .map((item, idx) => {
            const data = item.data;
            const abstractText = (data.abstractNote || '').replace(/\s+/g, ' ').trim();
            const prefetched = typeof this.contextPrefetchEntry === 'function'
              ? (this.contextPrefetchEntry(item.key) || {})
              : {};
            const evidenceText = abstractText || String(prefetched.fulltextSample || prefetched.notesSample || prefetched.annotationsSample || '').trim();
            const evidenceLabel = abstractText
              ? (this.aiLanguage === 'en' ? 'Abstract Context' : 'Özet Bağlamı')
              : (prefetched.fulltextOk
                ? (this.aiLanguage === 'en' ? 'Full-text Context' : 'Tam Metin Bağlamı')
                : (this.aiLanguage === 'en' ? 'Notes Context' : 'Not Bağlamı'));
            const abstractSnippet = evidenceText
              ? (
                typeof this.compactContextText === 'function'
                  ? this.compactContextText(
                      evidenceText,
                      420,
                      this.aiAnalysisMode === 'deep' ? 7 : (this.aiAnalysisMode === 'fast' ? 3 : 5)
                    )
                  : `${evidenceText.slice(0, 420)}${evidenceText.length > 420 ? '…' : ''}`
              )
              : (this.aiLanguage === 'en' ? 'No abstract, full text, or notes' : 'Özet, tam metin veya not yok');
            if (this.aiLanguage === 'en') {
              return `${idx + 1}) "${data.title || 'Untitled'}" (key: ${item.key}) | ${this.formatAuthors(data.creators) || 'No author'} | ${this.extractYear(data.date) || 'No year'} | Type: ${this.formatItemType(data.itemType)}\n   ${evidenceLabel}: ${abstractSnippet}`;
            }
            return `${idx + 1}) "${data.title || 'Başlıksız'}" (key: ${item.key}) | ${this.formatAuthors(data.creators) || 'Yazar yok'} | ${this.extractYear(data.date) || 'Yıl yok'} | Tür: ${this.formatItemType(data.itemType)}\n   ${evidenceLabel}: ${abstractSnippet}`;
          })
          .join('\n');

        const prompt = this.aiLanguage === 'en'
          ? (supportsMcp
            ? `Compare these ${selected.length} papers from my Zotero library:\n${list}\n\nThe provided context may already include PDF-derived full-text excerpts. Treat those excerpts as valid evidence and do not claim that only bibliographic metadata is available when text excerpts are present. For each paper, use zotero_get_item_metadata first. Use zotero_get_item_fulltext if needed for method/findings details. If tools are unavailable, continue strictly with the provided context and label missing parts only where they matter. Write in English with these sections: (1) Shared themes, (2) Differences, (3) Strengths/weaknesses, (4) Which paper is better for which purpose.`
            : `Compare these ${selected.length} papers from my Zotero library using ONLY the provided context below (no external tool access).\n${list}\n\nWrite in English with these sections: (1) Shared themes, (2) Differences, (3) Strengths/weaknesses, (4) Which paper is better for which purpose. Clearly mark uncertain or missing points.`)
          : (supportsMcp
            ? `Zotero kütüphanemde aşağıdaki ${selected.length} çalışmayı karşılaştır:\n${list}\n\nVerilen bağlamda PDF'den alınmış tam metin kırpıntıları bulunabilir; bunları geçerli kanıt olarak kullan ve metin kırpıntısı varken yalnız metadata var deme. Her çalışma için önce zotero_get_item_metadata kullan. Gerekirse zotero_get_item_fulltext ile yöntem/bulgu detaylarını al. Araçlar yoksa verilen bağlamla devam et ve eksikleri yalnız gerekli yerde belirt. Sonuçta şu başlıklarla Türkçe yaz: (1) Ortak temalar, (2) Farklılıklar, (3) Güçlü/Zayıf yönler, (4) Hangi çalışma hangi amaç için daha uygun.`
            : `Zotero kütüphanemde aşağıdaki ${selected.length} çalışmayı SADECE verilen bağlama göre karşılaştır (dış araç erişimi yok):\n${list}\n\nSonuçta şu başlıklarla Türkçe yaz: (1) Ortak temalar, (2) Farklılıklar, (3) Güçlü/Zayıf yönler, (4) Hangi çalışma hangi amaç için daha uygun. Belirsiz/eksik noktaları açıkça işaretle.`);
        let finalPrompt = typeof this.applyAnalysisModeToPrompt === 'function'
          ? this.applyAnalysisModeToPrompt(prompt, supportsMcp)
          : prompt;
        if (typeof this.applySourceRoutingDirectiveToPrompt === 'function') {
          finalPrompt = this.applySourceRoutingDirectiveToPrompt(finalPrompt);
        }

        if (typeof this.markCompareChat === 'function') {
          this.markCompareChat(selected.map((item) => item.key));
        }
        const displayText = this.aiLanguage === 'en'
          ? `Multi-compare (${selected.length} items)`
          : `Çoklu karşılaştırma (${selected.length} öğe)`;

        if (typeof this.enqueueChatTask === 'function') {
          const sourceTitle = selected[0]?.data?.title || (this.aiLanguage === 'en' ? 'Untitled' : 'Başlıksız');
          const primaryItemKey = String(selected[0]?.key || this.selectedItem?.key || '');
          const compareScopeKey = this.chatScopeKey(
            primaryItemKey || '__global__',
            this.aiProvider,
            this.aiModel,
            this.aiAnalysisMode,
            this.chatTopic
          );
          this.enqueueChatTask({
            prompt: finalPrompt,
            message: displayText,
            label: displayText,
            scopeKey: compareScopeKey,
            topic: this.chatTopic,
            itemKey: primaryItemKey,
            itemTitle: sourceTitle,
            options: {
              provider: this.aiProvider,
              model: this.aiModel || '',
              analysisMode: this.aiAnalysisMode || 'balanced',
              language: this.aiLanguage || 'tr',
              bigPdfPipeline: false,
              bigPdfQuery: '',
              pipelineChunkLimit: this.pipelineChunkLimit,
              routingSensitive: true,
              sourceRoutingMode: !!this.sourceRoutingMode,
              forceSourceRouting: false,
              forceItemScope: true,
              userMessage: displayText,
              requestSnapshot: typeof this.buildRequestContextSnapshot === 'function'
                ? this.buildRequestContextSnapshot()
                : {},
            },
          });
          return;
        }

        this.chatMessages.push({
          role: 'user',
          content: finalPrompt,
          display: displayText,
        });
        this.persistChatForCurrentItem();
        await this._sendToApi(finalPrompt);
      },
    };
  });
})(window);

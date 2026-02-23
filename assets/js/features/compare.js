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
          this.selectedCompareKeys.length > 3 ||
          this.chatLoading
        ) {
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

        await this.selectItem(selected[0]);
        this.detailTab = 'chat';

        const list = selected
          .map((item, idx) => {
            const data = item.data;
            const abstractText = (data.abstractNote || '').replace(/\s+/g, ' ').trim();
            const abstractSnippet = abstractText
              ? (
                typeof this.compactContextText === 'function'
                  ? this.compactContextText(
                      abstractText,
                      420,
                      this.aiAnalysisMode === 'deep' ? 7 : (this.aiAnalysisMode === 'fast' ? 3 : 5)
                    )
                  : `${abstractText.slice(0, 420)}${abstractText.length > 420 ? '…' : ''}`
              )
              : (this.aiLanguage === 'en' ? 'No abstract' : 'Özet yok');
            if (this.aiLanguage === 'en') {
              return `${idx + 1}) "${data.title || 'Untitled'}" (key: ${item.key}) | ${this.formatAuthors(data.creators) || 'No author'} | ${this.extractYear(data.date) || 'No year'} | Type: ${this.formatItemType(data.itemType)}\n   Abstract/Notes Context: ${abstractSnippet}`;
            }
            return `${idx + 1}) "${data.title || 'Başlıksız'}" (key: ${item.key}) | ${this.formatAuthors(data.creators) || 'Yazar yok'} | ${this.extractYear(data.date) || 'Yıl yok'} | Tür: ${this.formatItemType(data.itemType)}\n   Özet/Not Bağlamı: ${abstractSnippet}`;
          })
          .join('\n');

        const prompt = this.aiLanguage === 'en'
          ? (supportsMcp
            ? `Compare these ${selected.length} papers from my Zotero library:\n${list}\n\nFor each paper, use zotero_get_item_metadata first. Use zotero_get_item_fulltext if needed for method/findings details. If tools are unavailable, continue strictly with the provided context and label missing parts. Write in English with these sections: (1) Shared themes, (2) Differences, (3) Strengths/weaknesses, (4) Which paper is better for which purpose.`
            : `Compare these ${selected.length} papers from my Zotero library using ONLY the provided context below (no external tool access).\n${list}\n\nWrite in English with these sections: (1) Shared themes, (2) Differences, (3) Strengths/weaknesses, (4) Which paper is better for which purpose. Clearly mark uncertain or missing points.`)
          : (supportsMcp
            ? `Zotero kütüphanemde aşağıdaki ${selected.length} çalışmayı karşılaştır:\n${list}\n\nHer çalışma için önce zotero_get_item_metadata kullan. Gerekirse zotero_get_item_fulltext ile yöntem/bulgu detaylarını al. Araçlar yoksa verilen bağlamla devam et ve eksikleri belirt. Sonuçta şu başlıklarla Türkçe yaz: (1) Ortak temalar, (2) Farklılıklar, (3) Güçlü/Zayıf yönler, (4) Hangi çalışma hangi amaç için daha uygun.`
            : `Zotero kütüphanemde aşağıdaki ${selected.length} çalışmayı SADECE verilen bağlama göre karşılaştır (dış araç erişimi yok):\n${list}\n\nSonuçta şu başlıklarla Türkçe yaz: (1) Ortak temalar, (2) Farklılıklar, (3) Güçlü/Zayıf yönler, (4) Hangi çalışma hangi amaç için daha uygun. Belirsiz/eksik noktaları açıkça işaretle.`);
        const finalPrompt = typeof this.applyAnalysisModeToPrompt === 'function'
          ? this.applyAnalysisModeToPrompt(prompt, supportsMcp)
          : prompt;

        if (typeof this.markCompareChat === 'function') {
          this.markCompareChat(selected.map((item) => item.key));
        }

        this.chatMessages.push({
          role: 'user',
          content: finalPrompt,
          display: this.aiLanguage === 'en'
            ? `Multi-compare (${selected.length} items)`
            : `Çoklu karşılaştırma (${selected.length} öğe)`,
        });
        this.persistChatForCurrentItem();
        await this._sendToApi(finalPrompt);
      },
    };
  });
})(window);

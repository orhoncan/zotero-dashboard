(function (window) {
  const ns = window.ZoteroDashboard;

  ns.registerMixin(function registerMetadata() {
    return {
      syncMetadataEditorFromSelectedItem() {
        if (!this.selectedItem?.data) {
          this.editAbstract = '';
          this.editTagInput = '';
          this.editTags = [];
          return;
        }

        this.editAbstract = this.selectedItem.data.abstractNote || '';
        this.editTagInput = '';

        const uniqueTags = [];
        const seen = new Set();
        (this.selectedItem.data.tags || []).forEach((entry) => {
          const value = (entry?.tag || '').trim();
          if (!value) return;
          const key = this.normalizeText(value);
          if (!seen.has(key)) {
            seen.add(key);
            uniqueTags.push(value);
          }
        });
        this.editTags = uniqueTags;
      },

      addTagFromInput() {
        const raw = (this.editTagInput || '').trim();
        if (!raw) return;

        const incoming = raw
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);

        const next = [...this.editTags];
        const seen = new Set(next.map((t) => this.normalizeText(t)));
        incoming.forEach((tag) => {
          const key = this.normalizeText(tag);
          if (!seen.has(key)) {
            seen.add(key);
            next.push(tag);
          }
        });

        this.editTags = next;
        this.editTagInput = '';
      },

      removeEditTag(tag) {
        this.editTags = this.editTags.filter((t) => t !== tag);
      },

      buildMetadataPayload() {
        const tags = [];
        const seen = new Set();
        (this.editTags || []).forEach((raw) => {
          const value = (raw || '').trim();
          if (!value) return;
          const key = this.normalizeText(value);
          if (!seen.has(key)) {
            seen.add(key);
            tags.push(value);
          }
        });

        return {
          abstractNote: (this.editAbstract || '').trim(),
          tags: tags.map((tag) => ({ tag })),
        };
      },

      async updateItemWithFallbacks(itemKey, patchPayload) {
        const fullPayload = { ...(this.selectedItem?.data || {}), ...patchPayload };
        delete fullPayload.key;
        delete fullPayload.version;

        const attempts = [
          {
            url: `${ns.API}/items/${itemKey}?format=json`,
            method: 'PATCH',
            body: patchPayload,
          },
          {
            url: `${ns.API}/items/${itemKey}?format=json`,
            method: 'PUT',
            body: fullPayload,
          },
          {
            url: `${ns.API}/items?format=json`,
            method: 'PUT',
            body: [
              {
                key: itemKey,
                version: this.selectedItem?.version,
                ...fullPayload,
              },
            ],
          },
        ];

        let lastError = '';
        for (const attempt of attempts) {
          try {
            const res = await fetch(attempt.url, {
              method: attempt.method,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(attempt.body),
            });

            let raw = '';
            let parsed = null;
            try {
              raw = await res.text();
              parsed = raw ? JSON.parse(raw) : null;
            } catch (e) {
              // no-op
            }

            if (res.ok) {
              return;
            }

            lastError =
              parsed?.error ||
              parsed?.message ||
              (typeof parsed === 'string' ? parsed : '') ||
              raw ||
              `API ${res.status}`;
          } catch (e) {
            lastError = e.message || String(e);
          }
        }

        throw new Error(lastError || 'Update failed');
      },

      applyMetadataToLocalState(itemKey, payload) {
        const nextData = {
          ...(this.selectedItem?.data || {}),
          abstractNote: payload.abstractNote,
          tags: payload.tags,
        };

        if (this.selectedItem?.key === itemKey) {
          this.selectedItem = { ...this.selectedItem, data: nextData };
        }

        this.items = this.items.map((item) => {
          if (item.key !== itemKey) return item;
          return {
            ...item,
            data: {
              ...item.data,
              abstractNote: payload.abstractNote,
              tags: payload.tags,
            },
          };
        });
      },

      async refreshTagCloud() {
        try {
          const tagsR = await this.apiFetch('/tags?format=json');
          this.allTags = tagsR.data
            .map((t) => ({ tag: t.tag, count: t.meta?.numItems || 0 }))
            .sort((a, b) => b.count - a.count);
          this.topTags = this.showAllTags ? this.allTags : this.allTags.slice(0, 40);
        } catch (e) {
          // no-op
        }
      },

      async saveItemMetadataToZotero() {
        if (!this.selectedItem?.key || this.metadataSaving) return;

        const itemKey = this.selectedItem.key;
        const payload = this.buildMetadataPayload();

        this.metadataSaving = true;
        this.chatError = '';
        try {
          await this.updateItemWithFallbacks(itemKey, payload);
          this.applyMetadataToLocalState(itemKey, payload);
          await this.refreshTagCloud();
          this.showToast(
            this.aiLanguage === 'en' ? 'Metadata synced to Zotero' : "Metadata Zotero'ya senkronize edildi"
          );
        } catch (e) {
          this.chatError =
            (this.aiLanguage === 'en'
              ? 'Metadata sync error: '
              : 'Metadata senkronizasyon hatası: ') + e.message;
          this.showToast(
            this.aiLanguage === 'en'
              ? 'Metadata could not be saved'
              : 'Metadata kaydedilemedi'
          );
        } finally {
          this.metadataSaving = false;
        }
      },
    };
  });
})(window);

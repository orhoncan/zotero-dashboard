(function (window) {
  const ns = window.ZoteroDashboard;

  ns.registerMixin(function registerMetadata() {
    return {
      metadataUndoEntry(item = this.selectedItem) {
        const itemKey = String(item?.key || '').trim();
        if (!itemKey || !item?.data) return null;
        const tags = Array.isArray(item.data.tags) ? item.data.tags : [];
        return {
          itemKey,
          abstractNote: String(item.data.abstractNote || '').trim(),
          tags: tags
            .map((entry) => String(entry?.tag || '').trim())
            .filter(Boolean)
            .map((tag) => ({ tag })),
          savedAt: Date.now(),
        };
      },

      normalizeMetadataTagArray(tags) {
        const seen = new Set();
        const normalized = [];
        (Array.isArray(tags) ? tags : []).forEach((entry) => {
          const value = String(entry?.tag || '').trim();
          if (!value) return;
          const key = this.normalizeText(value);
          if (seen.has(key)) return;
          seen.add(key);
          normalized.push(value);
        });
        return normalized.sort((a, b) => a.localeCompare(b, this.localeCode || 'tr'));
      },

      metadataPayloadEqual(left, right) {
        const a = left || {};
        const b = right || {};
        const abstractA = String(a.abstractNote || '').trim();
        const abstractB = String(b.abstractNote || '').trim();
        if (abstractA !== abstractB) return false;
        const tagsA = this.normalizeMetadataTagArray(a.tags || []);
        const tagsB = this.normalizeMetadataTagArray(b.tags || []);
        if (tagsA.length !== tagsB.length) return false;
        return tagsA.every((tag, idx) => tag === tagsB[idx]);
      },

      pushMetadataUndoEntry(entry) {
        if (!entry?.itemKey) return;
        const next = [...(this.metadataUndoStack || []), entry];
        const max = Math.max(3, Number(this.metadataUndoLimit || 20));
        this.metadataUndoStack = next.slice(-max);
      },

      hasMetadataUndoForSelectedItem() {
        const key = String(this.selectedItem?.key || '').trim();
        if (!key) return false;
        return (this.metadataUndoStack || []).some((entry) => entry?.itemKey === key);
      },

      popMetadataUndoForSelectedItem() {
        const key = String(this.selectedItem?.key || '').trim();
        if (!key) return null;
        const stack = [...(this.metadataUndoStack || [])];
        for (let idx = stack.length - 1; idx >= 0; idx -= 1) {
          if (stack[idx]?.itemKey !== key) continue;
          const [entry] = stack.splice(idx, 1);
          this.metadataUndoStack = stack;
          return entry;
        }
        return null;
      },

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

        const updatedItems = this.items.map((item) => {
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
        if (typeof this.setItems === 'function') {
          this.setItems(updatedItems);
        } else {
          this.items = updatedItems;
        }
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
        const previous = this.metadataUndoEntry(this.selectedItem);

        this.metadataSaving = true;
        this.chatError = '';
        try {
          await this.updateItemWithFallbacks(itemKey, payload);
          this.applyMetadataToLocalState(itemKey, payload);
          if (previous && !this.metadataPayloadEqual(previous, payload)) {
            this.pushMetadataUndoEntry(previous);
          }
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

      async undoLastMetadataChange() {
        if (!this.selectedItem?.key || this.metadataSaving) return;
        const entry = this.popMetadataUndoForSelectedItem();
        if (!entry) {
          this.showToast(this.aiLanguage === 'en' ? 'No metadata change to undo' : 'Geri alınacak metadata değişikliği yok');
          return;
        }

        const itemKey = this.selectedItem.key;
        const payload = {
          abstractNote: String(entry.abstractNote || ''),
          tags: (entry.tags || []).map((row) => ({ tag: String(row?.tag || '').trim() })).filter((row) => row.tag),
        };

        this.metadataSaving = true;
        this.chatError = '';
        try {
          await this.updateItemWithFallbacks(itemKey, payload);
          this.applyMetadataToLocalState(itemKey, payload);
          this.syncMetadataEditorFromSelectedItem();
          await this.refreshTagCloud();
          this.showToast(this.aiLanguage === 'en' ? 'Metadata change undone' : 'Metadata değişikliği geri alındı');
        } catch (e) {
          this.pushMetadataUndoEntry(entry);
          this.chatError =
            (this.aiLanguage === 'en'
              ? 'Metadata undo error: '
              : 'Metadata geri alma hatası: ') + e.message;
          this.showToast(
            this.aiLanguage === 'en'
              ? 'Metadata undo failed'
              : 'Metadata geri alınamadı'
          );
        } finally {
          this.metadataSaving = false;
        }
      },
    };
  });
})(window);

# Orhon'un Zotero Paneli

Orhon'un Zotero Paneli, Zotero kütüphanenizi tek ekranda taramanızı, PDF açmanızı, AI ile analiz yapmanızı ve notları Zotero veya Obsidian'a geri yazmanızı sağlayan masaüstü uygulamasıdır.

## Ne işe yarar?

- Koleksiyon ve makaleleri listeler, arama ve filtreleme yapar.
- PDF, özet, etiket, not ve annotation bilgilerini gösterir.
- Claude, Codex veya Gemini ile akademik analiz üretir.
- AI çıktılarını not editöründe biriktirir ve Zotero/Obsidian'a kaydeder.

## Gerekli olanlar

- `Zotero Desktop` açık olmalı
- En az bir AI aracı kurulu olmalı:
  - `claude`
  - `codex`
  - `gemini`

Not:
- Uygulamanın içinde yerleşik `Zotero Bridge` bulunur.
- Son kullanıcı için ayrıca `Node.js` veya `zotero-mcp` kurmanız gerekmez.

## Kurulum

## macOS

Release sayfasından şunlardan birini indirin:

- `.dmg`
- `.zip`

Önerilen yol:

1. `.dmg` dosyasını açın.
2. Uygulamayı `Applications` klasörüne sürükleyin.
3. `Zotero Desktop` uygulamasını açın.
4. `Orhon's Zotero Dashboard.app` dosyasını açın.

## Windows

Release sayfasından şunlardan birini indirin:

- `Setup.exe`
- portable `.exe`

Önerilen yol:

1. `Setup.exe` dosyasını çalıştırın.
2. Kurulum bittikten sonra uygulamayı açın.
3. `Zotero Desktop` uygulamasını açın.

Portable sürüm kullanıyorsanız doğrudan `.exe` dosyasını açabilirsiniz.

## İlk kullanım

1. Zotero'yu açın.
2. Dashboard'u açın.
3. Sol panelden bir makale seçin.
4. Sağdaki `AI Analiz` sekmesinden sağlayıcıyı seçin.
5. Hızlı butonlardan birini kullanın veya soru yazın.
6. Yanıt not editörüne eklenir.
7. İsterseniz Zotero'ya veya Obsidian'a kaydedin.

## Sık sorunlar

**Zotero'ya bağlanamıyor**

- Zotero Desktop'ın açık olduğundan emin olun.
- Sağ üstteki kontrol panelini kontrol edin.
- Zotero'da Gelişmiş Ayarlar sekmesinde diğer uygulamaların erişebileceğinin seçili olduğuna emin olun.

**AI sağlayıcı görünmüyor**

- `claude --version`, `codex --version` veya `gemini --version` komutunu terminalde test edin.
- Gerekirse uygulamadaki kontrol panelinden CLI yolunu tanımlayın.

**PDF içeriği sınırlı görünüyor**

- PDF'nin Zotero'da ekli ve indekslenmiş olduğundan emin olun.
- Gerekirse PDF'yi Zotero içinde açıp kısa süre bekleyin.

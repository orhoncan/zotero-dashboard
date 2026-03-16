# Orhon'un Zotero Paneli (Türkçe)

Bu proje, Zotero kütüphanenizi web arayüzünden yönetmenizi sağlayan bir paneldir.

Kısa özet:
- Zotero öğelerini ve koleksiyonlarını listeler.
- PDF görüntüler, not/annotation gösterir.
- AI analiz (Claude/Codex/Gemini CLI) yapar.
- AI çıktısını düzenleyip Zotero notu olarak kaydeder.
- AI notlarını Obsidian klasörüne senkronize eder.
- Paketli uygulamada yerleşik Zotero köprüsü kullanır.

## 1. Bu uygulama ne yapar?

Orhon'un Zotero Paneli ile:
- Kütüphanedeki öğeleri arayabilir ve filtreleyebilirsiniz.
- Bir makalenin detaylarını, etiketlerini, özetini görebilirsiniz.
- PDF açıp Zotero Reader bağlantısı üzerinden annotation senkron akışı kullanabilirsiniz.
- AI Analiz sekmesinde hızlı özet, kritik değerlendirme, not analizi gibi istekler gönderebilirsiniz.
- AI çıktısını alttaki not editörüne biriktirip:
  - Zotero'ya not olarak kaydedebilirsiniz.
  - Obsidian'a `.md` dosyası olarak gönderebilirsiniz.

## 2. Gerekli araçlar

## Zorunlu
- Node.js 18+ (öneri: 20+)
- Zotero Desktop (açık olmalı)
- AI CLI araçlarından en az biri:
  - Claude CLI
  - Codex CLI
  - Gemini CLI

Not:
- Üçü birden zorunlu değildir, en az bir AI CLI yeterlidir.
- Arayüzde self-check paneli hangi araçların çalıştığını gösterir.

## İsteğe bağlı
- Obsidian (not senkronu kullanacaksanız)

## 3. Kurulum (macOS)

1. Proje klasörünü indirin/klonlayın.
2. Terminali proje klasöründe açın:

```bash
cd /path/to/zotero-dashboard
```

3. Bağımlılıkları yükleyin:

```bash
npm install
```

4. Araçları doğrulayın:

```bash
node --version
npm --version
claude --version    # varsa
codex --version     # varsa
gemini --version    # varsa
```

5. Zotero Desktop uygulamasını açın.
6. Sunucuyu başlatın:

```bash
npm start
```

7. Tarayıcıda açın:
- [http://localhost:8080](http://localhost:8080)

## 4. Kurulum (Windows)

1. Proje klasörünü indirin/klonlayın.
2. PowerShell veya CMD'yi proje klasöründe açın:

```powershell
cd C:\path\to\zotero-dashboard
```

3. Bağımlılıkları yükleyin:

```powershell
npm install
```

4. Araçları doğrulayın:

```powershell
node --version
npm --version
claude --version    # varsa
codex --version     # varsa
gemini --version    # varsa
```

5. Zotero Desktop uygulamasını açın.
6. Sunucuyu başlatın:

```powershell
npm start
```

7. Tarayıcıda açın:
- [http://localhost:8080](http://localhost:8080)

## 5. Electron Masaüstü (macOS/Windows)

Tek kod tabanı ile masaüstü uygulama üretebilirsiniz.

- Geliştirme modunda Electron başlatma:

```bash
npm run app
```

- macOS paket alma (`.dmg` + `.zip`):

```bash
npm run dist:mac
```

- Windows paket alma (`.exe` NSIS + portable):

```powershell
npm run dist:win
```

Not: Windows paketi en sorunsuz şekilde Windows makinede üretilir.
Çıktılar `dist/` klasörüne yazılır.

## 6. İlk kullanım (çok temel)

1. Sol panelden bir koleksiyon veya öğe seçin.
2. Sağ panelde:
   - `Detay` sekmesinde metadata, özet, etiketler görünür.
   - `AI Analiz` sekmesinde sağlayıcı/model seçilir.
3. Hızlı butonlardan birine basın (`Özetle`, `Notları Analiz Et` vb.).
4. Yanıt gelince not editöründe metin birikir.
5. İsterseniz:
   - `Zotero'ya Senkronize Et`
   - `Obsidian'a Senkronize Et`

## 7. Obsidian senkronu

- İlk senkron sırasında klasör istenir.
- Daha sonra klasör ikonundan değiştirilebilir.
- Dosya adı formatı:
  - `makale-adı-yıl.md`

## 8. Önemli ayarlar (opsiyonel)

Komutlar otomatik bulunmazsa ortam değişkeni tanımlayabilirsiniz:

- `ZOTERO_MCP_COMMAND`
- `ZOTERO_STORAGE_DIR`
- `CLAUDE_COMMAND`
- `CODEX_COMMAND`
- `GEMINI_COMMAND`

## 9. Sık karşılaşılan sorunlar

## "Zotero'ya Bağlanılamadı"
- Zotero Desktop açık mı kontrol edin.
- Uygulamayı `npm start` (veya `node server.mjs`) ile tekrar başlatın.

## "CLI bulunamadı"
- İlgili CLI kurulumu/PATH ayarı eksik olabilir.
- Terminalde `--version` komutlarını test edin.

## "Unexpected token '<' ... is not valid JSON"
- Yanlış server/endpoint dönüyor olabilir.
- Dashboard sunucusunu yeniden başlatın.

## 10. Uygulama adı

- Türkçe: **Orhon'un Zotero Paneli**
- English: **Orhon's Zotero Dashboard**

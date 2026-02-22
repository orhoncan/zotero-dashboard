# Orhon'un Zotero Paneli (Türkçe)

Bu proje, Zotero kütüphanenizi web arayüzünden yönetmenizi sağlayan bir paneldir.

- Zotero öğelerini ve koleksiyonlarını listeler.
- PDF görüntüler, not/annotation gösterir.
- AI analiz (Claude/Codex/Gemini CLI) yapar. **En az bir tanesi yüklü olmalı, giriş yapmış olmanız gerekli. API şart değil.**
- AI çıktısını düzenleyip Zotero notu olarak kaydeder.
- AI notlarını Obsidian klasörüne senkronize eder.
- Zotero erişimi için `zotero-mcp` kullanır. (https://github.com/kujenga/zotero-mcp)

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
- Python 3 (öneri: 3.10+)
- Zotero Desktop (açık olmalı)
- `zotero-mcp` (Zotero araç erişimi için)
- AI CLI araçlarından en az biri:
  - Claude CLI
  - Codex CLI
  - Gemini CLI

Not:
- Üçü birden zorunlu değildir, en az bir AI CLI yeterlidir. Başlangıçta kontrol edip devam etmesi için yeterli.
- Arayüzde self-check paneli hangi araçların çalıştığını gösterir.

## İsteğe bağlı
- Obsidian (not senkronu kullanacaksanız)

## 3. Kurulum (macOS)

1. Proje klasörünü indirin/klonlayın.
2. Terminali proje klasöründe açın:

```bash
cd /path/to/zotero-dashboard
```

3. Araçları doğrulayın:

```bash
python3 --version
zotero-mcp --help
claude --version    # varsa
codex --version     # varsa
gemini --version    # varsa
```

4. Zotero Desktop uygulamasını açın.
5. Sunucuyu başlatın:

```bash
python3 serve.py
```

6. Tarayıcıda açın:
- [http://localhost:8080](http://localhost:8080)

## 4. Kurulum (Windows)

1. Proje klasörünü indirin/klonlayın.
2. PowerShell veya CMD'yi proje klasöründe açın:

```powershell
cd C:\path\to\zotero-dashboard
```

3. Araçları doğrulayın:

```powershell
py -3 --version
zotero-mcp --help
claude --version    # varsa
codex --version     # varsa
gemini --version    # varsa
```

4. Zotero Desktop uygulamasını açın.
5. Sunucuyu başlatın:

```powershell
py -3 serve.py
```

6. Tarayıcıda açın:
- [http://localhost:8080](http://localhost:8080)

## 5. İlk kullanım (çok temel)

1. Sol panelden bir koleksiyon veya öğe seçin.
2. Sağ panelde:
   - `Detay` sekmesinde metadata, özet, etiketler görünür.
   - `AI Analiz` sekmesinde sağlayıcı/model seçilir.
3. Hızlı butonlardan birine basın (`Özetle`, `Notları Analiz Et` vb.).
4. Yanıt gelince not editöründe metin birikir.
5. İsterseniz:
   - `Zotero'ya Senkronize Et`
   - `Obsidian'a Senkronize Et`

## 6. Obsidian senkronu

- İlk senkron sırasında klasör istenir.
- Daha sonra klasör ikonundan değiştirilebilir.
- Dosya adı formatı:
  - `makale-adı-yıl.md`

## 7. Önemli ayarlar (opsiyonel)

Komutlar otomatik bulunmazsa ortam değişkeni tanımlayabilirsiniz:

- `ZOTERO_MCP_COMMAND`
- `ZOTERO_STORAGE_DIR`
- `CLAUDE_COMMAND`
- `CODEX_COMMAND`
- `GEMINI_COMMAND`

## 8. Sık karşılaşılan sorunlar

## "Zotero'ya Bağlanılamadı"
- Zotero Desktop açık mı kontrol edin.
- Uygulamayı `python3 serve.py` / `py -3 serve.py` ile tekrar başlatın.

## "CLI bulunamadı"
- İlgili CLI kurulumu/PATH ayarı eksik olabilir.
- Terminalde `--version` komutlarını test edin.

## "Unexpected token '<' ... is not valid JSON"
- Yanlış server/endpoint dönüyor olabilir.
- Dashboard sunucusunu yeniden başlatın.

## 9. Uygulama adı

- Türkçe: **Orhon'un Zotero Paneli**
- English: **Orhon's Zotero Dashboard**


# Zotero Dashboard Kılavuzu

## 1) Hızlı Başlatma
1. Terminal aç.
2. Proje klasörüne gir:

```bash
cd /Users/orhon/zotero-dashboard
```

3. Sunucuyu başlat:

```bash
python3 serve.py
```

4. Tarayıcıda aç:

```text
http://localhost:8080
```

Not: Zotero Desktop açık olmalı.

## 2) Arka Planda Çalıştırma
Terminali kapatsan da çalışsın istiyorsan:

```bash
cd /Users/orhon/zotero-dashboard
nohup python3 serve.py > /tmp/zotero-dashboard.log 2>&1 & echo $!
```

## 3) Durdurma
Önce PID bul:

```bash
lsof -iTCP:8080 -sTCP:LISTEN -n -P
```

Sonra durdur:

```bash
kill <PID>
```

## 4) Yeniden Başlatma

```bash
PID=$(lsof -tiTCP:8080 -sTCP:LISTEN)
[ -n "$PID" ] && kill "$PID"
cd /Users/orhon/zotero-dashboard
nohup python3 serve.py > /tmp/zotero-dashboard.log 2>&1 & echo $!
```

## 5) Log İzleme

```bash
tail -f /tmp/zotero-dashboard.log
```

## 6) Sık Hata: `Unexpected token '<', "<!DOCTYPE"...`
Bu genelde API endpoint'i yerine HTML döndüğü anlamına gelir (çoğunlukla eski/yanlış server süreci).

Çözüm:
1. 8080'deki süreci durdur.
2. `python3 serve.py` ile tekrar başlat.
3. Tarayıcıda hard refresh yap.

## 7) Obsidian Klasörü
- İlk `Sync to Obsidian` işleminde klasör yolu istenir.
- Sonradan not editörü altındaki klasör ikonundan değiştirilebilir.


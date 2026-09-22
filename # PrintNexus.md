# PrintNexus

**One Dashboard, All Printers.**

SASA Endüstri 4.0 bünyesinde, üretim süreçlerinin dijitalleştirilmesi kapsamında geliştirilen merkezi 3D yazıcı filosu yönetim panelidir. 5 farklı markadan **20 yazıcıyı** tek bir arayüzden izlemeyi, kontrol etmeyi, kameralarını canlı izlemeyi ve üretim/maliyet kayıtlarını tutmayı sağlar.

> Bu proje bir yaz stajı kapsamında (Temmuz–Ağustos 2026) geliştirilmiştir. Önceki adı **PrintHQ**'dur; kod içinde ve bazı dosya/klasör isimlerinde bu eski isme hâlâ rastlanabilir.

---

## İçindekiler

1. [Proje Hakkında](#proje-hakkında)
2. [Özellikler](#özellikler)
3. [Yazıcı Filosu](#yazıcı-filosu)
4. [Mimari](#mimari)
5. [Klasör Yapısı](#klasör-yapısı)
6. [Teknoloji Yığını](#teknoloji-yığını)
7. [Kurulum](#kurulum)
8. [Ortam Değişkenleri (.env)](#ortam-değişkenleri-env)
9. [Veritabanı Şeması](#veritabanı-şeması)
10. [Kimlik Doğrulama & Yetkilendirme (RBAC)](#kimlik-doğrulama--yetkilendirme-rbac)
11. [Şifremi Unuttum Akışı](#şifremi-unuttum-akışı)
12. [API Uçları](#api-uçları)
13. [Kamera Streaming Mimarisi](#kamera-streaming-mimarisi)
14. [Frontend Sayfaları](#frontend-sayfaları)
15. [Üretim Kayıtları & Maliyet Modülü](#üretim-kayıtları--maliyet-modülü)
16. [Electron Masaüstü Uygulaması](#electron-masaüstü-uygulaması)
17. [Bilinen Sorunlar & Sorun Giderme](#bilinen-sorunlar--sorun-giderme)
18. [Güvenlik Notları](#güvenlik-notları)
19. [Geliştirme Sırasında Öğrenilen Dersler](#geliştirme-sırasında-öğrenilen-dersler)
20. [Yol Haritası](#yol-haritası)

---

## Proje Hakkında

SASA Endüstri 4.0 departmanı, üretim süreçlerini robotik, otomasyon, 3D baskı ve kestirimci bakım (predictive maintenance) alanlarında dijitalleştirmeyi hedefliyor. Bu kapsamda şirket içinde dağınık halde bulunan **20 adet 3D yazıcı**, farklı üreticilerin kendi kapalı yazılımları/arayüzleri üzerinden ayrı ayrı yönetiliyordu. PrintNexus bu yazıcıların tamamını **tek bir web panelinde** birleştirir:

- Anlık durum (idle / printing / paused / error / offline)
- Sıcaklık, ilerleme yüzdesi, kalan süre, katman bilgisi
- Uzaktan kontrol (başlat / duraklat / devam et / durdur)
- Canlı kamera görüntüsü (marka bazında farklı yöntemlerle)
- Üretim & maliyet kaydı (filament, elektrik, işçilik → kâr/zarar hesabı)
- Kullanıcı bazlı yetkilendirme (admin / operator / viewer)

Proje iki stajyer (Serra & Başak) tarafından, proje yöneticisi **Halil**, kod incelemesi/mentorluk için **Sezgin**, proje desteği için **Yetkin**, yazıcı odası teknik desteği için **Tolga** ve **Mustafa** ile birlikte geliştirilmiştir.

---

## Özellikler

- 🖨️ **Tek panelden 20 yazıcı** — 5 marka, tek arayüz
- 📡 **Gerçek zamanlı güncelleme** — WebSocket ile anlık durum yayını
- 🎥 **Canlı kamera** — markaya göre HLS (Bambu, ZAXE) veya MJPEG proxy (Ultimaker, Guider)
- 🔐 **Rol bazlı erişim (RBAC)** — admin / operator / viewer, IP maskeleme, denetim (audit) kaydı
- 🔑 **Güvenli şifre sıfırlama** — güvenlik kelimesi + admin onayı ile, e-posta gerektirmeden
- 📊 **Analitik & raporlama** — marka bazında sıcaklık/başarı/verimlilik grafikleri, Excel dışa aktarım
- 💰 **Üretim kayıt & maliyet modülü** — filament + elektrik + işçilik maliyeti, kâr/zarar, canlı USD/TRY kuru
- 🖥️ **Electron masaüstü uygulaması** — tarayıcı gerekmeden bağımsız pencere
- 🌗 **Koyu/açık tema**
- 📄 **"Hakkında" sayfası** — animasyonlu SVG yol haritası, ekip kartları, proje zaman çizelgesi

---

## Yazıcı Filosu

| Marka | Adet | Model | Protokol | Port |
|---|---|---|---|---|
| Bambu Lab | 9 | X1 Carbon | MQTT (MQTTS) + RTSPS kamera | 8883 (MQTT), 322 (kamera) |
| ZAXE | 4 | X4 | WebSocket (durum) + raw H.264 TCP (kamera) | 9294 (WS), 5002 (kamera) |
| Ultimaker | 2 | S5 | HTTP/REST (`/api/v1`) | 80 |
| Raise3D | 4 | Pro3 | HTTP/REST (imzalı istekler) | 10800 |
| FlashForge | 1 | Guider 2S | TCP soket (Flashforge protokolü) + MJPEG kamera | 8899 (kontrol), 8080 (kamera) |
| **Toplam** | **20** | | | |

Yazıcı envanteri `printers.json` dosyasında tutulur; IP/kimlik bilgileri bu dosyada **`${DEĞİŞKEN_ADI}`** placeholder'ları olarak tanımlıdır ve sunucu açılışında `.env` dosyasından okunup yerine konur (bkz. [Ortam Değişkenleri](#ortam-değişkenleri-env)).

---

## Mimari

```
┌─────────────────────────┐        MQTT / WS / HTTP / TCP        ┌──────────────────┐
│   public/ (Frontend)     │                                       │  Fiziksel Yazıcılar│
│  index.html + app.js     │◄──── WebSocket (canlı durum) ────────┤  (5 marka, 20 adet)│
│  analysis.html/.js       │                                       └──────────────────┘
│  uretim-kayitlari.html   │                                                ▲
│  login.html / about.html │                                                │
└───────────┬──────────────┘                                                │
            │ REST (JWT ile)                                                │
            ▼                                                               │
┌─────────────────────────┐        createAdapter()          ┌───────────────┴────────┐
│      server.js           │◄────────────────────────────────┤  adapters/               │
│  Express + WebSocketServer│    (adapters/index.js fabrikası) │  base.js (soyut sınıf)  │
│  RBAC middleware          │                                  │  bambu.js / ultimaker.js│
│  HLS/MJPEG kamera proxy   │                                  │  raise3d.js / guider.js │
│  Üretim & maliyet API'leri│                                  │  zaxe.js                │
└───────────┬──────────────┘                                  └─────────────────────────┘
            │ better-sqlite3
            ▼
┌─────────────────────────┐
│      database.js          │
│  printers.db (SQLite)     │
└───────────────────────────┘
```

**Akış:**
1. `server.js` açılışta `printers.json` + `.env`'i okuyup her yazıcı için uygun **adapter**'ı (`adapters/index.js` → `createAdapter()`) oluşturur.
2. Her adapter kendi protokolüyle (MQTT/WS/HTTP/TCP) yazıcıya bağlanır ve `PrinterAdapter` (base.js) sınıfının standart arayüzüne (`connect()`, `getStatus()`, `sendCommand()`) uyar — böylece server.js hangi markayla konuştuğunu bilmek zorunda kalmaz.
3. `startPolling()` her adapter için periyodik olarak durumu okur, `database.js` üzerinden `telemetry`/`events` tablolarına yazar ve değişiklik varsa WebSocket üzerinden tüm bağlı istemcilere `broadcast()` eder.
4. Frontend (`app.js`) WebSocket mesajlarını dinleyip arayüzü günceller; ayrıca REST API ile geçmiş veri, analitik ve komut gönderimi yapar.
5. Kamera görüntüleri ayrı bir kanaldan akar: Bambu ve ZAXE için sunucu tarafında sürekli çalışan **FFmpeg → HLS** süreçleri (`public/streams/*.m3u8`), Ultimaker ve Guider için ise istek bazlı **MJPEG proxy**.

---

## Klasör Yapısı

```
PrintNexus/
├── server.js                  # Ana Express sunucusu — tüm REST API + WebSocket + kamera proxy
├── database.js                 # better-sqlite3 katmanı — şema + tüm sorgular
├── printers.json               # Yazıcı envanteri (.env placeholder'larıyla)
├── package.json
├── package-lock.json
├── .gitignore
├── .env                        # ⚠️ Git'e girmez — elle oluşturulmalı (bkz. aşağı)
├── printers.db                 # SQLite veritabanı — server.js'in AKTİF olarak kullandığı dosya
│
├── adapters/                   # Marka bazlı yazıcı sürücüleri (adapter pattern)
│   ├── index.js                 # createAdapter(config) fabrika fonksiyonu
│   ├── base.js                  # PrinterAdapter — soyut temel sınıf
│   ├── bambu.js                 # Bambu Lab — MQTT + üretim verisi çıkarımı (extractPrintData)
│   ├── ultimaker.js             # Ultimaker — REST /api/v1, salt-okunur (komut desteklemiyor)
│   ├── raise3d.js               # Raise3D — imzalı REST login (SHA1→MD5 signature)
│   ├── guider.js                 # FlashForge Guider — TCP soket, G-code benzeri komutlar
│   └── zaxe.js                  # ZAXE — WebSocket event tabanlı durum + kamera frame
│
├── electron/                    # Masaüstü uygulaması sarmalayıcısı
│   ├── main.cjs                  # Electron ana süreç — server.js'i child process olarak başlatır
│   └── preload.cjs               # contextBridge — sınırlı electronAPI expose eder
│
├── public/                      # Statik frontend + Express static kökü
│   ├── index.html                # Ana panel (Genel Bakış / Filo / Analitik sekmeleri)
│   ├── app.js                    # Ana panel mantığı — auth, WebSocket, grafikler, yazıcı kartları
│   ├── login.html                # Giriş ekranı + "Şifremi Unuttum" modalı
│   ├── analysis.html             # Marka bazlı detaylı analitik sayfası
│   ├── analysis.js                # analysis.html mantığı
│   ├── uretim-kayitlari.html     # Üretim kaydı formu + maliyet hesaplama + rapor/export
│   ├── about.html                 # "Hakkında" sayfası (SVG yol haritası, ekip, Matrix rain animasyonu)
│   ├── style.css                  # Tüm sayfalar için ortak stil (CSS değişkenleri, tema)
│   ├── streams/                   # HLS (.m3u8/.ts) dosyaları — RUNTIME'DA OTOMATİK oluşur/temizlenir
│   ├── images/                    # Statik görseller (yazıcı odası fotoğrafı vb.)
│   └── uploads/                   # multer hedef klasörü (şu an boş — bkz. Bilinen Sorunlar)
│
└── node_modules/                 # (git'e girmez)
```

> Kök dizindeki tek seferlik test/keşif script'leri (`bambu-test.js`, `test-zaxe-ws.js` vb.) bu tabloya dahil edilmemiştir — bunlarla ilgili öneriler ayrı bir mesajda iletildi.

---

## Teknoloji Yığını

| Katman | Teknoloji |
|---|---|
| Backend | Node.js (ES Modules), Express.js |
| Veritabanı | SQLite (`better-sqlite3`) |
| Kimlik doğrulama | JSON Web Token (`jsonwebtoken`) — access (8s) + refresh (30g) token |
| Gerçek zamanlı iletişim | `ws` (WebSocketServer) |
| Yazıcı protokolleri | `mqtt` (Bambu), `ws` (ZAXE), Node `net` (Guider), `fetch` (Ultimaker/Raise3D) |
| Kamera / video | `fluent-ffmpeg` + `@ffmpeg-installer/ffmpeg` (RTSP/raw H.264 → HLS), `hls.js` (istemci tarafı oynatıcı) |
| Frontend | Vanilla JavaScript, Chart.js (grafikler), Lucide Icons |
| Excel içe/dışa aktarım | `xlsx` |
| Dosya yükleme | `multer` |
| Masaüstü paketleme | Electron.js (`.cjs` — ES module çakışmalarını önlemek için) |
| E-posta (planlanan) | `nodemailer` (paket kurulu, henüz bir akışta kullanılmıyor) |

---

## Kurulum

### Gereksinimler
- Node.js 18+ (native `fetch` ve `Readable.fromWeb` kullanılıyor)
- npm
- Yazıcıların bulunduğu ağa erişim (şirket içi LAN)
- FFmpeg'e **ayrıca ihtiyaç yok** — `@ffmpeg-installer/ffmpeg` paketiyle otomatik geliyor

### Adımlar

```bash
# 1. Bağımlılıkları kur
npm install

# 2. .env dosyasını oluştur (bkz. bir sonraki bölüm) ve proje kök dizinine koy

# 3. Sunucuyu başlat
npm start
# → node server.js  (varsayılan olarak http://localhost:3000)
```

### Electron (masaüstü) modunda çalıştırma

```bash
npm run dev          # electron . → server.js'i arka planda başlatıp pencere açar
npm run build:win    # Windows için .exe paketler (electron-builder, NSIS installer)
```

İlk açılışta `initializeDefaultUsers()` üç demo kullanıcı oluşturur (bkz. [RBAC](#kimlik-doğrulama--yetkilendirme-rbac)) — **üretime almadan önce bu şifreler mutlaka değiştirilmelidir.**

---

## Ortam Değişkenleri (.env)

`.env` dosyası proje kök dizininde olmalı ve `.gitignore` içinde zaten hariç tutulmuş durumda. `printers.json` içindeki `${DEĞİŞKEN}` placeholder'ları, sunucu açılışında `loadPrintersConfig()` fonksiyonu tarafından burada tanımlanan değerlerle değiştirilir.

**⚠️ Bir yazıcı panelde görünmüyorsa veya "çevrimdışı" görünüyorsa ilk kontrol edilecek yer buradaki IP/şifre/access code değerleridir.**

### Genel sunucu ayarları

| Değişken | Açıklama | Varsayılan |
|---|---|---|
| `PORT` | Sunucunun dinleyeceği port | `3000` |
| `HOST` | Bind edilecek arayüz | `0.0.0.0` |
| `JWT_SECRET` | JWT imzalama anahtarı — **prod'da mutlaka değiştirin** | `printfarm-secret-2025` (güvensiz fallback) |

### Bambu Lab (9 adet — MQTT access code + IP)

```
BAMBU_8_IP=          BAMBU_8_CODE=
BAMBU_9_IP=          BAMBU_9_CODE=
BAMBU_10_IP=         BAMBU_10_CODE=
BAMBU_11_IP=         BAMBU_11_CODE=
BAMBU_12_IP=         BAMBU_12_CODE=
BAMBU_18_IP=         BAMBU_18_CODE=
BAMBU_19_IP=         BAMBU_19_CODE=
BAMBU_21_IP=         BAMBU_21_CODE=
BAMBU_22_IP=         BAMBU_22_CODE=
```
> Access code, yazıcı ekranında **LAN Only Mode** ayarından alınır. Kamera akışı için ayrıca yazıcının seri numarasına ihtiyaç olabilir ama bu şu an `printers.json`'da tutulmuyor — adapter, MQTT `report` topic'inden gelen ilk mesajdan seri numarayı otomatik öğreniyor (`bambu.js` → `connect()`).

### Ultimaker (2 adet — IP + kullanıcı/şifre)

```
ULTIMAKER_1_IP=      ULTIMAKER_1_USER=      ULTIMAKER_1_PASS=
ULTIMAKER_4_IP=      ULTIMAKER_4_USER=      ULTIMAKER_4_PASS=
```
> Not: `ultimaker.js` adapter'ı yalnızca **okuma (GET)** yapar; bu bilgiler şu an sadece kamera stream endpoint'inde (`/stream/ultimaker/:id`) kimlik doğrulaması bekleniyormuş gibi kontrol ediliyor ama okuma isteklerinin çoğu kimlik doğrulama istemiyor.

### Raise3D (4 adet — IP + API token)

```
RAISE3D_2_IP=        RAISE3D_2_TOKEN=
RAISE3D_5_IP=        RAISE3D_5_TOKEN=
RAISE3D_6_IP=        RAISE3D_6_TOKEN=
RAISE3D_7_IP=        RAISE3D_7_TOKEN=
```
> `raise3d.js` içinde `RAISE3D_x_TOKEN` aslında **login şifresi** olarak kullanılıyor (`config.auth.password`); adapter kendi içinde SHA1→MD5 imza üretip login oluyor. Değişken adı "TOKEN" olsa da girilecek değer yazıcı şifresidir.

### FlashForge Guider (1 adet — sadece IP, kimlik bilgisi yok)

```
GUIDER_13_IP=
```

### ZAXE (4 adet — IP + kullanıcı/şifre)

```
ZAXE_14_IP=          ZAXE_14_USER=          ZAXE_14_PASS=
ZAXE_15_IP=          ZAXE_15_USER=          ZAXE_15_PASS=
ZAXE_16_IP=          ZAXE_16_USER=          ZAXE_16_PASS=
ZAXE_17_IP=          ZAXE_17_USER=          ZAXE_17_PASS=
```
> Not: `zaxe.js` adapter'ı şu an bu kullanıcı adı/şifreyi WebSocket bağlantısında **kullanmıyor** (bağlantı `ws://IP:9294` ile doğrudan açılıyor, auth handshake yok). Değişkenler ileride kimlik doğrulama eklenirse diye `printers.json`'da hazır tutuluyor olabilir.

### Henüz `.env`'de olmayan ama ileride gerekecek değişkenler

Bir sonraki aşamada e-posta/SMTP entegrasyonu için şu değişkenlerin eklenmesi planlanıyor (henüz kodda kullanılmıyor):
```
SMTP_HOST=mail.sasa.com.tr
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
# veya alternatif: SendGrid ücretsiz katman
SENDGRID_API_KEY=
```

---

## Veritabanı Şeması

Veritabanı dosyası: **`printers.db`** (proje kökünde, `database.js` → `new Database("printers.db")`).

> ⚠️ `printhq.db` dosyası da yüklemede mevcut ama kodun hiçbir yerinde referans edilmiyor — muhtemelen eski isimlendirmeden (PrintHQ) kalma, artık kullanılmayan bir dosya. Silmeden önce içeriğini kontrol etmenizi öneririz (bkz. ayrı mesajdaki dosya önerileri).

| Tablo | Amaç | Önemli kolonlar |
|---|---|---|
| `users` | Giriş yapan kullanıcılar | `username`, `password_hash` (SHA256), `role`, `secure_word_hash` |
| `printers` | Yazıcı envanteri (runtime kaydı) | `id`, `type`, `ip`, `accessCode`, `username/password`, `serial` |
| `telemetry` | Periyodik durum kaydı (sıcaklık, ilerleme…) | `printer_id`, `timestamp`, `state`, `nozzle`, `bed`, `chamber`, `progress`, `remaining_seconds`, `error` |
| `events` | Durum değişimi / hata / bildirim geçmişi | `printer_id`, `user_id`, `type`, `message` |
| `commands` | Gönderilen uzaktan komutlar (start/pause/resume/stop) | `printer_id`, `user_id`, `command` |
| `prints` | Baskı kayıtları (eski tablo) | `printer_id`, `file_name`, `started_at`, `finished_at`, `duration_minutes` |
| `maintenance` | Bakım takibi | `printer_id`, `last_maintenance`, `maintenance_interval` (sn, varsayılan 30 gün) |
| `audit_log` | Kullanıcı işlemleri denetim izi (RBAC) | `user_id`, `username`, `action`, `detail`, `timestamp` |
| `production_records` | Üretim kaydı & maliyet modülü | `yazici_no`, `bolum`, `filament_turu/rengi/gramaji`, `calisma_suresi`, `filament_maliyeti`, `satinalma_maliyeti`, `uretim_maliyeti`, `toplam_kar`, `elektrik_saat_usd` |
| `password_reset_requests` | Admin onaylı şifre sıfırlama kuyruğu | `user_id`, `status` (pending/approved/rejected), `temp_password_hash`, `handled_by` |

İndeksler: `telemetry(printer_id, timestamp)`, `events(printer_id, timestamp)`, `users(username)`, `audit_log(timestamp)`, `production_records(tarih/yazici_no/bolum)`.

`cleanOldData()` fonksiyonu eski telemetri/olay kayıtlarını periyodik temizlemek için mevcuttur.

---

## Kimlik Doğrulama & Yetkilendirme (RBAC)

### Roller

| Rol | Yetki |
|---|---|
| `admin` | Her şey: kullanıcı yönetimi, yazıcı ekleme/silme, şifre sıfırlama onayı, audit log, gerçek IP görünürlüğü |
| `operator` | Yazıcı kontrolü (start/pause/resume/stop), gerçek IP görünürlüğü, rapor üretimi |
| `viewer` | Sadece izleme — komut gönderemez (`canControlPrinter` middleware'i engeller), IP adresleri maskelenir (`10.99.**.***`) |

### Demo kullanıcılar (ilk kurulumda otomatik oluşturulur)

| Kullanıcı adı | Şifre | Rol |
|---|---|---|
| `admin` | `admin` | admin |
| `operator` | `operator` | operator |
| `viewer` | `viewer` | viewer |

**Bu şifreler üretim ortamına geçmeden mutlaka değiştirilmelidir** (bkz. [Güvenlik Notları](#güvenlik-notları)).

### Token akışı

- Giriş (`POST /api/auth/login`) başarılı olursa **access token** (8 saat geçerli) ve **refresh token** (30 gün geçerli) döner.
- İstemci her istekte `Authorization: Bearer <token>` header'ı gönderir.
- Token süresi dolduğunda backend **401 + `TOKEN_EXPIRED`** kodu döner (bilinçli olarak 403 değil — istemci bunu görüp otomatik `POST /api/auth/refresh` çağırır, kullanıcı çıkışa zorlanmaz).
- Refresh token içinde sadece `{ id }` var; yeni access token üretilirken kullanıcının güncel rolü DB'den taze okunur (rol DB'de değişmişse eski token'a takılı kalınmaz).

### Diğer RBAC detayları

- `maskIP(ip, role)`: viewer rolü için IP adresinin son iki oktetini `**.***` ile gizler.
- `logAudit()`: kullanıcı silme, rol değişikliği, yazıcı silme, şifre sıfırlama onayı gibi kritik işlemler `audit_log` tablosuna yazılır → `GET /api/audit-log` (sadece admin) üzerinden izlenebilir.
- Frontend'de `toast()` fonksiyonu tüm eski `alert()` çağrılarının yerini almıştır.

---

## Şifremi Unuttum Akışı

E-posta/SMTP entegrasyonu henüz yapılmadığı için sistem **"güvenli kelime" + admin onayı** modeliyle çalışır:

1. Kullanıcı, Ayarlar → Hesabım bölümünden mevcut şifresiyle doğrulanıp kendine özel bir **güvenli kelime** belirler (`POST /api/auth/set-secure-word`).
2. Şifresini unutan kullanıcı, giriş ekranındaki "Şifremi Unuttum" modalından **kullanıcı adı + güvenli kelime** girer (`POST /api/auth/forgot-password`).
3. Bilgiler doğruysa `password_reset_requests` tablosuna `pending` bir kayıt düşer. **Hem doğru hem yanlış girişte kullanıcıya aynı jenerik mesaj döner** (`"Bilgiler doğruysa isteğiniz yöneticiye iletildi."`) — bu, kullanıcı adı enumerasyonuna (bir kullanıcı adının sistemde var olup olmadığının anlaşılmasına) karşı bilinçli bir korumadır.
4. Admin, panelden bekleyen istekleri görür (`GET /api/admin/reset-requests`) ve onaylar (`POST /api/admin/reset-requests/:id/approve`).
5. Onay anında **rastgele 10 haneli geçici şifre** üretilir (`crypto.randomBytes(5)`) ve **sadece admin'in ekranına** gösterilir — kullanıcıya güvenli bir kanaldan (telefon, yüz yüze) admin tarafından iletilmesi beklenir.
6. Admin isterse isteği reddedebilir de (`POST /api/admin/reset-requests/:id/reject`).

> Bu akış, gelecekte SMTP/e-posta entegrasyonu eklenirse (`mail.sasa.com.tr` veya SendGrid), 5. adımdaki "admin'e göster" kısmı "kullanıcıya e-posta gönder" ile değiştirilerek genişletilebilir; mevcut mimari buna zaten uygun (backend tarafı geçici şifreyi zaten üretiyor).

---

## API Uçları

Aksi belirtilmedikçe tüm `/api/*` uçları `Authorization: Bearer <token>` bekler. `(public)` işaretli uçlar kimlik doğrulama istemez.

### Kimlik Doğrulama
| Metod & Yol | Yetki | Açıklama |
|---|---|---|
| `POST /api/auth/login` | public | Giriş, access+refresh token döner |
| `POST /api/auth/logout` | public | — |
| `POST /api/auth/refresh` | public | Refresh token ile yeni access token |
| `POST /api/auth/forgot-password` | public | Güvenli kelime ile sıfırlama isteği oluşturur |
| `GET /api/auth/me` | auth | Oturumdaki kullanıcı bilgisi |
| `POST /api/auth/change-password` | auth | Kendi şifresini değiştirir |
| `POST /api/auth/set-secure-word` | auth | Güvenli kelime belirler/günceller |
| `GET /api/auth/secure-word-status` | auth | Kelime belirlenmiş mi? |

### Admin — Kullanıcı & Sistem Yönetimi
| Metod & Yol | Yetki | Açıklama |
|---|---|---|
| `GET/POST /api/users` | admin | Kullanıcı listele / oluştur |
| `PUT/DELETE /api/users/:userId` | admin | Kullanıcı güncelle / sil |
| `GET /api/audit-log` | admin | Denetim kaydı |
| `GET /api/admin/reset-requests` | admin | Bekleyen şifre sıfırlama istekleri |
| `POST /api/admin/reset-requests/:id/approve` \| `/reject` | admin | İstek onayla/reddet |

### Yazıcılar & Kontrol
| Metod & Yol | Yetki | Açıklama |
|---|---|---|
| `GET /api/printers` | auth | Marka bazında gruplanmış, role göre IP maskelenmiş liste |
| `GET /api/status` | public | Basit sağlık kontrolü (yazıcı sayısı) |
| `POST /api/printers` | admin | Yeni yazıcı ekle (adapter oluşturur, bağlanır, polling başlatır) |
| `DELETE /api/printers/:id` | admin | Yazıcı sil |
| `POST /api/command/:printerId` | auth (viewer hariç) | `start` \| `pause` \| `resume` \| `stop` |
| `GET /api/history/:printerId` | auth | Telemetri geçmişi |
| `GET /api/events/:printerId` | auth | Olay geçmişi |

### Yazıcı Analitiği
| Metod & Yol | Yetki | Açıklama |
|---|---|---|
| `GET /api/printer/:id/analytics` | auth | Genel analitik |
| `GET /api/printer/:id/monthly-breakdown` | auth | Aylık kırılım |
| `GET /api/printer/:id/errors` | auth | Hata geçmişi |
| `GET /api/analytics/telemetry[/:brand]` | auth | Sıcaklık verisi (son 6 saat) |
| `GET /api/analytics/printer-stats` | auth | Yazıcı istatistikleri |
| `GET /api/analytics/print-results[/:brand]` | auth | Başarı/başarısızlık oranları |
| `GET /api/analytics/efficiency/:brand` | auth | Verimlilik |
| `GET /api/analytics/report/:brand` | admin, operator | Rapor üretimi |
| `GET /api/analytics/printer-detail/:printerId` | auth | Yazıcı detay kartı verisi |

### Üretim Kayıtları & Maliyet
| Metod & Yol | Yetki | Açıklama |
|---|---|---|
| `POST /api/production/preview` | auth | Maliyeti kaydetmeden hesapla (canlı önizleme) |
| `POST /api/production/record` | auth | Kaydı oluştur |
| `DELETE /api/production/record/:id` | auth | Kaydı sil |
| `GET /api/production/records` | auth | Filtrelenebilir kayıt listesi |
| `GET /api/production/filter-options` | auth | Filtre için dropdown seçenekleri |
| `GET /api/production/monthly` \| `/by-printer` \| `/by-department` | auth | Özet raporlar |
| `GET /api/production/exchange-rate` | public | Güncel USD/TRY kuru |
| `GET /api/production/from-bambu/:printerId` | auth | Bambu yazıcısından otomatik üretim verisi çek |
| `GET /api/production/export` | auth | Excel (`.xlsx`) dışa aktarım |

### Kamera / Stream
| Metod & Yol | Yetki | Açıklama |
|---|---|---|
| `GET /stream/ultimaker/:printerId` | ⚠️ **public** | Ultimaker MJPEG proxy |
| `GET /stream/guider/:printerId` | ⚠️ **public** | Guider MJPEG proxy |
| `GET /streams/*.m3u8`, `*.ts` | ⚠️ **public** (static) | Bambu & ZAXE HLS dosyaları |

### Diğer
| Metod & Yol | Yetki | Açıklama |
|---|---|---|
| `POST /api/upload` | ⚠️ **public** | Dosya yükleme (multer, `./uploads` klasörü — `public/uploads` DEĞİL) |
| `GET /api/files` | ⚠️ **public** | Yüklenen dosyaları listeler |

> ⚠️ işaretli uçlar hakkında bkz. [Güvenlik Notları](#güvenlik-notları).

---

## Kamera Streaming Mimarisi

Her marka farklı bir kamera protokolü kullandığından, dört ayrı çözüm uygulanmıştır:

### Bambu Lab — HLS (sürekli çalışan FFmpeg)
- Kaynak: `rtsps://bblp:<ACCESS_CODE>@<IP>:322/streaming/live/1`
- Sunucu açılışında (`initializePrinters()` sonrası, 2sn gecikmeyle) her Bambu yazıcı için **kalıcı bir FFmpeg süreci** başlatılır (`startStream()`), RTSP'yi sürekli `public/streams/bambuX.m3u8` + `.ts` segmentlerine dönüştürür.
- İstemci tarafında `hls.js` bu `.m3u8` dosyasını oynatır.
- **8/9 stream çalışıyor** — `bambu11` yazıcısında 401/IP uyuşmazlığı hatası var (bkz. Sorun Giderme).

### ZAXE — HLS (Bambu ile aynı mimari, farklı kaynak)
- Kaynak: `tcp://<IP>:5002` üzerinden gelen **ham H.264** akışı (RTSP değil!) — `ffplay -f h264 -i tcp://IP:5002` ile doğrulanmış bir protokol.
- Bambu'daki gibi sunucu açılışında kalıcı FFmpeg süreci başlar (`startZaxeHls()`), `public/streams/zaxe_<id>.m3u8` üretir.
- ⚠️ **Kritik kısıtlama:** ZAXE yazıcı aynı anda **tek TCP bağlantısı** kabul ediyor ve ilk kareye ulaşmak ~4 saniye sürüyor. Bu yüzden "istek bazlı FFmpeg başlat/durdur" yaklaşımı çalışmıyordu (süreç ilk kareye varamadan kapanıyordu) — bu yüzden Bambu'daki kalıcı süreç mimarisi buraya da uygulandı.
- `-c:v copy` (yeniden kodlama yok, CPU dostu) denenir; 10 saniye içinde hiç veri gelmeden çökerse otomatik olarak `libx264` ile yeniden kodlamaya düşer.
- Süreç çöktüğünde diskteki eski `.m3u8`/`.ts` dosyaları **silinir** (`purgeHlsFiles()`) — aksi halde `hls.js` yazıcı kapalıyken bile saatler öncesinin görüntüsünü oynatmaya devam ediyordu.
- **Durum:** 14 ve 16 numaralı yazıcılar `.m3u8` üretiyor (çalışıyor); **17 numaralı yazıcı donanım/firmware sorunu nedeniyle erişilemez.**

### Ultimaker — MJPEG proxy (istek bazlı)
- `GET /stream/ultimaker/:printerId` önce `/api/v1/camera` endpoint'inden gerçek (dinamik portlu) stream URL'sini okur, sonra o URL'ye proxy açar.
- Kimlik bilgisi eksikse `400` döner ("Check .env variables") — panelde kamera açılmıyorsa ilk bakılacak yer `.env`'deki `ULTIMAKER_x_USER/PASS`.

### Guider — MJPEG proxy (istek bazlı, basit)
- Sabit URL: `http://<IP>:8080/?action=stream` — kimlik doğrulama gerektirmiyor.
- İstek koptuğunda upstream fetch de otomatik kapatılır (bellek/bağlantı sızıntısı olmasın diye).

### Genel notlar
- Sunucu her açılışta `public/streams/` klasöründeki eski `.ts`/`.m3u8` dosyalarını temizler (bayat görüntüyle başlanmasın diye).
- `/streams` static route'unda cache tamamen kapalıdır (`no-store, no-cache`) — aksi halde tarayıcı eski segment listesini önbellekten okuyup 404/eski görüntü sorunu yaratıyordu.
- Kapanışta (`shutdownGracefully()`) tüm ZAXE HLS süreçleri düzgünce sonlandırılır.

---

## Frontend Sayfaları

| Dosya | Görevi |
|---|---|
| `login.html` | Giriş ekranı + "Şifremi Unuttum" modalı |
| `index.html` + `app.js` | Ana panel — Genel Bakış (KPI kartları, filo grid'i), Filo (detaylı liste), Analitik (grafikler) sekmeleri; yazıcı detay modalı (başlat/duraklat/durdur, kamera, katman/sıcaklık geçmişi); kullanıcı yönetimi, yetki matrisi, ayarlar |
| `analysis.html` + `analysis.js` | Marka bazında ayrılmış (Ultimaker/Bambu/Raise3D/Guider/ZAXE sekmeleri), daha derin analitik ve raporlama sayfası |
| `uretim-kayitlari.html` | Üretim kaydı formu (Bambu için otomatik veri çekme dahil), maliyet hesaplama, kayıt listesi + filtreleme, Excel export, TL/USD para birimi geçişi |
| `about.html` | "Hakkında" sayfası — animasyonlu SVG proje yol haritası, marka/ekip/teknoloji kartları, yazıcı odası fotoğrafı, ekip kartlarında Matrix-tarzı canvas kod yağmuru animasyonu |
| `style.css` | Tüm sayfalarda ortak CSS — CSS custom properties ile açık/koyu tema |

Ortak frontend davranışları (`app.js`'de tanımlı, diğer sayfalarda benzer kopyaları var):
- `localStorage`: `token`, `refreshToken`, `user`, `theme` burada tutulur.
- `apiFetch()`: merkezi fetch sarmalayıcı — 401 aldığında otomatik `refreshAccessToken()` dener.
- `connectWebSocket()`: `ws://` veya `wss://` (protokole göre) bağlantısı, canlı durum güncellemeleri için.
- `toast()`: bildirim sistemi (eski `alert()` çağrılarının yerini aldı).
- `applyRoleBasedVisibility()`: role göre butonları/menüleri gizler-gösterir (viewer'da kontrol butonları yok).

---

## Üretim Kayıtları & Maliyet Modülü

`uretim-kayitlari.html` sayfası, bir baskının maliyetini ve kârını hesaplayıp kalıcı kayıt oluşturmayı sağlar. İki giriş yolu vardır:

1. **Manuel giriş** — yazıcı, bölüm, filament türü/rengi/gramajı, çalışma süresi, orijinal fiyat, proje bedeli elle girilir.
2. **Bambu'dan otomatik çekme** (`GET /api/production/from-bambu/:printerId`) — Bambu adapter'ının `extractPrintData()` metodu, MQTT'den gelen son baskı verisini (filament türü, kullanılan tepsi/AMS bilgisi, süre, katman sayısı vb.) okuyup formu otomatik doldurur. Yazıcıdan **yayınlanmayan** veriler (örn. filament gramajı — Bambu LAN modu bunu göndermiyor) elle girilmek üzere boş bırakılır ve kullanıcıya uyarı gösterilir.

### Maliyet formülü (`hesaplaUretimMaliyeti()`)
```
filament_maliyeti  = birim_fiyat($/kg) × gramaj(g) / 1000
satinalma_maliyeti = adet × orijinal_fiyat + proje_bedeli
uretim_maliyeti     = filament_maliyeti + (elektrik_$/saat × (çalışma_süresi_dk / 60))
toplam_kar          = satinalma_maliyeti − uretim_maliyeti
```
- Elektrik ücreti varsayılanı: **$0.09/saat** (kayıt bazında override edilebilir).
- USD/TRY kuru `api.exchangerate.host`'tan 6 saatte bir otomatik çekilir; API erişilemezse son bilinen kur (`45.07` fallback) kullanılır.
- Girdi doğrulama sunucu tarafında yapılır: negatif sayılar, tanınmayan filament türleri, geçersiz tarih formatı vb. `errors[]` dizisiyle reddedilir; şüpheli ama geçerli girdiler (örn. 10 günden uzun çalışma süresi) `warnings[]` olarak kullanıcıya gösterilir ama kaydı engellemez.
- `GET /api/production/export`: kayıtları filtreleyip `.xlsx` olarak indirir.

---

## Electron Masaüstü Uygulaması

`electron/main.cjs`:
1. `server.js`'i bir **child process** olarak başlatır (`spawn('node', ['../server.js'])`), `stdio: 'inherit'` ile loglar ana konsola akar.
2. 2 saniye bekleyip `BrowserWindow` açar, `http://localhost:3000`'i yükler.
3. `process.env.DEBUG` set edilmişse DevTools otomatik açılır.
4. Pencere kapanınca (`window-all-closed`) veya uygulama kapanırken (`before-quit`) arka plandaki Node sunucu süreci de sonlandırılır.

`electron/preload.cjs`: `contextIsolation: true` ile minimal bir `window.electronAPI` (platform, Node sürümü) expose eder — güvenlik için `nodeIntegration: false`.

Paketleme: `electron-builder`, hedef Windows NSIS installer (`npm run build:win`). `package.json` → `build.files` listesinde nelerin pakete dahil edileceği (server.js, database.js, adapters/, public/, node_modules/, *.db, .env) tanımlı — **`.env` doğrudan pakete dahil ediliyor**, bu dağıtım sırasında dikkat edilmesi gereken bir noktadır.

---

## Bilinen Sorunlar & Sorun Giderme

| Belirti | Muhtemel neden | Nereye bakılmalı |
|---|---|---|
| Bir yazıcı panelde "çevrimdışı" görünüyor | `.env`'deki IP/access code/token yanlış veya yazıcı ağda değil | `.env` dosyasındaki ilgili `_IP` / `_CODE` / `_TOKEN` / `_USER` / `_PASS` değişkeni |
| Bambu 11 kamerası açılmıyor | 401 / IP uyuşmazlığı (access code değişmiş olabilir) | `BAMBU_11_CODE` — yazıcı ekranından LAN Only Mode şifresini tekrar kontrol edin |
| ZAXE 17 hiç bağlanmıyor | Donanım/firmware sorunu (bilinen, çözülmemiş) | Yazıcı odası desteği (Tolga/Mustafa) — yazılımsal bir düzeltme değil |
| ZAXE kamerası donuyor / gecikmeli | Yazıcı tek TCP bağlantısı kabul ediyor; iki farklı istemci aynı anda bağlanmaya çalışıyor olabilir | Sunucu logunda `zaxe_<id>` FFmpeg mesajlarını kontrol edin; yazıcının kendi masaüstü uygulaması kapalı olmalı |
| Raise3D bağlanamıyor | Şifre yanlış (varsayılan `admin` fallback var) veya imza algoritması yazıcı firmware sürümüyle uyuşmuyor | `.env`'deki `RAISE3D_x_TOKEN` (gerçekte şifre) |
| Guider komutları gecikmeli/başarısız | TCP soket zaman aşımı (3sn) | `GUIDER_13_IP`, ağ gecikmesi |
| Yeni kullanıcı 403 alıyor ama token süresi dolmamış | Rol DB'de değişmiş ama eski access token hâlâ kullanılıyor olabilir | Kullanıcının çıkış yapıp tekrar giriş yapması veya `refresh` akışının tetiklenmesi |
| "Token geçersiz" hatası sürekli tekrarlıyor | `JWT_SECRET` sunucu yeniden başlatıldığında değişmiş (env'de tanımlı değilse rastgele fallback kullanılmıyor, sabit fallback var — ama birden fazla instance farklı .env ile çalışıyorsa tutarsızlık olur) | `.env`'de `JWT_SECRET`'ın sabit ve tüm ortamlarda aynı olduğundan emin olun |
| Dosya yükleme çalışıyor ama nereye gittiği belirsiz | `/api/upload` proje kökündeki `./uploads` klasörüne yazıyor, `public/uploads` **değil** | Kök dizinde otomatik oluşan `uploads/` klasörünü kontrol edin (bu, `public/uploads` ile karışmasın) |
| Sunucu kapanışında HLS dosyaları bozuk kalıyor | Beklenmedik kapanış (`kill -9` vb.) — `shutdownGracefully()` çalışamadan süreç ölmüş olabilir | Sunucuyu normal şekilde durdurun (Ctrl+C / `SIGTERM`); bir sonraki açılış zaten eski `.ts`/`.m3u8` dosyalarını temizliyor |

---

## Güvenlik Notları

Bunlar **eleştiri değil, öncelik sırasına konmuş bir yapılacaklar listesi** niteliğindedir — kalan ~6 günlük süreçte en yüksek öncelik bcrypt geçişidir.

1. **🔴 Şifre hash'leme — SHA256 (hızlı/brute-force'a açık).** `database.js` içindeki `hashPassword`, `createUser`, `loginUser` fonksiyonları hedef; **bcrypt'e geçiş en yüksek öncelik** (tahmini 6–9 saat).
2. **🟠 Kamera endpoint'leri kimlik doğrulama istemiyor** — `/stream/ultimaker/:id`, `/stream/guider/:id` ve `/streams/*` (statik HLS dosyaları) `authenticateToken` middleware'inden geçmiyor. Ağa erişimi olan herkes URL'yi bilirse kamerayı izleyebilir.
3. **🟠 `/api/upload` ve `/api/files` public** — kimlik doğrulama olmadan dosya yüklenebiliyor ve yüklenen dosyalar listelenebiliyor.
4. **🟡 Varsayılan demo kullanıcılar** (`admin/admin`, `operator/operator`, `viewer/viewer`) — üretime geçmeden önce mutlaka değiştirilmeli veya devre dışı bırakılmalı.
5. **🟡 `JWT_SECRET` için güvensiz fallback değeri var** (`printfarm-secret-2025`) — `.env`'de tanımlı değilse bu sabit değer kullanılıyor. `.env`'de mutlaka güçlü, rastgele bir değer tanımlanmalı.
6. **🟡 Electron paketine `.env` doğrudan dahil ediliyor** (`package.json` → `build.files`) — dağıtılan `.exe` içinde tüm yazıcı IP/şifreleri düz metin olarak bulunuyor. Dağıtım öncesi bu noktanın gözden geçirilmesi gerekir.
7. **🟢 Şifremi Unuttum akışı zaten iyi tasarlanmış** — enumeration koruması (aynı jenerik mesaj), admin onayı, geçici şifrenin ekrana değil sadece admin'e gösterilmesi doğru uygulanmış.
8. **🟢 Kök dizindeki bazı eski debug script'lerinde (silinmesi önerilenler arasında) yazıcı IP/erişim kodu düz metin olarak koda gömülü** — bu dosyalar git geçmişine girmeden temizlenmesi önemlidir (ayrı mesajdaki listeye bakın).

---

## Geliştirme Sırasında Öğrenilen Dersler

- **Mimari önce, uygulama sonra:** ZAXE kamera çözümü, üç farklı başarısız denemeden (istek bazlı FFmpeg, WebSocket üzerinden snapshot, MJPEG fetch parse etme) sonra Bambu ile aynı "kalıcı süreç + HLS" mimarisine geçilerek çözüldü.
- **Kök nedene inmek:** Bazı hataların yüzeysel çözümü yoktu — örn. `prefers-reduced-motion` medya sorgusunun kurumsal Windows makinelerinde animasyon döngülerini sessizce durdurması, `INSERT OR REPLACE`'in her yeniden başlatmada bakım tarihini sıfırlaması, `req.user.userId` / `req.user.id` JWT payload uyuşmazlığı gibi.
- **Regresyon riskine dikkat:** Değişiklikler mevcut davranışı bozmamalı; orijinal dosyalardan temiz başlangıç, üst üste yama biriktirmeye tercih edildi.
- **Gerçek veriyle çalışmak:** Uydurma istatistik/ekip ismi/zaman çizelgesi üretmek yerine önce gerçek proje bilgisi toplanıp sonra içerik üretilmesi kural haline getirildi (bu README de bu ilkeyle, kodun kendisinden çıkarılan bilgilerle yazıldı).

---

## Yol Haritası

Kalan süreçte önceliklendirilmiş işler:

1. **bcrypt migration** (en yüksek öncelik — güvenlik)
2. `.env.example` + bu README'nin (tamamlandı ✅) proje ile birlikte dağıtılması
3. E-posta/SMTP entegrasyonu (kurumsal `mail.sasa.com.tr` tercih ediliyor, alternatif: SendGrid ücretsiz katman) — şifremi unuttum akışını admin-onay modelinden e-posta bildirimine genişletmek için
4. Prod ortamına dağıtım (şu an yalnızca localhost) — en yüksek öncelikli altyapı maddesi olarak işaretlenmişti
5. Ertelenmiş ama not edilmiş: alarm/bildirim sistemi, e-posta/SMS uyarıları, analitik sekmesinin tamamlanması, veri dışa aktarımının genişletilmesi, yedekleme

---

*Bu README, proje dosyaları (server.js, database.js, adapters/, public/, printers.json) doğrudan incelenerek hazırlanmıştır; içerik kod ile birebir uyumludur.*
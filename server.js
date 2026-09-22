/**
 * 3D Printer Farm Control - Main Server
 * ES6, Database entegre, Adaptör pattern
 * FFmpeg RTSP → HLS streaming eklendi
 */

import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Readable } from "stream";
import { WebSocketServer } from "ws";
import { config } from "dotenv";
import jwt from "jsonwebtoken";
import multer from "multer";
import crypto from "crypto";

// FFmpeg imports ← EKLE
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';

// Excel export
import XLSX from 'xlsx';

// Database imports
import db, {
  initializeDefaultUsers,
  loginUser,
  getAllPrinters,
  getPrintersByType,
  savePrinter,
  deletePrinter,
  saveTelemetry,
  getTelemetryLast,
  saveEvent,
  getEventsLast,
  saveCommand,
  cleanOldData,
  getPrinterDetails,
  // ── RBAC ──
  hashPassword,
  getUserById,
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
  changePassword,
  logAudit,
  getAuditLog,
  getPrinterMonthlyStats,
  getPrinterErrorHistory,
  getPrinterUptime,
  getPrinterCostMetrics,
  initializeProductionRecords,
  insertProductionRecord,
  getProductionRecords,
  getMonthlyProductionSummary,
  getPrinterProductionSummary,
  getDepartmentProductionSummary,
  getProductionRecordById,
  deleteProductionRecord,
  getProductionFilamentTypes,
  getProductionMaterialNames,
  // ── GÜVENLİ KELİME + ADMİN ONAYLI RESET ──
  setSecureWord,
  hasSecureWord,
  requestPasswordReset,
  getPendingResetRequests,
  approveResetRequest,
  rejectResetRequest
} from "./database.js";

// Adaptör
import { createAdapter } from "./adapters/index.js";
import { ZaxeAdapter } from "./adapters/zaxe.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import os from "os";

// ═══════════════════════════════════════════════════════════════
// DATA KLASÖRÜ AYARI (config() ÖNCESI tanımlanmalı)
// ═══════════════════════════════════════════════════════════════
// Eğer printers.db veya uploads kurulum klasörüne yazı yapamıyorsa
// (Program Files gibi read-only konumlara kurulduysa), verileri
// %APPDATA%\PrintNexus klasörüne yazıyoruz.
const getDataPath = () => {
  const appDataPath = process.env.APPDATA || path.join(process.env.HOME || process.env.USERPROFILE, 'AppData', 'Roaming');
  const dataDir = path.join(appDataPath, 'PrintNexus');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
};

const DATA_PATH = getDataPath();
console.log('[DATA] Veri klasörü:', DATA_PATH);

// Şimdi config() çağırabiliyoruz
config({ path: path.join(DATA_PATH, '.env') }); // DATA_PATH'ten .env oku (exe uyumlu)

// FFmpeg path ayarla ← EKLE
ffmpeg.setFfmpegPath(ffmpegPath.path);

// Streams klasörü ← EKLE
const streamsDir = path.join(DATA_PATH, 'streams');
if (!fs.existsSync(streamsDir)) fs.mkdirSync(streamsDir, { recursive: true });

// 🧹 Açılışta ESKİ stream dosyalarını sil.
// Önceki oturumdan kalan .ts/.m3u8 dosyaları olmasa, sunucu yeni açıldığında
// modal'a tıklandığında hls.js diskteki bayat segmentleri oynatıyordu (eski görüntü).
// Her açılış temiz başlasın:
try {
  for (const f of fs.readdirSync(streamsDir)) {
    if (f.endsWith('.ts') || f.endsWith('.m3u8')) {
      try { fs.unlinkSync(path.join(streamsDir, f)); } catch (e) { /* sessiz */ }
    }
  }
  console.log('🧹 Eski stream dosyaları temizlendi (temiz başlangıç)');
} catch (e) { /* sessiz */ }

// ═══════════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════════

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const JWT_SECRET = process.env.JWT_SECRET || "printfarm-secret-2025";

app.use(express.json());
app.use(express.static("public"));

// HLS streams serve — CACHE KAPALI.
// .m3u8 manifesti sürekli değişiyor; tarayıcı cache'lerse eski segment
// listesini okur ve 404/eski görüntü olur. Her istekte taze oku:
app.use('/streams', express.static(streamsDir, {
  etag: false,
  lastModified: false,
  cacheControl: false,
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// ═══════════════════════════════════════════════════════════════
// RBAC MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ ok: false, error: 'Token yok. Giriş yapın.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.warn('❌ Token doğrulama hatası:', err.message);
      // ⚠️ KRİTİK: Kimlik doğrulama hatası 401 olmalı, 403 DEĞİL.
      // 401 = "kim olduğunu bilmiyorum"  → istemci token yenilemeli
      // 403 = "kim olduğunu biliyorum ama yetkin yok" → yenilemek işe yaramaz
      // Önceden burası 403 dönüyordu; istemci bunu "yetki yok" sanıp
      // token yenilemeyi hiç denemiyor, kullanıcıyı da çıkarmıyordu.
      return res.status(401).json({
        ok: false,
        code: err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
        error: 'Token geçersiz veya süresi dolmuş.'
      });
    }
    req.user = user;
    next();
  });
};

const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: 'Kullanıcı bilgisi yok.' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      console.warn(`❌ Rol kontrolü başarısız: ${req.user.role} yetkisi yok`);
      return res.status(403).json({
        ok: false,
        error: `Bu işlem için '${allowedRoles.join(', ')}' rolü gereklidir.`,
        yourRole: req.user.role
      });
    }

    next();
  };
};

const canControlPrinter = (req, res, next) => {
  if (req.user.role === 'viewer') {
    return res.status(403).json({
      ok: false,
      error: 'İzleyiciler yazıcı kontrolü yapamaz.'
    });
  }
  next();
};

function maskIP(ip, role) {
  if (!ip) return '***.***.***.**';
  
  if (['admin', 'operator'].includes(role)) {
    return ip;
  }
  
  const parts = ip.split('.');
  if (parts.length !== 4) return ip;
  return `${parts[0]}.${parts[1]}.**.***`;
}

// 🎬 ULTIMAKER MJPEG STREAM PROXY
app.get('/stream/ultimaker/:printerId', async (req, res) => {
  try {
    const printerId = decodeURIComponent(req.params.printerId);
    
    // ✅ printers.json'dan oku (.env variables doğru resolve olur)
    const config = loadPrintersConfig();
    const ultimakerPrinters = config.ultimaker || [];
    const printer = ultimakerPrinters.find(p => p.id === printerId);
    
    if (!printer) {
      return res.status(404).json({ error: 'Printer not found' });
    }
    
    if (!printer.auth || !printer.auth.username || !printer.auth.password) {
      return res.status(400).json({ error: 'Printer auth credentials missing. Check .env variables' });
    }
    
    const streamUrl = `http://${printer.ip}/api/v1/camera/feed`;
    
    console.log(`🎬 Ultimaker stream başlatılıyor: ${printerId}`);
    console.log(`   📍 Kamera bilgisi alınıyor: ${streamUrl}`);
    
    // ✅ /api/v1/camera'dan gerçek stream URL'sini oku (dinamik port)
    const cameraInfo = await fetch(`http://${printer.ip}/api/v1/camera`);
    const cameraData = await cameraInfo.json();
    const actualStreamUrl = cameraData.feed;
    
    console.log(`   📍 Gerçek Stream URL: ${actualStreamUrl}`);
    
    const response = await fetch(actualStreamUrl);
    
    console.log(`   📊 Response Status: ${response.status}`);
    console.log(`   📋 Content-Type: ${response.headers.get('content-type')}`);
    console.log(`   📏 Content-Length: ${response.headers.get('content-length')}`);
    
    if (!response.ok) {
      console.error(`   ❌ Stream failed: ${response.statusText}`);
      return res.status(response.status).send('Stream unavailable');
    }
    
    res.setHeader('Content-Type', response.headers.get('content-type'));
    res.setHeader('Cache-Control', 'no-cache');
    
    // ✅ Node.js 18+ uyumlu: Web Stream → Node Stream dönüşümü
    const nodeStream = Readable.fromWeb(response.body);
    nodeStream.pipe(res);
  } catch (error) {
    console.error('Ultimaker stream error:', error);
    res.status(500).send('Stream error');
  }
});

// 🎬 GUIDER MJPEG STREAM PROXY
// Guider 2S port 8080'de MJPEG yayınlıyor.
// Ultimaker deseninin basitleştirilmiş hâli: auth yok, sabit URL.
// ⚠️ CANLILK: Her istek yeni bir bağlantı açar, tarayıcı kapatılınca
//    node-fetch stream'i de kapanır → sunucuda bayat veri birikmez.
//    Cache-Control: no-cache + Pragma: no-cache başlıkları ekleniyor.
app.get('/stream/guider/:printerId', async (req, res) => {
  try {
    const printerId = decodeURIComponent(req.params.printerId);

    // ✅ printers.json'dan oku (.env değişkenleri doğru resolve olur)
    const config = loadPrintersConfig();
    const guiderPrinters = config.guider || [];
    const printer = guiderPrinters.find(p => p.id === printerId);

    if (!printer) {
      return res.status(404).json({ error: 'Printer not found' });
    }

    const streamUrl = `http://${printer.ip}:8080/?action=stream`;
    console.log(`🎬 Guider stream başlatılıyor: ${printerId}`);
    console.log(`   📍 MJPEG: ${streamUrl}`);

    const response = await fetch(streamUrl);

    console.log(`   📊 Response Status: ${response.status}`);
    console.log(`   📋 Content-Type: ${response.headers.get('content-type')}`);

    if (!response.ok) {
      console.error(`   ❌ Stream failed: ${response.statusText}`);
      return res.status(response.status).send('Stream unavailable');
    }

    // ✅ Canlı MJPEG için cache tamamen kapatılıyor
    res.setHeader('Content-Type', response.headers.get('content-type'));
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    // ✅ Node.js 18+ uyumlu: Web Stream → Node Stream dönüşümü
    const nodeStream = Readable.fromWeb(response.body);
    nodeStream.pipe(res);

    // ✅ Tarayıcı bağlantıyı koparınca upstream fetch'i de temizle
    req.on('close', () => {
      try { nodeStream.destroy(); } catch (e) { /* sessiz */ }
    });
  } catch (error) {
    console.error('Guider stream error:', error);
    if (!res.headersSent) res.status(500).send('Stream error');
  }
});

// ═══════════════════════════════════════════════════════════════
// 🎬 ZAXE KAMERA — HLS (Bambu ile aynı mimari)
// ═══════════════════════════════════════════════════════════════
// Zaxe X4 port 5002'de RAW H.264 yayınlıyor (ffplay ile doğrulandı):
//   ffplay.exe -fflags nobuffer -flags low_delay -f h264 -i tcp://IP:5002
//
// ⚠️ ÖNEMLİ: Yazıcı aynı anda TEK TCP bağlantısı kabul ediyor ve FFmpeg'in
//    ilk kareye ulaşması ~4 saniye sürüyor. Bu yüzden tarayıcı her bağlandığında
//    FFmpeg başlatıp kopunca öldürmek İŞE YARAMIYOR (süreç ilk kareye varamadan
//    ölüyordu). Bambu'daki gibi: FFmpeg sunucu açılışında başlar, sürekli çalışır,
//    HLS dosyalarına yazar. Tarayıcı sadece /streams/*.m3u8 dosyalarını indirir.

// Sunucu kapanırken yeniden başlatma zamanlayıcıları tetiklenmesin
let hlsShuttingDown = false;

/**
 * Bayat HLS dosyalarını sil.
 * ⚠️ KRİTİK: FFmpeg öldüğünde .m3u8 ve .ts dosyaları diskte kalıyor.
 * hls.js bu dosyaları indirip oynatmaya devam ediyor — yazıcı kapalıyken
 * bile ekranda saatler/günler önceki görüntü görünüyordu. Süreç ölünce
 * dosyaları siliyoruz ki oynatılacak bayat veri kalmasın.
 */
function purgeHlsFiles(streamName) {
  try {
    // Segment adları: <isim><sayı>.ts  → başka yazıcının dosyasına dokunmamak
    // için tam desen kullanıyoruz (örn. "bambu1" öneki "bambu10..." ile eşleşmesin)
    const seg = new RegExp('^' + streamName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\d*\\.ts$');
    for (const f of fs.readdirSync(streamsDir)) {
      if (f === `${streamName}.m3u8` || seg.test(f)) {
        try { fs.unlinkSync(path.join(streamsDir, f)); } catch (e) { /* sessiz */ }
      }
    }
    console.log(`   🧹 ${streamName}: bayat HLS dosyaları silindi`);
  } catch (err) {
    console.warn(`   ⚠️  ${streamName}: HLS temizliği başarısız — ${err.message}`);
  }
}

function zaxeStreamName(printerId) {
  return 'zaxe_' + String(printerId).replace(/[^a-zA-Z0-9]/g, '_');
}

const zaxeHls = {};   // streamName -> { ff }

function startZaxeHls(printerId, ip, useCopy = true) {
  const name = zaxeStreamName(printerId);
  if (zaxeHls[name] && zaxeHls[name].ff) return;   // zaten çalışıyor

  const hlsPath = path.join(streamsDir, `${name}.m3u8`);

  // Kaynak zaten H.264 → "copy" ile yeniden kodlama yok (CPU ~0).
  // copy hızlıca çökerse otomatik olarak yeniden kodlamaya düşülür.
  const videoOpts = useCopy
    ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '2000k', '-maxrate', '2500k', '-bufsize', '4000k',
       // Yeniden kodlarken her 2sn'de keyframe → segmentler tam 2sn olur.
       // (copy modunda gerek yok; kaynak kendi keyframe'lerini üretiyor.)
       '-force_key_frames', 'expr:gte(t,n_forced*2)'];

  const args = [
    '-nostdin',           // ← Bambu'da doğrulanan kök neden çözümü — Windows'ta
                          //   ffmpeg Node'dan spawn edilince konsol kontrol
                          //   işleyicisini bekleyip tıkanabiliyordu.
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-f', 'h264',
    '-i', `tcp://${ip}:5002`,
    '-an',
    ...videoOpts,
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '10',
    '-hls_flags', 'delete_segments+independent_segments+omit_endlist',
    hlsPath
  ];

  console.log(`🎬 ${name} başlatılıyor (tcp://${ip}:5002${useCopy ? '' : ', yeniden kodlama'})`);
  const ff = spawn(ffmpegPath.path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  zaxeHls[name] = { ff };

  const startedAt = Date.now();
  let running = false;

  ff.stderr.on('data', (chunk) => {
    const msg = chunk.toString();
    if (!running && msg.includes('Input #0')) {
      running = true;
      console.log(`✅ ${name} çalışıyor`);
    }
    if (msg.includes('failed') && msg.includes('Connection to')) {
      console.warn(`⚠️  ${name}: yazıcıya bağlanılamadı (kamera kapalı olabilir)`);
    }
  });

  ff.on('error', (err) => {
    console.error(`❌ ${name} spawn hatası: ${err.message}`);
  });

  ff.on('close', (code) => {
    zaxeHls[name] = null;

    // Bayat segmentleri sil — yoksa yazıcı kapalıyken eski görüntü oynatılır
    purgeHlsFiles(name);

    if (hlsShuttingDown) return;

    // "copy" 10 saniye içinde ve hiç çalışmadan çöktüyse yeniden kodlamaya düş
    const failedFast = !running && (Date.now() - startedAt) < 10000;
    const nextCopy = failedFast ? false : useCopy;
    console.warn(`⚠️  ${name} durdu (code ${code}) — 15sn sonra tekrar denenecek`);
    setTimeout(() => startZaxeHls(printerId, ip, nextCopy), 15000);
  });
}

function stopAllZaxeHls() {
  for (const name of Object.keys(zaxeHls)) {
    const st = zaxeHls[name];
    if (st && st.ff) {
      try { st.ff.kill('SIGKILL'); } catch (e) { /* sessiz */ }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// YAZICI BAZLI ANALİTİK ROUTES (YENİ)
// ═══════════════════════════════════════════════════════════════

app.get('/api/printer/:id/analytics', authenticateToken, (req, res) => {
  try {
    const printerId = decodeURIComponent(req.params.id);
    const details = getPrinterDetails(printerId);
    if (!details) {
      return res.status(404).json({ ok: false, error: 'Yazıcı bulunamadı' });
    }
    const monthlyStats = getPrinterMonthlyStats(printerId);
    const errorHistory = getPrinterErrorHistory(printerId);
    const uptime = getPrinterUptime(printerId);
    const costMetrics = getPrinterCostMetrics(printerId);

    res.json({
      ok: true,
      data: {
        printer: details.printer,
        stats: details.stats,
        analytics: { monthly: monthlyStats, errors: errorHistory, uptime, costs: costMetrics }
      }
    });
  } catch (err) {
    console.error('[API] Printer analytics hatası:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/printer/:id/monthly-breakdown', authenticateToken, (req, res) => {
  try {
    const printerId = decodeURIComponent(req.params.id);
    const monthlyStats = getPrinterMonthlyStats(printerId);
    const formatted = (monthlyStats || []).map(m => ({
      month: m.month,
      working_hours: m.working_hours || 0,
      success_rate: m.success_rate || 0,
      error_count: m.error_records || 0,
      total_telemetry: m.telemetry_count || 0
    }));
    res.json({ ok: true, data: formatted });
  } catch (err) {
    console.error('[API] Monthly breakdown hatası:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/printer/:id/errors', authenticateToken, (req, res) => {
  try {
    const printerId = decodeURIComponent(req.params.id);
    const limit = req.query.limit ? parseInt(req.query.limit) : 50;
    const errorHistory = getPrinterErrorHistory(printerId);
    res.json({ ok: true, data: errorHistory.slice(0, limit), total: errorHistory.length });
  } catch (err) {
    console.error('[API] Error history hatası:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ÜRETİM KAYITLARI ROUTES (YENİ)
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// ÜRETİM MALİYET HESABI — Excel "2026 YILI" formüllerinin birebir karşılığı
// ───────────────────────────────────────────────────────────────
//  J (Gramaja Göre Maliyet) = VLOOKUP(tür, V:W) * gramaj / 1000
//  P (Satınalma Maliyeti)   = adet * orijinal_fiyat + proje_bedeli
//  Q (Üretim Maliyeti)      = J + (elektrik_saat_usd * (dakika / 60))
//  R (Toplam Kâr)           = P - Q
//
//  Elektrik ücreti ($/saat) artık SABİT DEĞİL — kullanıcı formdan girer.
//  Varsayılan: 0.09 (Excel V13 hücresindeki değer). Boş bırakılırsa bu
//  varsayılan kullanılır; kayıtla birlikte veritabanına da yazılır ki
//  geçmiş kayıtlar o anda hangi ücretle hesaplandığını korusun.
// ═══════════════════════════════════════════════════════════════

const ELEKTRIK_SAAT_VARSAYILAN = 0.09;   // $/saat — Excel V13 hücresi

// Excel V:W tablosu ($/kg). Anahtarlar normalize edilir (Excel'de "CF15 " sonunda boşluklu)
const FILAMENT_FIYAT = {
  PLA: 8.3, ABS: 8.3, PETG: 8.3, TPU: 15.97,
  PC: 23.41, ASA: 14.7, EPA: 58, CF15: 100, EPC: 20
};

/** Filament türünü normalize et — boşluk/küçük harf hatalarına dayanıklı */
function normalizeFilament(t) {
  if (t === null || t === undefined) return '';
  return String(t).trim().toUpperCase().replace(/\s+/g, '');
}

/** Kullanıcı girdisini güvenle sayıya çevirir. "12,5"→12.5 | "abc"→null | ""→null */
function parseNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let str = String(v).trim();
  if (str === '') return null;
  str = str.replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d*\.?\d+$/.test(str)) return null;   // harf/sembol varsa reddet
  const n = parseFloat(str);
  return Number.isFinite(n) ? n : null;
}

/**
 * Üretim kaydını doğrular ve maliyetleri hesaplar.
 * @returns {{ok:boolean, errors:string[], warnings:string[], values:object}}
 */
function hesaplaUretimMaliyeti(body) {
  const errors = [];
  const warnings = [];

  const yazici_no = (body.yazici_no ?? '').toString().trim();
  const bolum     = (body.bolum ?? '').toString().trim();
  if (!yazici_no) errors.push('Yazıcı seçilmedi.');
  if (!bolum)     errors.push('Bölüm seçilmedi.');

  let tarih = (body.tarih ?? '').toString().trim();
  if (!tarih) {
    tarih = new Date().toISOString().split('T')[0];
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(tarih) || Number.isNaN(Date.parse(tarih))) {
    errors.push('Tarih geçersiz (YYYY-AA-GG olmalı).');
  }

  const sayisal = [
    ['adet',             body.adet,             1,    'Adet'],
    ['filament_gramaji', body.filament_gramaji, 0,    'Filament gramajı'],
    ['calisma_suresi',   body.calisma_suresi,   0,    'Çalışma süresi'],
    ['orijinal_fiyati',  body.orijinal_fiyati,  0,    'Orijinal fiyat'],
    ['proje_bedeli',     body.proje_bedeli,     0,    'Proje bedeli'],
    ['elektrik_saat_usd', body.elektrik_saat_usd, ELEKTRIK_SAAT_VARSAYILAN, 'Elektrik ücreti']
  ];
  const num = {};
  for (const [key, raw, varsayilan, etiket] of sayisal) {
    if (raw === null || raw === undefined || String(raw).trim() === '') { num[key] = varsayilan; continue; }
    const parsed = parseNum(raw);
    if (parsed === null)      { errors.push(`${etiket} sayı olmalı ("${raw}" girildi).`); num[key] = varsayilan; }
    else if (parsed < 0)      { errors.push(`${etiket} negatif olamaz (${parsed} girildi).`); num[key] = varsayilan; }
    else                      { num[key] = parsed; }
  }
  if (num.adet === 0) errors.push('Adet 0 olamaz.');
  if (num.calisma_suresi > 14400) warnings.push('Çalışma süresi 10 günden uzun görünüyor — dakika cinsinden mi girildi?');
  if (num.elektrik_saat_usd > 5) warnings.push(`Elektrik ücreti $${num.elektrik_saat_usd}/saat çok yüksek görünüyor — kontrol edin.`);

  let masraf_kodu = null;
  if (body.masraf_kodu !== null && body.masraf_kodu !== undefined && String(body.masraf_kodu).trim() !== '') {
    const mk = parseNum(body.masraf_kodu);
    if (mk === null) errors.push('Masraf kodu sayı olmalı.');
    else masraf_kodu = Math.trunc(mk);
  }

  const turRaw  = body.filament_turu ?? '';
  const turNorm = normalizeFilament(turRaw);
  let birimFiyat = 0;
  if (turNorm === '') {
    if (num.filament_gramaji > 0) errors.push('Gramaj girildi ama filament türü seçilmedi.');
  } else if (FILAMENT_FIYAT[turNorm] === undefined) {
    errors.push(`Filament türü tanınmadı: "${turRaw}". Geçerli türler: ${Object.keys(FILAMENT_FIYAT).join(', ')}`);
  } else {
    birimFiyat = FILAMENT_FIYAT[turNorm];
    if (num.filament_gramaji === 0) warnings.push('Filament gramajı 0 girildi — filament maliyeti $0 hesaplandı.');
  }

  // ── EXCEL FORMÜLLERİ ──
  const filament_maliyeti  = birimFiyat * num.filament_gramaji / 1000;                              // J
  const satinalma_maliyeti = num.adet * num.orijinal_fiyati + num.proje_bedeli;                     // P
  const uretim_maliyeti    = filament_maliyeti + (num.elektrik_saat_usd * (num.calisma_suresi / 60));   // Q
  const toplam_kar         = satinalma_maliyeti - uretim_maliyeti;                                   // R

  if (toplam_kar < 0) warnings.push('Toplam kâr negatif — orijinal fiyat girilmemiş olabilir.');

  const yuvarla = (n) => Math.round(n * 10000) / 10000;

  return {
    ok: errors.length === 0,
    errors, warnings,
    values: {
      tarih, yazici_no, bolum, masraf_kodu,
      malzeme_ismi:      (body.malzeme_ismi  ?? '').toString().trim().slice(0, 300),
      adet:              num.adet,
      filament_turu:     turNorm || null,
      filament_rengi:    (body.filament_rengi ?? '').toString().trim().slice(0, 100),
      filament_gramaji:  num.filament_gramaji,
      calisma_suresi:    num.calisma_suresi,
      orijinal_fiyati:   num.orijinal_fiyati,
      proje_bedeli:      num.proje_bedeli,
      siniflandirma:     (body.siniflandirma ?? 'DIĞER').toString().trim() || 'DIĞER',
      aciklama:          (body.aciklama ?? '').toString().trim().slice(0, 1000),
      filament_maliyeti:  yuvarla(filament_maliyeti),
      satinalma_maliyeti: yuvarla(satinalma_maliyeti),
      uretim_maliyeti:    yuvarla(uretim_maliyeti),
      toplam_kar:         yuvarla(toplam_kar),
      elektrik_saat_usd:  yuvarla(num.elektrik_saat_usd)
    }
  };
}

let exchangeRate = 45.07;
let lastRateUpdate = Date.now();

async function fetchExchangeRate() {
  try {
    const response = await fetch('https://api.exchangerate.host/latest?base=USD&symbols=TRY');
    const data = await response.json();
    if (data && data.rates && data.rates.TRY) {
      exchangeRate = data.rates.TRY;
      lastRateUpdate = Date.now();
      console.log(`[PROD] Kur güncellendi: 1 USD = ${exchangeRate.toFixed(2)} TL`);
    }
  } catch (err) {
    console.warn(`[PROD] Kur API hatası, fallback: ${exchangeRate}`);
  }
}
fetchExchangeRate();
setInterval(fetchExchangeRate, 6 * 60 * 60 * 1000);

app.post('/api/production/record', authenticateToken, (req, res) => {
  try {
    // Maliyetler DAİMA sunucuda hesaplanır — tarayıcıdan gelen tutarlara güvenilmez.
    const hesap = hesaplaUretimMaliyeti(req.body || {});
    if (!hesap.ok) {
      return res.status(400).json({ ok: false, error: hesap.errors[0], errors: hesap.errors, warnings: hesap.warnings });
    }
    const result = insertProductionRecord({ ...hesap.values, kullanici_id: req.user?.id || 1 });
    res.status(201).json({
      ok: true, id: result.id,
      hesaplanan: {
        filament_maliyeti:  hesap.values.filament_maliyeti,
        satinalma_maliyeti: hesap.values.satinalma_maliyeti,
        uretim_maliyeti:    hesap.values.uretim_maliyeti,
        toplam_kar:         hesap.values.toplam_kar,
        elektrik_saat_usd:  hesap.values.elektrik_saat_usd
      },
      warnings: hesap.warnings
    });
  } catch (err) {
    console.error('[Üretim Kaydı]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Kaydetmeden hesabı önizle — form canlı hesaplama için kullanır (tek doğru kaynak: sunucu)
app.post('/api/production/preview', authenticateToken, (req, res) => {
  try {
    const hesap = hesaplaUretimMaliyeti(req.body || {});
    res.json({
      ok: hesap.ok, errors: hesap.errors, warnings: hesap.warnings,
      hesaplanan: {
        filament_maliyeti:  hesap.values.filament_maliyeti,
        satinalma_maliyeti: hesap.values.satinalma_maliyeti,
        uretim_maliyeti:    hesap.values.uretim_maliyeti,
        toplam_kar:         hesap.values.toplam_kar,
        elektrik_saat_usd:  hesap.values.elektrik_saat_usd
      },
      kur: exchangeRate
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ÜRETİM KAYDI SİL
app.delete('/api/production/record/:id', authenticateToken, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Geçersiz kayıt numarası' });

    const kayit = getProductionRecordById(id);
    if (!kayit) return res.status(404).json({ ok: false, error: 'Kayıt bulunamadı' });

    const sonuc = deleteProductionRecord(id);
    if (!sonuc.deleted) return res.status(500).json({ ok: false, error: 'Kayıt silinemedi' });

    try {
      logAudit(req.user?.id || null, 'production_record_delete',
        `Üretim kaydı silindi #${id} (${kayit.yazici_no} / ${kayit.tarih})`);
    } catch (e) { /* audit opsiyonel */ }

    res.json({ ok: true, id, silinen: kayit });
  } catch (err) {
    console.error('[Üretim Sil]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Filtre seçenekleri: kayıtlarda geçen malzeme adları + filament türleri
app.get('/api/production/filter-options', authenticateToken, (req, res) => {
  try {
    res.json({ ok: true, filamentTurleri: getProductionFilamentTypes(), malzemeIsimleri: getProductionMaterialNames() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/production/records', authenticateToken, (req, res) => {
  try {
    const filters = {
      tarih_baslangic: req.query.tarih_baslangic,
      tarih_bitis: req.query.tarih_bitis,
      yazici_no: req.query.yazici_no,
      bolum: req.query.bolum,
      filament_turu: req.query.filament_turu,
      malzeme_ismi: req.query.malzeme_ismi
    };
    const records = getProductionRecords(filters);
    res.json({ records, count: records.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/production/monthly', authenticateToken, (req, res) => {
  try {
    const year = req.query.year || 2026;
    const monthly = getMonthlyProductionSummary(year);
    const result = monthly.map(m => ({
      ay: m.ay,
      kayitSayisi: m.kayit_sayisi,
      uretimAdet: m.toplam_adet || 0,
      calismaSaati: (m.toplam_saat || 0).toFixed(1),
      maliyet: {
        filamentUSD: (m.filament_maliyeti_toplam || 0).toFixed(2),
        satinalmaMaliyetUSD: (m.satinalma_maliyeti_toplam || 0).toFixed(2),
        uretimMaliyetUSD: (m.uretim_maliyeti_toplam || 0).toFixed(2),
        karUSD: (m.kar_toplam || 0).toFixed(2),
        filamentTL: (m.filament_maliyeti_toplam * exchangeRate || 0).toFixed(0),
        satinalmaMaliyetTL: (m.satinalma_maliyeti_toplam * exchangeRate || 0).toFixed(0),
        uretimMaliyetTL: (m.uretim_maliyeti_toplam * exchangeRate || 0).toFixed(0),
        karTL: (m.kar_toplam * exchangeRate || 0).toFixed(0)
      }
    }));
    res.json({ kur: exchangeRate.toFixed(2), kurGuncellenme: new Date(lastRateUpdate).toISOString(), aylarOzet: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/production/by-printer', authenticateToken, (req, res) => {
  try {
    const data = getPrinterProductionSummary();
    const result = data.map(d => ({
      yazici: d.yazici_no,
      uretimAdet: d.toplam_adet || 0,
      calismaSaati: (d.toplam_saat || 0).toFixed(1),
      karUSD: (d.kar_toplam || 0).toFixed(2),
      karTL: (d.kar_toplam * exchangeRate || 0).toFixed(0)
    }));
    res.json({ kur: exchangeRate.toFixed(2), yaziciOzeti: result.sort((a, b) => parseFloat(b.calismaSaati) - parseFloat(a.calismaSaati)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/production/by-department', authenticateToken, (req, res) => {
  try {
    const data = getDepartmentProductionSummary();
    const result = data.map(d => ({
      bolum: d.bolum,
      uretimAdet: d.toplam_adet || 0,
      karUSD: (d.kar_toplam || 0).toFixed(2),
      karTL: (d.kar_toplam * exchangeRate || 0).toFixed(0)
    }));
    res.json({ kur: exchangeRate.toFixed(2), bolumOzeti: result.sort((a, b) => b.uretimAdet - a.uretimAdet) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/production/exchange-rate', (req, res) => {
  res.json({ USD_to_TRY: exchangeRate.toFixed(2), lastUpdate: new Date(lastRateUpdate).toISOString() });
});

// ═══════════════════════════════════════════════════════════════
// BAMBU'DAN ÜRETIM VERİSİ ÇEKME (YENİ)
// ═══════════════════════════════════════════════════════════════

app.get('/api/production/from-bambu/:printerId', authenticateToken, (req, res) => {
  try {
    const printerId = decodeURIComponent(req.params.printerId);
    const printerObj = global.adapters[printerId];
    
    if (!printerObj) {
      return res.status(404).json({ ok: false, error: 'Yazıcı bulunamadı' });
    }
    
    if (!printerObj.config || printerObj.config.type !== 'bambu') {
      return res.status(400).json({ ok: false, error: 'Bu yazıcı Bambu değil' });
    }
    
    if (typeof printerObj.extractPrintData !== 'function') {
      return res.status(400).json({ ok: false, error: 'Bambu adaptor veriyersel desteği yok' });
    }
    
    const data = printerObj.extractPrintData();
    
    res.json({
      ok: true,
      data: {
        tarih: data.tarih,
        yazici_no: data.yazici_no,
        malzeme_ismi: data.malzeme_ismi,
        adet: data.adet,
        filament_turu: data.filament_turu,
        filament_rengi: data.filament_rengi,
        filament_gramaji: data.filament_gramaji,
        calisma_suresi: data.calisma_suresi,
        aciklama: data.aciklama,
        masraf_kodu: null,
        bolum: null,
        orijinal_fiyati: null,
        proje_bedeli: null,
        siniflandirma: data.siniflandirma,
        _source: 'bambu',
        _taskId: data._taskId,
        _tamamlandi: data._tamamlandi,
        _sureKaynak: data._sureKaynak,
        _gramajKaynak: data._gramajKaynak,
        _filamentGuvenilir: data._filamentGuvenilir,
        _yuzde: data._yuzde,
        _nozzleTemp: data._nozzleTemp,
        _bedTemp: data._bedTemp,
        _layers: data._layers,
        _uyarilar: data._uyarilar
      }
    });
  } catch (err) {
    console.error('[Bambu Extract]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// EXCEL EXPORT (YENİ)
// ═══════════════════════════════════════════════════════════════

app.get('/api/production/export', authenticateToken, (req, res) => {
  try {
    const year = req.query.year || 2026;
    const format = req.query.format || 'monthly'; // monthly | all
    
    let records = [];
    
    if (format === 'all') {
      records = getProductionRecords({
        tarih_baslangic: req.query.tarih_baslangic,
        tarih_bitis:     req.query.tarih_bitis,
        yazici_no:       req.query.yazici_no,
        bolum:           req.query.bolum,
        filament_turu:   req.query.filament_turu,
        malzeme_ismi:    req.query.malzeme_ismi
      });
    } else {
      const monthly = getMonthlyProductionSummary(year);
      records = monthly.map(m => ({
        'Ay': m.ay,
        'Kayıt Sayısı': m.kayit_sayisi,
        'Toplam Adet': m.toplam_adet || 0,
        'Çalışma Saati': (m.toplam_saat || 0).toFixed(1),
        'Filament Maliyeti ($)': (m.filament_maliyeti_toplam || 0).toFixed(2),
        'Satınalma Maliyeti ($)': (m.satinalma_maliyeti_toplam || 0).toFixed(2),
        'Üretim Maliyeti ($)': (m.uretim_maliyeti_toplam || 0).toFixed(2),
        'Toplam Kâr ($)': Math.round((m.kar_toplam || 0) * 100) / 100,
        'Toplam Kâr (₺)': Math.round((m.kar_toplam || 0) * exchangeRate * 100) / 100
      }));
    }
    
    if (format === 'all') {
      const kur = exchangeRate;
      const s2 = (n) => Math.round((Number(n) || 0) * 100) / 100;   // 2 ondalık, metin değil SAYI
      records = records.map(r => ({
        'TARİH': r.tarih || '',
        'MASRAF KODU': r.masraf_kodu ?? '',
        'BÖLÜM': r.bolum || '',
        'MALZEME İSMİ': r.malzeme_ismi || '',
        'ADET SAYISI': Number(r.adet) || 0,
        'FİLAMENT RENGİ': r.filament_rengi || '',
        'FİLAMENT TÜRÜ': r.filament_turu || '',
        'GRAMAJA GÖRE MALİYET ($)': s2(r.filament_maliyeti),
        'FİLAMENT GRAMAJI (gr)': Number(r.filament_gramaji) || 0,
        'YAZICI': r.yazici_no || '',
        'ÇALIŞMA SÜRESİ (dk)': Number(r.calisma_suresi) || 0,
        'ORİJİNAL FİYATI ($)': s2(r.orijinal_fiyati),
        'PROJE&ÇİZİM BEDELİ ($)': s2(r.proje_bedeli),
        'ÖN GÖRÜLEN SATINALMA MALİYET ($)': s2(r.satinalma_maliyeti),
        'FİLAMENT VE YAZICI MALİYETİ ($)': s2(r.uretim_maliyeti),
        'ELEKTRİK ÜCRETİ ($/saat)': s2(r.elektrik_saat_usd),
        'TOPLAM KAR ($)': s2(r.toplam_kar),
        'TOPLAM KAR (₺)': s2((Number(r.toplam_kar) || 0) * kur),
        'SINIFLANDIRMA': r.siniflandirma || '',
        'AÇIKLAMA': r.aciklama || ''
      }));
    }
    
    if (!records.length) {
      return res.status(404).json({ ok: false, error: 'Seçilen filtreye uyan kayıt yok — Excel oluşturulmadı.' });
    }
    const ws = XLSX.utils.json_to_sheet(records);
    ws['!cols'] = Object.keys(records[0]).map(k => ({ wch: Math.min(34, Math.max(12, k.length + 2)) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, format === 'all' ? 'Tüm Kayıtlar' : 'Aylık Özet');
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="uretim_${format}_${year}.xlsx"`);
    
    const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    res.send(buffer);
  } catch (err) {
    console.error('[Export]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`\n╔════════════════════════════════════╗`);
  console.log(`║  3D PRINTER FARM CONTROL            ║`);
  console.log(`║  http://${HOST}:${PORT}`);
  console.log(`╚════════════════════════════════════╝\n`);

  initializeDefaultUsers();
  initializeProductionRecords();
  initializePrinters();
});

const wss = new WebSocketServer({ server });

// ═══════════════════════════════════════════════════════════════
// RTSP → HLS DÖNÜŞTÜRÜCÜ ← EKLE
// ═══════════════════════════════════════════════════════════════

function startStream(rtspUrl, streamName, accessCode = null) {
  const hlsPath = path.join(streamsDir, `${streamName}.m3u8`);
  
  // Bambu credentials ekle
  let finalUrl = rtspUrl;
  if (accessCode && rtspUrl.includes('rtsps')) {
    finalUrl = rtspUrl.replace('rtsps://', `rtsps://bblp:${accessCode}@`);
  }
  
  console.log(`🎬 ${streamName} başlatılıyor`);
  
  // ⚠️ KÖK NEDEN (doğrulandı — test_spawn.cjs ile kanıtlandı):
  // Windows'ta ffmpeg, Node'dan (Electron'dan bağımsız olarak da) spawn
  // edilince konsol kontrol işleyicisini/stdin'i bekleyerek TIKANIYORDU.
  // Süreç 'tasklist'te canlı görünüyor, hiç hata vermiyor, ama TEK BAYT
  // yazmıyordu (günlerce donuk kamera şikayetinin asıl sebebi buydu).
  // '-nostdin' bu konsol kontrol işleyicisini devre dışı bırakır —
  // ffmpeg'in kendi belgelerinde "arka planda/programatik çalıştırılan
  // süreçler için" özellikle önerilir. Manuel cmd'den çalıştırınca sorun
  // hiç görünmüyordu çünkü orada gerçek bir konsol/tty vardı.
  //
  // Ayrıca: Bambu kamerası zaten H.264 gönderdiği için '-c:v copy' ile
  // CPU'ya neredeyse hiç yük bindirmeden veriyi doğrudan HLS'e paketliyoruz
  // (9 kamera aynı anda yeniden encode edilseydi CPU yetişemezdi).
  ffmpeg(finalUrl)
    .inputOptions([
      '-nostdin',              // ← KÖK NEDEN ÇÖZÜMÜ
      '-rtsp_transport', 'tcp',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay'
    ])
    .outputOptions([
      '-c:v', 'copy',          // ← re-encode YOK, doğrudan kopyala (CPU dostu)
      '-c:a', 'aac',
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '10',
      '-hls_flags', 'delete_segments+independent_segments+omit_endlist'
    ])
    .output(hlsPath)
    .on('start', () => console.log(`✅ ${streamName} çalışıyor`))
    .on('error', err => {
      console.error(`❌ ${streamName}:`, err.message);
      // Yazıcı ağdan koparsa 'end' değil 'error' gelir. Bayat segmentleri
      // sil ki yazıcı kapalıyken hls.js eski görüntüyü oynatmasın (Zaxe ile aynı).
      purgeHlsFiles(streamName);
      if (hlsShuttingDown) return;
      console.warn(`⚠️  ${streamName} hatası — 15sn sonra tekrar denenecek`);
      setTimeout(() => startStream(rtspUrl, streamName, accessCode), 15000);
    })
    .on('end', () => {
      purgeHlsFiles(streamName);
      if (hlsShuttingDown) return;
      console.warn(`⚠️  ${streamName} akışı bitti — 15sn sonra tekrar denenecek`);
      setTimeout(() => startStream(rtspUrl, streamName, accessCode), 15000);
    })
    .run();
}

// ═══════════════════════════════════════════════════════════════
// PRINTERS.JSON YÜKLEME
// ═══════════════════════════════════════════════════════════════

function loadPrintersConfig() {
  try {
    const filePath = path.join(__dirname, 'printers.json');
    let content = fs.readFileSync(filePath, 'utf-8');

    // .env değişkenlerini replace et
    for (const [key, value] of Object.entries(process.env)) {
      const regex = new RegExp(`\\$\\{${key}\\}`, 'g');
      content = content.replace(regex, value || '');
    }

    return JSON.parse(content);
  } catch (err) {
    console.error('printers.json yükleme hatası:', err.message);
    return {};
  }
}

// ═══════════════════════════════════════════════════════════════
// YAZICI BAŞLATMA
// ═══════════════════════════════════════════════════════════════

async function initializePrinters() {
  console.log('📍 Yazıcılar başlatılıyor...\n');

  const config = loadPrintersConfig();
  let successCount = 0;
  let failCount = 0;

  // ✅ Global adapter objects'ini başlat (KOMUT GÖNDERMEK İÇİN)
  global.adapters = {};      // ← TÜM ADAPTER'LAR
  global.zaxeAdapters = {};  // ← Zaxe HLS streaming için

  for (const [brand, devices] of Object.entries(config)) {
    if (!Array.isArray(devices)) continue;

    for (const device of devices) {
      // ⚠️ DB kaydı bağlantıdan ÖNCE yapılır.
      // Önceden savePrinter() connect() sonrasındaydı; bağlanamayan yazıcı
      // (Guider timeout, Raise3D login hatası, ZAXE 16 kablo) DB'ye hiç
      // yazılmıyor, /api/printers DB'den okuduğu için dashboard'da da
      // görünmüyordu. Artık envanterdeki her yazıcı kayıtlı — bağlantı
      // kurulamazsa kartta "çevrim dışı" olarak görünür.
      try {
        savePrinter(device);
      } catch (dbErr) {
        console.error(`   ⚠️ ${device.id} DB'ye kaydedilemedi: ${dbErr.message}`);
      }

      try {
        const adapter = createAdapter(device);
        await adapter.connect();

        console.log(`✓ ${device.id}`);
        successCount++;

        // ✅ TÜM ADAPTER'LAR global.adapters'a kaydedilsin (komut göndermek için)
        global.adapters[device.id] = adapter;
        console.log(`   ✅ Adapter kaydedildi: ${device.id} (${device.type})`);

        // Zaxe için ekstra: HLS streaming
        if (device.type === 'zaxe') {
          global.zaxeAdapters[device.id] = adapter;
          console.log(`   📷 Zaxe HLS hazırlanıyor: ${device.id}`);
        }

        // Polling başlat
        startPolling(adapter, device);
      } catch (err) {
        console.error(`✗ ${device.id} — ${err.message}`);
        failCount++;
      }
    }
  }

  console.log(`\n✓ ${successCount} yazıcı bağlandı`);
  if (failCount > 0) console.log(`✗ ${failCount} yazıcı başarısız\n`);

  // Streams başlat ← EKLE (2 saniye gecikme)
  setTimeout(() => {
    startStream(`rtsps://${process.env.BAMBU_8_IP}:322/streaming/live/1`, 'bambu8', process.env.BAMBU_8_CODE);
    startStream(`rtsps://${process.env.BAMBU_9_IP}:322/streaming/live/1`, 'bambu9', process.env.BAMBU_9_CODE);
    startStream(`rtsps://${process.env.BAMBU_10_IP}:322/streaming/live/1`, 'bambu10', process.env.BAMBU_10_CODE);
    startStream(`rtsps://${process.env.BAMBU_11_IP}:322/streaming/live/1`, 'bambu11', process.env.BAMBU_11_CODE);
    startStream(`rtsps://${process.env.BAMBU_12_IP}:322/streaming/live/1`, 'bambu12', process.env.BAMBU_12_CODE);
    startStream(`rtsps://${process.env.BAMBU_18_IP}:322/streaming/live/1`, 'bambu18', process.env.BAMBU_18_CODE);
    startStream(`rtsps://${process.env.BAMBU_19_IP}:322/streaming/live/1`, 'bambu19', process.env.BAMBU_19_CODE);
    startStream(`rtsps://${process.env.BAMBU_21_IP}:322/streaming/live/1`, 'bambu21', process.env.BAMBU_21_CODE);
    startStream(`rtsps://${process.env.BAMBU_22_IP}:322/streaming/live/1`, 'bambu22', process.env.BAMBU_22_CODE);

    // Zaxe kameraları — sürekli çalışan HLS (Bambu ile aynı mantık)
    for (const device of (config.zaxe || [])) {
      if (device.ip) startZaxeHls(device.id, device.ip);
    }
  }, 2000);
}

// ═══════════════════════════════════════════════════════════════
// POLLING + STATE CHANGE LISTENER
// ═══════════════════════════════════════════════════════════════

// Global: Her adaptör için önceki durumu track et
const adapterPreviousState = {};

function startPolling(adapter, device) {
  // İlk durumu kaydet
  const initialStatus = adapter.getStatus();
  adapterPreviousState[device.id] = {
    state: initialStatus.state,
    error: initialStatus.error,
    progress: initialStatus.progress
  };

  setInterval(async () => {
    try {
      const status = adapter.getStatus();
      const previous = adapterPreviousState[device.id] || {};
      
      // ═══════════════════════════════════════════════════════════════
      // STATE CHANGE DETECTION — EVENTS KAYDET
      // ═══════════════════════════════════════════════════════════════
      
      // Baskı başladı
      if (previous.state !== 'printing' && status.state === 'printing') {
        console.log(`🟢 [${device.id}] BASKI BAŞLADI`);
        saveEvent(device.id, 'print_started', '🟢 Baskı başladı');
      }
      
      // Baskı tamamlandı (printing → finished VEYA printing → idle)
      if (previous.state === 'printing' && (status.state === 'finished' || status.state === 'idle')) {
        console.log(`✅ [${device.id}] BASKI TAMAMLANDI (durum: ${status.state})`);
        saveEvent(device.id, 'print_success', '✅ Baskı tamamlandı');
      }
      
      // Baskı duraklatıldı
      if (previous.state === 'printing' && status.state === 'paused') {
        console.log(`⏸️  [${device.id}] BASKI DURAKLATıLDı`);
        saveEvent(device.id, 'print_paused', '⏸️  Baskı duraklatıldı');
      }
      
      // Baskı devam ettirildi
      if (previous.state === 'paused' && status.state === 'printing') {
        console.log(`▶️  [${device.id}] BASKI DEVAM ETTİRİLDİ`);
        saveEvent(device.id, 'print_resumed', '▶️  Baskı devam ettirildi');
      }
      
      // Baskı başarısız oldu
      if (previous.state === 'printing' && status.state === 'error') {
        console.log(`❌ [${device.id}] BASKI BAŞARISIZ`);
        saveEvent(device.id, 'print_failed', `❌ Baskı başarısız: ${status.error || 'Bilinmeyen hata'}`);
      }
      
      // Hata oluştu (printing sırasında)
      if (status.state === 'printing' && previous.error !== status.error && status.error) {
        console.log(`⚠️  [${device.id}] HATA: ${status.error}`);
        saveEvent(device.id, 'error', `⚠️  ${status.error}`);
      }
      
      // Durum güncelle
      adapterPreviousState[device.id] = {
        state: status.state,
        error: status.error,
        progress: status.progress
      };
      
      // ═══════════════════════════════════════════════════════════════
      // TELEMETRY KAYDET (her poll'da)
      // ═══════════════════════════════════════════════════════════════
      
      // Format: WebSocket broadcast'e göre
      const broadcastData = {
        id: device.id,
        type: device.type,
        status: status.state,
        progress: status.progress,
        remainingSeconds: status.remainingSeconds,
        nozzleTemp: status.nozzle,
        bedTemp: status.bed,
        error: status.error
      };
      
      // WebSocket broadcast
      broadcast(broadcastData);

      // Format: Database'e kaydetmek için (snake_case dönüştür)
      const dbData = {
        id: device.id,
        printer_id: device.id,
        state: status.state,
        progress: status.progress,
        remainingSeconds: status.remainingSeconds,
        nozzle: status.nozzle,
        bed: status.bed,
        chamber: status.chamber,
        error: status.error,
        lastUpdate: Math.floor(Date.now() / 1000)
      };
      
      // Database kaydet
      saveTelemetry(dbData);
    } catch (err) {
      console.error(`[${device.id}] Polling hatası:`, err.message);
    }
  }, 5000);
}

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(data));
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ ok: false, message: 'Token gerekli' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, message: 'Token geçersiz' });
  }
}

// ═══════════════════════════════════════════════════════════════
// AUTH ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        ok: false,
        message: 'Kullanıcı adı ve şifre gerekli.'
      });
    }

    const result = loginUser(username, password);

    if (!result.ok) {
      return res.status(401).json({
        ok: false,
        message: result.message
      });
    }

    const token = jwt.sign(
      {
        id: result.user.id,
        username: result.user.username,
        role: result.user.role
      },
      JWT_SECRET,
      { expiresIn: '8h' }  // Access token 8 saat
    );

    // Refresh token 30 gün (uzun süreli)
    const refreshToken = jwt.sign(
      { id: result.user.id },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      ok: true,
      token,
      refreshToken,
      user: {
        id: result.user.id,
        username: result.user.username,
        role: result.user.role
      },
      message: 'Giriş başarılı!'
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({
      ok: false,
      message: 'Giriş sırasında hata oluştu.'
    });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.json({ ok: true, message: 'Çıkış başarılı' });
});

// Token yenile (refresh endpoint)
app.post('/api/auth/refresh', (req, res) => {
  try {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
      return res.status(401).json({ ok: false, error: 'Refresh token gerekli' });
    }

    jwt.verify(refreshToken, JWT_SECRET, (err, decoded) => {
      if (err) {
        console.warn('❌ Refresh token doğrulama hatası:', err.message);
        return res.status(401).json({ ok: false, error: 'Refresh token geçersiz veya süresi dolmuş' });
      }

      // ⚠️ Refresh token'ın içinde SADECE { id } var — username/role yok.
      // Bu yüzden kullanıcıyı DB'den taze çekiyoruz. (Aksi halde yeni token'da
      // role: undefined olur ve tüm requireRole kontrolleri 403 verir.)
      const user = getUserById(decoded.id);
      if (!user) {
        return res.status(401).json({ ok: false, error: 'Kullanıcı bulunamadı' });
      }

      const newAccessToken = jwt.sign(
        {
          id: user.id,
          username: user.username,
          role: user.role
        },
        JWT_SECRET,
        { expiresIn: '8h' }
      );

      console.log(`🔄 Token yenilendi: ${user.username} (${user.role})`);

      res.json({
        ok: true,
        token: newAccessToken,
        user: { id: user.id, username: user.username, role: user.role },
        message: 'Token yenilendi'
      });
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ŞİFREMİ UNUTTUM — GÜVENLİ KELİME + ADMİN ONAYI
// ═══════════════════════════════════════════════════════════════

// 1) Kullanıcı: kullanıcı adı + güvenli kelime gönderir
//    Doğruysa "pending" istek oluşur. Geçici şifre EKRANA BASILMAZ.
app.post('/api/auth/forgot-password', (req, res) => {
  try {
    const { username, secureWord } = req.body || {};
    if (!username || !secureWord) {
      return res.status(400).json({ ok: false, message: 'Kullanıcı adı ve güvenli kelime gerekli.' });
    }

    const result = requestPasswordReset(username, secureWord);
    // requestPasswordReset her zaman aynı jenerik mesajı döner (enumeration koruması)
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Sistem hatası.' });
  }
});

// 2) Admin: bekleyen istekleri görür
app.get('/api/admin/reset-requests', authenticateToken, requireRole(['admin']), (req, res) => {
  try {
    res.json({ ok: true, data: getPendingResetRequests() });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// 3) Admin: isteği onaylar → geçici şifre üretilir, SADECE admin'e döner
app.post('/api/admin/reset-requests/:id/approve', authenticateToken, requireRole(['admin']), (req, res) => {
  try {
    const result = approveResetRequest(req.params.id, req.user.id);
    if (!result.ok) return res.status(400).json(result);

    logAudit(req.user.id, req.user.username, 'password_reset_approved',
      `${result.username} şifresi sıfırlandı`);
    console.log(`🔑 Şifre sıfırlandı: ${result.username} → ${result.tempPassword} (onaylayan: ${req.user.username})`);

    res.json({
      ok: true,
      username: result.username,
      tempPassword: result.tempPassword,
      message: 'Geçici şifre üretildi. Kullanıcıya güvenli bir kanaldan iletin (telefon/yüz yüze).'
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// 4) Admin: isteği reddeder
app.post('/api/admin/reset-requests/:id/reject', authenticateToken, requireRole(['admin']), (req, res) => {
  try {
    const result = rejectResetRequest(req.params.id, req.user.id);
    if (!result.ok) return res.status(400).json(result);

    logAudit(req.user.id, req.user.username, 'password_reset_rejected', result.username);

    res.json({ ok: true, message: `${result.username} isteği reddedildi.` });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// 5) Kullanıcı: kendi güvenli kelimesini belirler/günceller (Settings → Hesabım)
app.post('/api/auth/set-secure-word', authenticateToken, (req, res) => {
  try {
    const { currentPassword, secureWord } = req.body || {};
    if (!currentPassword || !secureWord) {
      return res.status(400).json({ ok: false, message: 'Mevcut şifre ve güvenli kelime gerekli.' });
    }

    const result = setSecureWord(req.user.id, currentPassword, secureWord);
    if (!result.ok) return res.status(400).json(result);

    logAudit(req.user.id, req.user.username, 'secure_word_set', null);
    res.json({ ok: true, message: 'Güvenli kelimeniz kaydedildi.' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// 6) Kullanıcı: güvenli kelime belirlemiş mi (Settings ekranında göstermek için)
app.get('/api/auth/secure-word-status', authenticateToken, (req, res) => {
  try {
    res.json({ ok: true, hasSecureWord: hasSecureWord(req.user.id) });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// USER MANAGEMENT ENDPOINTS (ADMIN ONLY)
// ═══════════════════════════════════════════════════════════════

// Oturumdaki kullanıcının bilgisi
app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({
    ok: true,
    user: { id: req.user.id, username: req.user.username, role: req.user.role }
  });
});

// Kullanıcıları listele
app.get('/api/users', authenticateToken, requireRole(['admin']), (req, res) => {
  try {
    res.json({ ok: true, data: getAllUsers() });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Yeni kullanıcı
app.post('/api/users', authenticateToken, requireRole(['admin']), (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    const result = createUser(username, password, role);

    if (!result.ok) return res.status(400).json(result);

    logAudit(req.user.id, req.user.username, 'user_created', `${username} (${role})`);
    console.log(`👤 Kullanıcı oluşturuldu: ${username} (${role}) — ${req.user.username}`);

    res.status(201).json({ ok: true, user: result.user, message: 'Kullanıcı oluşturuldu.' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Kullanıcı güncelle (şifre ve/veya rol)
app.put('/api/users/:userId', authenticateToken, requireRole(['admin']), (req, res) => {
  try {
    const { password, role } = req.body || {};
    const result = updateUser(req.params.userId, { password, role });

    if (!result.ok) return res.status(400).json(result);

    logAudit(req.user.id, req.user.username, 'user_updated',
      `${result.user.username}${role ? ' → ' + role : ''}${password ? ' (şifre değişti)' : ''}`);

    res.json({ ok: true, user: result.user, message: 'Kullanıcı güncellendi.' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Kullanıcı sil
app.delete('/api/users/:userId', authenticateToken, requireRole(['admin']), (req, res) => {
  try {
    if (String(req.user.id) === String(req.params.userId)) {
      return res.status(400).json({ ok: false, message: 'Kendi hesabınızı silemezsiniz.' });
    }

    const result = deleteUser(req.params.userId);
    if (!result.ok) return res.status(400).json(result);

    logAudit(req.user.id, req.user.username, 'user_deleted', result.user.username);
    console.log(`🗑️  Kullanıcı silindi: ${result.user.username} — ${req.user.username}`);

    res.json({ ok: true, message: 'Kullanıcı silindi.' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Kendi şifresini değiştir (tüm roller)
app.post('/api/auth/change-password', authenticateToken, (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ ok: false, message: 'Mevcut ve yeni şifre gerekli.' });
    }

    const result = changePassword(req.user.id, oldPassword, newPassword);
    if (!result.ok) return res.status(400).json(result);

    logAudit(req.user.id, req.user.username, 'password_changed', result.username);

    res.json({ ok: true, message: 'Şifreniz değiştirildi.' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Denetim kaydı (admin)
app.get('/api/audit-log', authenticateToken, requireRole(['admin']), (req, res) => {
  try {
    res.json({ ok: true, data: getAuditLog(200) });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════════════════

wss.on('connection', (ws) => {
  console.log('🔗 Tarayıcı bağlandı');

  ws.on('message', (msg) => {
    try {
      // Komut işlemeleri buraya
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    console.log('🔗 Tarayıcı ayrıldı');
  });
});

// ═══════════════════════════════════════════════════════════════
// REST API - PRINTER
// ═══════════════════════════════════════════════════════════════

// Yazıcı objesini role göre temizle:
//  - admin    : her şeyi görür
//  - operator : IP tam, kimlik bilgileri gizli
//  - viewer   : IP maskeli, kimlik bilgileri gizli
function sanitizePrinterForRole(printer, role) {
  const p = { ...printer };

  if (role === 'admin') return p;

  p.ip = maskIP(p.ip, role);
  p.password = p.password ? '***' : null;
  p.accessCode = p.accessCode ? '***' : null;
  if (role === 'viewer') {
    p.username = p.username ? '***' : null;
    p.serial = p.serial ? '***' : null;
  }
  return p;
}

// ⚠️ Bu endpoint MARKA BAZLI grup döndürür.
// analysis.html/analysis.js bu formatı bekliyor — değiştirme!
app.get('/api/printers', authenticateToken, (req, res) => {
  try {
    const role = req.user.role;
    const group = (type) => getPrintersByType(type).map(p => sanitizePrinterForRole(p, role));

    res.json({
      ultimaker: group('ultimaker'),
      bambu:     group('bambu'),
      raise3d:   group('raise3d'),
      guider:    group('guider'),
      zaxe:      group('zaxe')
    });
  } catch (err) {
    console.error('Yazıcı listesi hatası:', err.message);
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.get('/api/status', (req, res) => {
  const printers = getAllPrinters();
  res.json({
    ok: true,
    printers: printers.length,
    timestamp: Math.floor(Date.now() / 1000)
  });
});

app.post('/api/printers', authenticateToken, requireRole(['admin']), async (req, res) => {
  const { type, printer } = req.body;

  // Validation
  if (!printer || !printer.id || !printer.ip || !printer.type) {
    return res.status(400).json({ ok: false, message: 'ID, IP, Type gerekli' });
  }

  try {
    // Frontend formatından backend'e dönüştür
    const printerData = {
      id: printer.id,
      ip: printer.ip,
      type: printer.type,
      name: printer.id,
      accessCode: printer.accessCode || null,
      serial: printer.serial || null,
      auth: printer.auth || {},
      created_at: Math.floor(Date.now() / 1000)
    };

    // Database'e kaydet
    savePrinter(printerData);

    // Adapter oluştur ve connect et
    const adapter = createAdapter(printerData);
    await adapter.connect();

    // ✅ TÜM ADAPTER'LAR global object'e kaydedilsin (komut göndermek için)
    if (!global.adapters) global.adapters = {};
    global.adapters[printerData.id] = adapter;
    console.log(`   ✅ Adapter kaydedildi: ${printerData.id} (${printerData.type})`);
    
    // Zaxe için ekstra: HLS streaming başlat
    if (printerData.type === 'zaxe') {
      if (!global.zaxeAdapters) global.zaxeAdapters = {};
      global.zaxeAdapters[printerData.id] = adapter;
      startZaxeHls(printerData.id, printerData.ip);
      console.log(`   📷 Zaxe HLS streaming başlatıldı: ${printerData.id}`);
    }

    // Polling başlat
    startPolling(adapter, printerData);

    // Event kaydet
    saveEvent(printer.id, 'printer_added', `${printer.type} yazıcı eklendi`, req.user.id);

    console.log(`✓ ${printer.id} eklendi ve çevrimiçi`);
    res.json({ ok: true, message: `${printer.id} başarıyla eklendi` });
  } catch (err) {
    console.error(`✗ Yazıcı ekleme hatası (${printer.id}):`, err.message);
    saveEvent(printer.id, 'printer_error', `Yazıcı ekleme hatası: ${err.message}`, req.user.id);
    res.status(500).json({ ok: false, message: `Bağlanılamadı: ${err.message}` });
  }
});

app.delete('/api/printers/:id', authenticateToken, requireRole(['admin']), (req, res) => {
  try {
    const id = req.params.id;
    deletePrinter(id);
    logAudit(req.user.id, req.user.username, 'printer_deleted', id);
    console.log(`🗑️  Yazıcı silindi: ${id} — ${req.user.username}`);
    res.json({ ok: true, message: `${id} silindi.` });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// UZAKTAN KONTROL ✅ GÜNCELLENME: start komutu eklendi
app.post('/api/command/:printerId', authenticateToken, canControlPrinter, async (req, res) => {
  const { printerId } = req.params;
  const { command } = req.body;

  // ✅ start komutunu destek et (pause, resume, stop'a ek olarak)
  if (!['start', 'pause', 'resume', 'stop'].includes(command)) {
    return res.status(400).json({ ok: false, message: 'Geçersiz komut' });
  }

  try {
    // Yazıcıyı bul
    const allPrinters = getAllPrinters();
    const printer = allPrinters.find(p => p.id === printerId);
    
    if (!printer) {
      console.error(`❌ [API] Yazıcı bulunamadı: ${printerId}`);
      return res.status(404).json({ ok: false, message: 'Yazıcı bulunamadı' });
    }

    console.log(`\n📤 [API] Komut gönderiliyor: ${printerId} → ${command}`);

    // Adapter'ı bul
    if (!global.adapters) global.adapters = {};
    const adapter = global.adapters[printerId];
    
    if (!adapter) {
      console.error(`❌ [API] Adapter bulunamadı: ${printerId}`);
      return res.status(400).json({ ok: false, message: 'Yazıcı bağlı değil (adapter yok)' });
    }

    if (!adapter.isConnected) {
      console.error(`❌ [API] Yazıcı çevrim dışı: ${printerId}`);
      return res.status(400).json({ ok: false, message: 'Yazıcı çevrim dışı' });
    }

    // Timeout ile komut gönder
    const cmdTimeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Komut timeout (10 saniye)')), 10000)
    );

    try {
      await Promise.race([adapter.sendCommand(command), cmdTimeout]);
      
      console.log(`✅ [API] Komut başarılı gönderildi: ${printerId} → ${command}`);
      
      // Database'e kaydet
      saveCommand(printerId, command, req.user.id);
      saveEvent(printerId, 'command_sent', `✅ ${command.toUpperCase()} gönderildi`, req.user.id);
      
      res.json({ ok: true, message: `${command} komutu başarıyla gönderildi` });
    } catch (cmdErr) {
      console.error(`❌ [API] Komut gönderme hatası: ${cmdErr.message}`);
      saveEvent(printerId, 'command_error', `Komut hatası: ${cmdErr.message}`, req.user.id);
      res.status(500).json({ ok: false, message: `Komut gönderilemedi: ${cmdErr.message}` });
    }
  } catch (err) {
    console.error('❌ [API] Komut endpoint hatası:', err.message);
    res.status(500).json({ ok: false, message: 'İşlem hatası: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// REST API - DATA
// ═══════════════════════════════════════════════════════════════

app.get('/api/history/:printerId', authenticateToken, (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 1;
    const data = getTelemetryLast(req.params.printerId, hours * 3600);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/events/:printerId', authenticateToken, (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 1;
    const data = getEventsLast(req.params.printerId, hours * 3600);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// FILE UPLOAD
// ═══════════════════════════════════════════════════════════════

const uploadDir = path.join(DATA_PATH, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const upload = multer({ dest: uploadDir });

app.post('/api/upload', upload.single('file'), (req, res) => {
  res.json({ ok: true });
});

app.get('/api/files', (req, res) => {
  res.json(fs.readdirSync(uploadDir));
});

// ═══════════════════════════════════════════════════════════════
// ANALYTICS API ENDPOINTS ← YENİ
// ═══════════════════════════════════════════════════════════════

// 📈 Sıcaklık Verisi (Son 6 saat)
app.get('/api/analytics/telemetry', authenticateToken, (req, res) => {
  try {
    const now = Math.floor(Date.now() / 1000);
    const sixHoursAgo = now - (6 * 60 * 60);
    
    const telemetryData = db.prepare(`
      SELECT printer_id, timestamp, nozzle, bed
      FROM telemetry
      WHERE timestamp > ?
      ORDER BY timestamp ASC
    `).all(sixHoursAgo);

    // Zaman etiketlerini oluştur (30 dakika aralıklı)
    const timeLabels = [];
    for (let i = sixHoursAgo; i <= now; i += 1800) {
      timeLabels.push(new Date(i * 1000).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }));
    }

    res.json({ 
      ok: true, 
      data: telemetryData,
      labels: timeLabels
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 📊 Yazıcı Verimliliği
app.get('/api/analytics/printer-stats', authenticateToken, (req, res) => {
  try {
    const printers = getAllPrinters();
    
    const stats = printers.map(p => ({
      id: p.id,
      name: p.name || p.id,
      efficiency: Math.floor(60 + Math.random() * 35) // 60-95 arası
    }));

    res.json({ ok: true, data: stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 🎯 Baskı Sonuçları (30 gün)
app.get('/api/analytics/print-results', authenticateToken, (req, res) => {
  try {
    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60);

    const telemetryCount = db.prepare(
      'SELECT COUNT(*) as count FROM telemetry WHERE timestamp > ?'
    ).get(thirtyDaysAgo);

    const successful = Math.floor((telemetryCount?.count || 0) * 0.72);
    const failed = Math.floor((telemetryCount?.count || 0) * 0.15);
    const ongoing = Math.floor((telemetryCount?.count || 0) * 0.13);

    res.json({
      ok: true,
      data: {
        successful,
        failed,
        ongoing
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ANALYTICS API ENDPOINTS - MARKA BAZINDA ← YENİ
// ═══════════════════════════════════════════════════════════════

// 📈 Sıcaklık Verisi - MARKA BAZINDA
app.get('/api/analytics/telemetry/:brand', authenticateToken, (req, res) => {
  try {
    const brand = req.params.brand.toLowerCase();
    const now = Math.floor(Date.now() / 1000);
    const sixHoursAgo = now - (6 * 60 * 60);
    
    // Yazıcıları al
    let printerIds = [];
    if (brand === 'all') {
      // Tüm yazıcılar
      const allPrinters = db.prepare('SELECT * FROM printers').all();
      printerIds = allPrinters.map(p => p.id);
    } else {
      // Marka bazlı yazıcılar
      const printers = getPrintersByType(brand);
      printerIds = printers.map(p => p.id);
    }

    if (printerIds.length === 0) {
      return res.json({ ok: true, data: [] });
    }

    // Tüm yazıcıların telemetrisini çek
    const telemetryData = db.prepare(`
      SELECT printer_id, timestamp, nozzle, bed
      FROM telemetry
      WHERE printer_id IN (${printerIds.map(() => '?').join(',')})
      AND timestamp > ?
      ORDER BY timestamp ASC
    `).all(...printerIds, sixHoursAgo);

    res.json({ 
      ok: true, 
      data: telemetryData
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Tüm yazıcıların telemetri verisi
// 🎯 Baskı Sonuçları - MARKA BAZINDA (tüm markaları dahil)
app.get('/api/analytics/print-results/:brand', authenticateToken, (req, res) => {
  try {
    const brand = req.params.brand.toLowerCase();
    
    // Yazıcıları al
    let printers = [];
    if (brand === 'all') {
      printers = db.prepare('SELECT * FROM printers').all();
    } else {
      printers = getPrintersByType(brand);
    }

    if (!printers || printers.length === 0) {
      return res.json({ ok: true, data: { successful: 0, failed: 0, ongoing: 0 } });
    }

    // Her yazıcının gerçek verilerini topla
    let totalSuccessful = 0;
    let totalFailed = 0;
    let totalOngoing = 0;

    for (const printer of printers) {
      const details = getPrinterDetails(printer.id);
      if (details && details.stats) {
        totalSuccessful += details.stats.successfulPrints || 0;
        totalFailed += details.stats.failedPrints || 0;
      }

      // "Devam Eden": şu an gerçekten 'printing' durumunda olan yazıcılar.
      // Anlık durumu canlı adaptörden okuyoruz (varsa); yoksa 0 sayılır.
      try {
        const adapter = global.adapters && global.adapters[printer.id];
        if (adapter && typeof adapter.getStatus === 'function') {
          const live = adapter.getStatus();
          if (live && live.state === 'printing') {
            totalOngoing += 1;
          }
        }
      } catch (e) {
        // Adaptör okunamazsa bu yazıcıyı devam eden saymayız (sessiz).
      }
    }

    res.json({
      ok: true,
      data: {
        successful: totalSuccessful,
        failed: totalFailed,
        ongoing: totalOngoing
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 📊 Verimlilik - MARKA BAZINDA
app.get('/api/analytics/efficiency/:brand', authenticateToken, (req, res) => {
  try {
    const brand = req.params.brand.toLowerCase();
    
    // Yazıcıları al
    let printers = [];
    if (brand === 'all') {
      printers = db.prepare('SELECT * FROM printers').all();
    } else {
      printers = getPrintersByType(brand);
    }

    if (!printers || printers.length === 0) {
      return res.json({ ok: true, data: [] });
    }

    // Her yazıcının gerçek verimini al
    const stats = printers.map(p => {
      const details = getPrinterDetails(p.id);
      return {
        id: p.id,
        name: p.name || p.id,
        efficiency: details?.stats?.successRate || 0
      };
    });

    res.json({ ok: true, data: stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// 📥 RAPOR İNDİR - MARKA BAZINDA (TXT/XLSX/CSV)
app.get('/api/analytics/report/:brand', authenticateToken, requireRole(['admin','operator']), async (req, res) => {
  try {
    const brand = req.params.brand.toUpperCase();
    const format = (req.query.format || 'txt').toLowerCase();
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const thirty_days_ago_timestamp = Math.floor(thirtyDaysAgo.getTime() / 1000);

    const printers = getPrintersByType(brand.toLowerCase());
    const printerReports = printers.map(p => {
      const details = getPrinterDetails(p.id);
      return {
        id: p.id,
        name: p.name,
        type: p.type,
        ...details?.stats
      };
    });

    const filename = `${brand}_Raporu_${now.getDate()}_${now.getMonth()+1}_${now.getFullYear()}`;

    // TXT Format
    if (format === 'txt') {
      const reportLines = [
        '╔════════════════════════════════════════════════════════╗',
        `║  ${brand} YAZICILARI - 30 GÜNLÜK VERİ RAPORU         ║`,
        '╚════════════════════════════════════════════════════════╝',
        '',
        '📅 TARIH BİLGİSİ',
        `Rapor Tarihi: ${now.toLocaleString('tr-TR')}`,
        `30 Gün Dönemi: ${thirtyDaysAgo.toLocaleDateString('tr-TR')} - ${now.toLocaleDateString('tr-TR')}`,
        '',
        '📊 İSTATİSTİKLER',
        `Aktif ${brand} Yazıcıları: ${printers.length}`,
        '',
        `🖨️  ${brand} YAZICI LİSTESİ`,
      ];

      printerReports.forEach((p, idx) => {
        reportLines.push(`\n  ${idx + 1}. ${p.name} (${p.id})`);
        reportLines.push(`     • Çalışma Saati: ${p.workingHours || 0} saat`);
        reportLines.push(`     • Başarılı Baskı: ${p.successfulPrints || 0}`);
        reportLines.push(`     • Başarısız Baskı: ${p.failedPrints || 0}`);
        reportLines.push(`     • Başarı Oranı: ${p.successRate || 0}%`);
        reportLines.push(`     • Hata Oranı: ${p.errorRate || 0}%`);
        reportLines.push(`     • Bakıma Kalan: ${p.daysUntilMaintenance || 0} gün`);
      });

      const reportText = reportLines.join('\n');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.txt"`);
      res.send(reportText);
    }

    // XLSX Format
    else if (format === 'xlsx') {
      const wb = XLSX.utils.book_new();
      const printerIds = printers.map(p => p.id);
      const now_ts = Math.floor(now.getTime() / 1000);
      const sixHoursAgo = now_ts - (6 * 60 * 60);

      // ── SAYFA 1: ÖZET ──
      const ozet_data = [
        [`${brand} YAZICILARI - 30 GÜNLÜK VERİ RAPORU`],
        [`Rapor Tarihi: ${now.toLocaleString('tr-TR')}`],
        [`Dönem: ${thirtyDaysAgo.toLocaleDateString('tr-TR')} - ${now.toLocaleDateString('tr-TR')}`],
        [`Aktif Yazıcı Sayısı: ${printers.length}`],
        [],
        ['ID', 'Ad', 'Çalışma Saati', 'Toplam Baskı', 'Başarılı', 'Başarısız', 'Başarı %', 'Hata %', 'Son Bakım', 'Sonraki Bakım', 'Bakıma Kalan Gün']
      ];
      printerReports.forEach(p => {
        ozet_data.push([
          p.id,
          p.name,
          p.workingHours || 0,
          p.totalPrints || 0,
          p.successfulPrints || 0,
          p.failedPrints || 0,
          (p.successRate || 0) + '%',
          (p.errorRate || 0) + '%',
          p.lastMaintenance ? new Date(p.lastMaintenance).toLocaleDateString('tr-TR') : '-',
          p.nextMaintenance ? new Date(p.nextMaintenance).toLocaleDateString('tr-TR') : '-',
          p.daysUntilMaintenance || 0
        ]);
      });
      const wsOzet = XLSX.utils.aoa_to_sheet(ozet_data);
      wsOzet['!cols'] = [{wch:20},{wch:22},{wch:13},{wch:12},{wch:10},{wch:10},{wch:9},{wch:8},{wch:14},{wch:14},{wch:16}];
      XLSX.utils.book_append_sheet(wb, wsOzet, 'Özet');

      // ── SAYFA 2: SICAKLIK GEÇMİŞİ (Son 6 Saat) ──
      const sicaklik_data = [['Yazıcı', 'Zaman', 'Nozzle (°C)', 'Tabla (°C)']];
      if (printerIds.length > 0) {
        const tempRows = db.prepare(`
          SELECT printer_id, timestamp, nozzle, bed
          FROM telemetry
          WHERE printer_id IN (${printerIds.map(() => '?').join(',')})
          AND timestamp > ?
          ORDER BY printer_id ASC, timestamp ASC
        `).all(...printerIds, sixHoursAgo);
        tempRows.forEach(r => {
          sicaklik_data.push([
            r.printer_id,
            new Date(r.timestamp * 1000).toLocaleString('tr-TR'),
            r.nozzle != null ? Number(r.nozzle.toFixed(1)) : '',
            r.bed != null ? Number(r.bed.toFixed(1)) : ''
          ]);
        });
      }
      const wsTemp = XLSX.utils.aoa_to_sheet(sicaklik_data);
      wsTemp['!cols'] = [{wch:22},{wch:22},{wch:12},{wch:12}];
      XLSX.utils.book_append_sheet(wb, wsTemp, 'Sıcaklık Geçmişi');

      // ── SAYFA 3: BASKI SONUÇLARI (30 Gün) ──
      const baski_data = [['Yazıcı', 'Başarılı', 'Başarısız', 'Devam Eden']];
      printerReports.forEach(p => {
        baski_data.push([
          p.name,
          p.successfulPrints || 0,
          p.failedPrints || 0,
          0
        ]);
      });
      // Marka toplamı
      const toplamBasarili = printerReports.reduce((s, p) => s + (p.successfulPrints || 0), 0);
      const toplamBasarisiz = printerReports.reduce((s, p) => s + (p.failedPrints || 0), 0);
      baski_data.push([]);
      baski_data.push(['TOPLAM', toplamBasarili, toplamBasarisiz, 0]);
      const wsBaski = XLSX.utils.aoa_to_sheet(baski_data);
      wsBaski['!cols'] = [{wch:22},{wch:10},{wch:10},{wch:12}];
      XLSX.utils.book_append_sheet(wb, wsBaski, 'Baskı Sonuçları');

      // ── SAYFA 4: YAZICI VERİMLİLİĞİ ──
      const verim_data = [['Yazıcı', 'Verimlilik %']];
      printerReports.forEach(p => {
        verim_data.push([p.name, p.successRate || 0]);
      });
      const wsVerim = XLSX.utils.aoa_to_sheet(verim_data);
      wsVerim['!cols'] = [{wch:22},{wch:14}];
      XLSX.utils.book_append_sheet(wb, wsVerim, 'Verimlilik');

      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
      res.send(buffer);
    }

    // CSV Format (çok bölümlü tek dosya)
    else if (format === 'csv') {
      const printerIds = printers.map(p => p.id);
      const now_ts = Math.floor(now.getTime() / 1000);
      const sixHoursAgo = now_ts - (6 * 60 * 60);
      const lines = [];

      lines.push(`${brand} YAZICILARI - 30 GÜNLÜK VERİ RAPORU`);
      lines.push(`Rapor Tarihi: ${now.toLocaleString('tr-TR')}`);
      lines.push('');

      // Özet
      lines.push('=== ÖZET ===');
      lines.push(['ID', 'Ad', 'Çalışma Saati', 'Toplam Baskı', 'Başarılı', 'Başarısız', 'Başarı %', 'Hata %', 'Son Bakım', 'Bakıma Kalan Gün'].join(','));
      printerReports.forEach(p => {
        lines.push([
          `"${p.id}"`,
          `"${p.name}"`,
          p.workingHours || 0,
          p.totalPrints || 0,
          p.successfulPrints || 0,
          p.failedPrints || 0,
          (p.successRate || 0),
          (p.errorRate || 0),
          p.lastMaintenance ? new Date(p.lastMaintenance).toLocaleDateString('tr-TR') : '-',
          p.daysUntilMaintenance || 0
        ].join(','));
      });

      // Sıcaklık
      lines.push('');
      lines.push('=== SICAKLIK GEÇMİŞİ (Son 6 Saat) ===');
      lines.push(['Yazıcı', 'Zaman', 'Nozzle', 'Tabla'].join(','));
      if (printerIds.length > 0) {
        const tempRows = db.prepare(`
          SELECT printer_id, timestamp, nozzle, bed
          FROM telemetry
          WHERE printer_id IN (${printerIds.map(() => '?').join(',')})
          AND timestamp > ?
          ORDER BY printer_id ASC, timestamp ASC
        `).all(...printerIds, sixHoursAgo);
        tempRows.forEach(r => {
          lines.push([
            `"${r.printer_id}"`,
            `"${new Date(r.timestamp * 1000).toLocaleString('tr-TR')}"`,
            r.nozzle != null ? r.nozzle.toFixed(1) : '',
            r.bed != null ? r.bed.toFixed(1) : ''
          ].join(','));
        });
      }

      // Baskı sonuçları
      lines.push('');
      lines.push('=== BASKI SONUÇLARI (30 Gün) ===');
      lines.push(['Yazıcı', 'Başarılı', 'Başarısız'].join(','));
      printerReports.forEach(p => {
        lines.push([`"${p.name}"`, p.successfulPrints || 0, p.failedPrints || 0].join(','));
      });

      // Verimlilik
      lines.push('');
      lines.push('=== YAZICI VERİMLİLİĞİ ===');
      lines.push(['Yazıcı', 'Verimlilik %'].join(','));
      printerReports.forEach(p => {
        lines.push([`"${p.name}"`, p.successRate || 0].join(','));
      });

      // Excel'in Türkçe karakterleri doğru göstermesi için BOM ekle
      const csvText = '\uFEFF' + lines.join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      res.send(csvText);
    }

    else {
      res.status(400).json({ ok: false, error: 'Format desteklenmiyor (txt, xlsx, csv)' });
    }

  } catch (err) {
    console.error('Rapor hatası:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 📊 YAZICI DETAYLARI
app.get('/api/analytics/printer-detail/:printerId', authenticateToken, (req, res) => {
  try {
    const printerId = decodeURIComponent(req.params.printerId);
    console.log(`\n🔍 [API] /analytics/printer-detail/${printerId} çağrısı`);
    const details = getPrinterDetails(printerId);
    
    if (!details) {
      console.log(`❌ [API] Yazıcı bulunamadı: ${printerId}`);
      return res.status(404).json({ ok: false, error: 'Yazıcı bulunamadı' });
    }

    console.log(`✅ [API] Veri gönderiliyor:`, details.stats);
    res.json({ ok: true, data: details });
  } catch (err) {
    console.log(`❌ [API] Hata:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════

async function shutdownGracefully() {
  console.log('\n\n🛑 Sunucu kapatılıyor...\n');

  // Yeniden başlatma zamanlayıcıları devreye girmesin
  hlsShuttingDown = true;

  // Zaxe HLS süreçlerini kapat → yazıcıların tek TCP slotu serbest kalsın
  stopAllZaxeHls();
  
  // WebSocket clients'ları kapat
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.close();
  });

  // Server'ı kapat
  server.close(() => {
    console.log('✓ Sunucu kapatıldı\n');
    process.exit(0);
  });

  // 5 saniye sonra force exit
  setTimeout(() => {
    console.log('⚠️ Force exit...');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', shutdownGracefully);
process.on('SIGTERM', shutdownGracefully);

export { db };
/**
 * 3D Printer Farm Control - Database
 * SQLite dengan better-sqlite3
 * Tüm tablolar: users, printers, telemetry, events, commands, prints
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// ═══════════════════════════════════════════════════════════════
// DATA KLASÖRÜ AYARI (server.js ile tutarlı)
// ═══════════════════════════════════════════════════════════════
const getDataPath = () => {
  const appDataPath = process.env.APPDATA || path.join(process.env.HOME || process.env.USERPROFILE, 'AppData', 'Roaming');
  const dataDir = path.join(appDataPath, 'PrintNexus');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
};

const DATA_PATH = getDataPath();
const db = new Database(path.join(DATA_PATH, "printers.db"));

// ═══════════════════════════════════════════════════════════════
// TABLES OLUŞTUR
// ═══════════════════════════════════════════════════════════════

db.exec(`
  -- KULLANICILAR (Login için)
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    created_at INTEGER,
    last_login INTEGER
  );

  -- YAZICILAR
  CREATE TABLE IF NOT EXISTS printers (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    ip TEXT NOT NULL,
    name TEXT,
    accessCode TEXT,
    username TEXT,
    password TEXT,
    serial TEXT,
    created_at INTEGER
  );

  -- TELEMETRİ (Sıcaklık, ilerleme, durum)
  CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    printer_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    state TEXT,
    nozzle REAL,
    bed REAL,
    chamber REAL,
    progress INTEGER,
    remaining_seconds INTEGER,
    error TEXT,
    FOREIGN KEY(printer_id) REFERENCES printers(id)
  );

  -- OLAYLAR (Hata, durum değişimi, komut)
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    printer_id TEXT NOT NULL,
    user_id INTEGER,
    timestamp INTEGER NOT NULL,
    type TEXT,
    message TEXT,
    FOREIGN KEY(printer_id) REFERENCES printers(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  -- KOMUTLAR (Durdur, devam, durdur)
  CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    printer_id TEXT NOT NULL,
    user_id INTEGER,
    command TEXT,
    timestamp INTEGER,
    FOREIGN KEY(printer_id) REFERENCES printers(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  -- BASKILAR (Mevcut tablo)
  CREATE TABLE IF NOT EXISTS prints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    printer_id TEXT,
    file_name TEXT,
    started_at TEXT,
    finished_at TEXT,
    duration_minutes INTEGER
  );

  -- BAKIM VERİLERİ (YENİ)
  CREATE TABLE IF NOT EXISTS maintenance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    printer_id TEXT NOT NULL UNIQUE,
    last_maintenance INTEGER,
    maintenance_interval INTEGER DEFAULT 2592000,
    notes TEXT,
    updated_at INTEGER,
    FOREIGN KEY(printer_id) REFERENCES printers(id)
  );

  -- İNDEKSLER (Hız için)
  CREATE INDEX IF NOT EXISTS idx_telemetry_printer_ts 
    ON telemetry(printer_id, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_events_printer_ts 
    ON events(printer_id, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_users_username 
    ON users(username);
`);

// ═══════════════════════════════════════════════════════════════
// AUTHENTICATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════

import crypto from "crypto";

export function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

export function initializeDefaultUsers() {
  try {
    const users = [
      { username: 'admin', password: 'admin', role: 'admin' },
      { username: 'operator', password: 'operator', role: 'operator' },
      { username: 'viewer', password: 'viewer', role: 'viewer' }
    ];

    const stmt = db.prepare(`
      INSERT OR IGNORE INTO users (username, password_hash, role, created_at)
      VALUES (?, ?, ?, ?)
    `);

    users.forEach(u => {
      stmt.run(
        u.username,
        hashPassword(u.password),
        u.role,
        Math.floor(Date.now() / 1000)
      );
    });

    console.log('✓ Demo kullanıcıları hazırlandı');
  } catch (err) {
    console.error('User initialization error:', err.message);
  }
}

export function loginUser(username, password) {
  try {
    const user = db.prepare(`
      SELECT id, username, role FROM users WHERE username = ?
    `).get(username);

    if (!user) {
      return { ok: false, message: 'Kullanıcı bulunamadı' };
    }

    const stored = db.prepare(`
      SELECT password_hash FROM users WHERE username = ?
    `).get(username);

    if (hashPassword(password) !== stored.password_hash) {
      return { ok: false, message: 'Şifre yanlış' };
    }

    // Last login güncelle
    db.prepare('UPDATE users SET last_login = ? WHERE username = ?').run(
      Math.floor(Date.now() / 1000),
      username
    );

    return {
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role
      }
    };
  } catch (err) {
    console.error('Login error:', err.message);
    return { ok: false, message: 'Giriş hatası' };
  }
}

export function getUserById(userId) {
  return db.prepare(`
    SELECT id, username, role FROM users WHERE id = ?
  `).get(userId);
}

// ═══════════════════════════════════════════════════════════════
// PRINTER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

export function savePrinter(printerData) {
  // Yazıcı zaten kayıtlıysa ilk kayıt tarihini KORU.
  // Aksi halde her sunucu yeniden baslatmada created_at sifirlanir ve
  // bakim sayaci hep bastan (30 gun) baslar.
  const existing = db.prepare(
    'SELECT created_at FROM printers WHERE id = ?'
  ).get(printerData.id);

  const createdAt = existing?.created_at
    || printerData.created_at
    || Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT OR REPLACE INTO printers 
    (id, type, ip, name, accessCode, username, password, serial, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    printerData.id,
    printerData.type,
    printerData.ip,
    printerData.name || printerData.id,
    printerData.accessCode || null,
    printerData.auth?.username || null,
    printerData.auth?.password || null,
    printerData.serial || null,
    createdAt
  );
}

export function getAllPrinters() {
  return db.prepare('SELECT * FROM printers').all();
}

export function getPrintersByType(type) {
  return db.prepare('SELECT * FROM printers WHERE LOWER(type) = LOWER(?)').all(type);
}

export function deletePrinter(printerId) {
  return db.prepare('DELETE FROM printers WHERE id = ?').run(printerId);
}

// ═══════════════════════════════════════════════════════════════
// TELEMETRY FUNCTIONS
// ═══════════════════════════════════════════════════════════════

export function saveTelemetry(status) {
  db.prepare(`
    INSERT INTO telemetry 
    (printer_id, timestamp, state, nozzle, bed, chamber, progress, remaining_seconds, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    status.id || status.printer_id,
    status.lastUpdate || Math.floor(Date.now() / 1000),
    status.state,
    status.nozzle || null,
    status.bed || null,
    status.chamber || null,
    status.progress || 0,
    status.remainingSeconds || 0,
    status.error || null
  );
}

export function getTelemetryLast(printerId, seconds = 3600) {
  const since = Math.floor(Date.now() / 1000) - seconds;
  return db.prepare(`
    SELECT timestamp, state, nozzle, bed, chamber, progress, remaining_seconds
    FROM telemetry
    WHERE printer_id = ? AND timestamp > ?
    ORDER BY timestamp ASC
  `).all(printerId, since);
}

// ═══════════════════════════════════════════════════════════════
// EVENT FUNCTIONS
// ═══════════════════════════════════════════════════════════════

export function saveEvent(printerId, type, message, userId = null) {
  db.prepare(`
    INSERT INTO events (printer_id, user_id, timestamp, type, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    printerId,
    userId || null,
    Math.floor(Date.now() / 1000),
    type,
    message
  );
}

export function getEventsLast(printerId, seconds = 3600) {
  const since = Math.floor(Date.now() / 1000) - seconds;
  return db.prepare(`
    SELECT timestamp, type, message
    FROM events
    WHERE printer_id = ? AND timestamp > ?
    ORDER BY timestamp DESC
  `).all(printerId, since);
}

// ═══════════════════════════════════════════════════════════════
// COMMAND FUNCTIONS
// ═══════════════════════════════════════════════════════════════

export function saveCommand(printerId, command, userId = null) {
  db.prepare(`
    INSERT INTO commands (printer_id, user_id, command, timestamp)
    VALUES (?, ?, ?, ?)
  `).run(
    printerId,
    userId || null,
    command,
    Math.floor(Date.now() / 1000)
  );
}

export function getCommandsLast(printerId, seconds = 3600) {
  const since = Math.floor(Date.now() / 1000) - seconds;
  return db.prepare(`
    SELECT timestamp, command
    FROM commands
    WHERE printer_id = ? AND timestamp > ?
    ORDER BY timestamp DESC
  `).all(printerId, since);
}

// ═══════════════════════════════════════════════════════════════
// PRINTER DETAIL FUNCTIONS
// ═══════════════════════════════════════════════════════════════

export function getPrinterDetails(printerId) {
  try {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(printerId);
    if (!printer) return null;

    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60);

    // ═══════════════════════════════════════════════════════════════
    // TELEMETRY: Çalışma saati
    // ═══════════════════════════════════════════════════════════════
    const telemetry = db.prepare(`
      SELECT COUNT(*) as count FROM telemetry
      WHERE printer_id = ? AND timestamp > ?
    `).get(printerId, thirtyDaysAgo);

    const telemetryPoints = telemetry?.count || 0;
    // Çalışma saati: Polling her 5 saniyede yapılıyor
    // 1 saat = 3600 saniye = 720 telemetri kaydı
    // workingHours = telemetryPoints * 5 saniye / 3600 saniye/saat
    const workingHours = Math.round((telemetryPoints * 5) / 3600);

    // ═══════════════════════════════════════════════════════════════
    // BASKI SAYILARI — Telemetri "state" geçişlerinden GERÇEK hesap
    // Her yazıcı kendi geçmişine göre farklı sonuç verir; tahmin YOK.
    //
    //   • printing → idle / finished  →  başarılı baskı
    //   • printing → error            →  başarısız baskı
    //   • (başka)  → printing         →  başlatılan baskı
    //
    // Bir baskı = birçok ardışık 'printing' satırı; yalnızca son
    // geçiş sayıldığı için her baskı tek kez hesaplanır.
    // ═══════════════════════════════════════════════════════════════
    const t = db.prepare(`
      WITH ordered AS (
        SELECT state,
               LAG(state) OVER (ORDER BY timestamp) AS prev
        FROM telemetry
        WHERE printer_id = ? AND timestamp > ?
      )
      SELECT
        COALESCE(SUM(CASE WHEN prev = 'printing' AND state IN ('finished','idle') THEN 1 END), 0) AS success,
        COALESCE(SUM(CASE WHEN prev = 'printing' AND state = 'error'              THEN 1 END), 0) AS failed,
        COALESCE(SUM(CASE WHEN prev IS NOT NULL AND prev <> 'printing' AND state = 'printing' THEN 1 END), 0) AS started
      FROM ordered
    `).get(printerId, thirtyDaysAgo);

    let successfulPrints = t?.success || 0;
    let failedPrints     = t?.failed  || 0;
    const startedPrints  = t?.started || 0;

    // Baskı yapıldığı hâlde bitiş geçişi yakalanamadıysa (baskı hâlâ
    // sürüyorsa veya örnekleme aralığına denk gelmediyse) başlatılan
    // baskıları baz al — bu da gerçek veridir, uydurma oran değil.
    if (successfulPrints + failedPrints === 0 && startedPrints > 0) {
      successfulPrints = startedPrints;
    }

    const totalPrints = successfulPrints + failedPrints;
    const successRate = totalPrints > 0 ? Math.round((successfulPrints / totalPrints) * 100) : 0;
    const errorRate   = totalPrints > 0 ? 100 - successRate : 0;

    console.log(`[${printerId}] baskı → ${successfulPrints}✓ ${failedPrints}✗ / toplam ${totalPrints} (%${successRate})`);

    // ═══════════════════════════════════════════════════════════════
    // MAINTENANCE: Bakım bilgileri
    // ═══════════════════════════════════════════════════════════════
    
    const maintenance = db.prepare(
      'SELECT * FROM maintenance WHERE printer_id = ?'
    ).get(printerId);

    const lastMaintenance = maintenance?.last_maintenance 
      ? new Date(maintenance.last_maintenance * 1000)
      : new Date(printer.created_at * 1000);

    // Onerilen bakim araligi: 30 gun
    const MAINTENANCE_INTERVAL_DAYS = maintenance?.maintenance_interval
      ? Math.round(maintenance.maintenance_interval / 86400)
      : 30;

    const nextMaintenance = new Date(
      lastMaintenance.getTime() + MAINTENANCE_INTERVAL_DAYS * 24 * 60 * 60 * 1000
    );

    // Takvim gunu farki: saat farklarindan etkilenmesin, her gun 1 azalsin
    const startOfDay = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    const daysUntilMaintenance = Math.round(
      (startOfDay(nextMaintenance) - startOfDay(new Date())) / (24 * 60 * 60 * 1000)
    );

    // Gecikme varsa negatif deger dondurulur (UI "gecikti" olarak gosterir)
    const maintenanceOverdue = daysUntilMaintenance < 0;

    return {
      printer: printer,
      stats: {
        workingHours,
        telemetryPoints,
        successfulPrints,
        failedPrints,
        totalPrints,
        successRate,
        errorRate,
        lastMaintenance: lastMaintenance.toISOString(),
        nextMaintenance: nextMaintenance.toISOString(),
        daysUntilMaintenance,
        maintenanceIntervalDays: MAINTENANCE_INTERVAL_DAYS,
        maintenanceOverdue,
        maintenanceNotes: maintenance?.notes || 'Bakım notu yok',
        startedPrints,
        _dataSource: 'telemetry_state'
      }
    };
  } catch (err) {
    console.error('Printer detail error:', err.message);
    return null;
  }
}

export function updateMaintenanceDate(printerId, date = null, notes = null) {
  const timestamp = date ? Math.floor(new Date(date).getTime() / 1000) : Math.floor(Date.now() / 1000);
  
  db.prepare(`
    INSERT OR REPLACE INTO maintenance (printer_id, last_maintenance, updated_at, notes)
    VALUES (?, ?, ?, ?)
  `).run(printerId, timestamp, Math.floor(Date.now() / 1000), notes || null);
}

// ═══════════════════════════════════════════════════════════════
// DATA CLEANUP (30 Gün)
// ═══════════════════════════════════════════════════════════════

export function cleanOldData() {
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);

  const telemetryDeleted = db.prepare(
    'DELETE FROM telemetry WHERE timestamp < ?'
  ).run(thirtyDaysAgo).changes;

  const eventsDeleted = db.prepare(
    'DELETE FROM events WHERE timestamp < ?'
  ).run(thirtyDaysAgo).changes;

  const commandsDeleted = db.prepare(
    'DELETE FROM commands WHERE timestamp < ?'
  ).run(thirtyDaysAgo).changes;

  console.log(`✓ Eski veriler temizlendi (telemetry: ${telemetryDeleted}, events: ${eventsDeleted}, commands: ${commandsDeleted})`);
}

// Her 24 saatte bir çalışsın
setInterval(cleanOldData, 24 * 60 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════
// RBAC — AUDIT LOG + KULLANICI YÖNETİMİ
// ═══════════════════════════════════════════════════════════════

// Audit tablosu (events tablosu printer_id NOT NULL olduğu için
// kullanıcı işlemleri buraya yazılır)
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    detail TEXT,
    timestamp INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp DESC);
`);

export function logAudit(userId, username, action, detail = null) {
  try {
    db.prepare(`
      INSERT INTO audit_log (user_id, username, action, detail, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId || null, username || null, action, detail, Math.floor(Date.now() / 1000));
  } catch (err) {
    console.warn('⚠️ Audit log yazılamadı:', err.message);
  }
}

export function getAuditLog(limit = 100) {
  return db.prepare(`
    SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?
  `).all(limit);
}

const VALID_ROLES = ['admin', 'operator', 'viewer'];

export function getAllUsers() {
  return db.prepare(`
    SELECT id, username, role, created_at, last_login
    FROM users
    ORDER BY
      CASE role WHEN 'admin' THEN 0 WHEN 'operator' THEN 1 ELSE 2 END,
      username
  `).all();
}

export function createUser(username, password, role) {
  if (!username || !password || !role) {
    return { ok: false, message: 'Kullanıcı adı, şifre ve rol zorunlu.' };
  }
  if (!VALID_ROLES.includes(role)) {
    return { ok: false, message: 'Geçersiz rol.' };
  }
  if (String(password).length < 3) {
    return { ok: false, message: 'Şifre en az 3 karakter olmalı.' };
  }

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) {
    return { ok: false, message: 'Bu kullanıcı adı zaten kullanılıyor.' };
  }

  const info = db.prepare(`
    INSERT INTO users (username, password_hash, role, created_at)
    VALUES (?, ?, ?, ?)
  `).run(username, hashPassword(password), role, Math.floor(Date.now() / 1000));

  return {
    ok: true,
    user: { id: info.lastInsertRowid, username, role }
  };
}

export function updateUser(userId, { password, role } = {}) {
  const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId);
  if (!user) return { ok: false, message: 'Kullanıcı bulunamadı.' };

  if (!password && !role) {
    return { ok: false, message: 'Güncellenecek bir alan yok.' };
  }
  if (role && !VALID_ROLES.includes(role)) {
    return { ok: false, message: 'Geçersiz rol.' };
  }

  // Son admin'in rolü düşürülemez
  if (role && role !== 'admin' && user.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get();
    if (admins.c <= 1) {
      return { ok: false, message: 'Sistemde en az bir yönetici kalmalı.' };
    }
  }

  const sets = [];
  const params = [];
  if (password) {
    if (String(password).length < 3) {
      return { ok: false, message: 'Şifre en az 3 karakter olmalı.' };
    }
    sets.push('password_hash = ?');
    params.push(hashPassword(password));
  }
  if (role) {
    sets.push('role = ?');
    params.push(role);
  }
  params.push(userId);

  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  return {
    ok: true,
    user: db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId)
  };
}

export function deleteUser(userId) {
  const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId);
  if (!user) return { ok: false, message: 'Kullanıcı bulunamadı.' };

  if (user.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get();
    if (admins.c <= 1) {
      return { ok: false, message: 'Sistemde en az bir yönetici kalmalı.' };
    }
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  return { ok: true, user };
}

export function changePassword(userId, oldPassword, newPassword) {
  const row = db.prepare('SELECT id, username, password_hash FROM users WHERE id = ?').get(userId);
  if (!row) return { ok: false, message: 'Kullanıcı bulunamadı.' };

  if (hashPassword(oldPassword) !== row.password_hash) {
    return { ok: false, message: 'Mevcut şifre yanlış.' };
  }
  if (!newPassword || String(newPassword).length < 3) {
    return { ok: false, message: 'Yeni şifre en az 3 karakter olmalı.' };
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(hashPassword(newPassword), userId);

  return { ok: true, username: row.username };
}

// ═══════════════════════════════════════════════════════════════
// YAZICI BAZLI ANALİTİK (YENİ)
// ═══════════════════════════════════════════════════════════════

export function getPrinterMonthlyStats(printerId) {
  try {
    const sql = `
      WITH monthly_data AS (
        SELECT
          strftime('%Y-%m', datetime(timestamp, 'unixepoch')) as month,
          COUNT(*) as telemetry_count,
          SUM(CASE WHEN state IN ('printing', 'finished') THEN 1 ELSE 0 END) as working_records,
          SUM(CASE WHEN state = 'error' THEN 1 ELSE 0 END) as error_records
        FROM telemetry
        WHERE printer_id = ?
        GROUP BY month
        ORDER BY month DESC
        LIMIT 6
      )
      SELECT
        month,
        telemetry_count,
        working_records,
        error_records,
        ROUND((working_records * 5.0) / 3600, 1) as working_hours,
        CASE
          WHEN working_records + error_records > 0
          THEN ROUND((working_records * 100.0) / (working_records + error_records), 1)
          ELSE 0
        END as success_rate
      FROM monthly_data
      ORDER BY month ASC
    `;
    const stmt = db.prepare(sql);
    return stmt.all(printerId) || [];
  } catch (err) {
    console.error(`[Yazıcı ${printerId}] Aylık stats hatası:`, err.message);
    return [];
  }
}

export function getPrinterErrorHistory(printerId) {
  try {
    const sql = `
      SELECT
        id,
        timestamp,
        datetime(timestamp, 'unixepoch') as error_time,
        type,
        message
      FROM events
      WHERE printer_id = ?
        AND type IN ('error', 'fault', 'warning', 'offline')
      ORDER BY timestamp DESC
      LIMIT 100
    `;
    const stmt = db.prepare(sql);
    return stmt.all(printerId) || [];
  } catch (err) {
    console.error(`[Yazıcı ${printerId}] Hata geçmişi hatası:`, err.message);
    return [];
  }
}

export function getPrinterUptime(printerId) {
  try {
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
    const sql = `
      SELECT
        COUNT(*) as total_records,
        SUM(CASE WHEN state != 'offline' THEN 1 ELSE 0 END) as online_records,
        SUM(CASE WHEN state = 'printing' THEN 1 ELSE 0 END) as printing_records,
        SUM(CASE WHEN state = 'idle' THEN 1 ELSE 0 END) as idle_records,
        SUM(CASE WHEN state = 'error' THEN 1 ELSE 0 END) as error_records,
        SUM(CASE WHEN state = 'offline' THEN 1 ELSE 0 END) as offline_records
      FROM telemetry
      WHERE printer_id = ? AND timestamp > ?
    `;
    const stmt = db.prepare(sql);
    const data = stmt.get(printerId, thirtyDaysAgo);

    if (!data || data.total_records === 0) {
      return { uptime_percent: 0, printing_percent: 0, idle_percent: 0, error_percent: 0, offline_percent: 0, total_records: 0 };
    }
    return {
      uptime_percent: Math.round((data.online_records / data.total_records) * 100),
      printing_percent: Math.round((data.printing_records / data.total_records) * 100),
      idle_percent: Math.round((data.idle_records / data.total_records) * 100),
      error_percent: Math.round((data.error_records / data.total_records) * 100),
      offline_percent: Math.round((data.offline_records / data.total_records) * 100),
      total_records: data.total_records
    };
  } catch (err) {
    console.error(`[Yazıcı ${printerId}] Uptime hatası:`, err.message);
    return { uptime_percent: 0 };
  }
}

export function getPrinterCostMetrics(printerId) {
  try {
    const sql = `
      SELECT
        COUNT(*) as total_prints,
        SUM(adet) as total_items,
        SUM(calisma_suresi) / 60.0 as total_hours,
        SUM(filament_maliyeti) as filament_cost,
        SUM(uretim_maliyeti) as production_cost,
        SUM(satinalma_maliyeti) as sales_revenue,
        SUM(toplam_kar) as total_profit,
        ROUND(AVG(toplam_kar), 2) as avg_profit_per_print
      FROM production_records
      WHERE yazici_no = ?
    `;
    const stmt = db.prepare(sql);
    const data = stmt.get(printerId);
    return {
      total_prints: data?.total_prints || 0,
      total_items: data?.total_items || 0,
      total_hours: Math.round((data?.total_hours || 0) * 10) / 10,
      filament_cost: Math.round((data?.filament_cost || 0) * 100) / 100,
      production_cost: Math.round((data?.production_cost || 0) * 100) / 100,
      sales_revenue: Math.round((data?.sales_revenue || 0) * 100) / 100,
      total_profit: Math.round((data?.total_profit || 0) * 100) / 100,
      avg_profit_per_print: data?.avg_profit_per_print || 0
    };
  } catch (err) {
    if (err.message.includes('no such table')) {
      return { total_prints: 0, total_items: 0, total_hours: 0, filament_cost: 0, production_cost: 0, sales_revenue: 0, total_profit: 0, avg_profit_per_print: 0 };
    }
    console.error(`[Yazıcı ${printerId}] Maliyet metrikleri hatası:`, err.message);
    return { total_prints: 0 };
  }
}

// ═══════════════════════════════════════════════════════════════
// ÜRETİM KAYITLARI (YENİ)
// ═══════════════════════════════════════════════════════════════

export function initializeProductionRecords() {
  const sql = `
    CREATE TABLE IF NOT EXISTS production_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarih DATE NOT NULL DEFAULT CURRENT_DATE,
      yazici_no TEXT NOT NULL,
      masraf_kodu INTEGER,
      bolum TEXT,
      malzeme_ismi TEXT,
      adet INTEGER DEFAULT 1,
      filament_turu TEXT,
      filament_rengi TEXT,
      filament_gramaji REAL DEFAULT 0,
      calisma_suresi INTEGER DEFAULT 0,
      orijinal_fiyati REAL DEFAULT 0,
      proje_bedeli REAL DEFAULT 0,
      siniflandirma TEXT DEFAULT 'DIĞER',
      aciklama TEXT,
      filament_maliyeti REAL DEFAULT 0,
      satinalma_maliyeti REAL DEFAULT 0,
      uretim_maliyeti REAL DEFAULT 0,
      toplam_kar REAL DEFAULT 0,
      olusturma_tarihi DATETIME DEFAULT CURRENT_TIMESTAMP,
      guncelleme_tarihi DATETIME DEFAULT CURRENT_TIMESTAMP,
      kullanici_id INTEGER,
      FOREIGN KEY (kullanici_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_production_tarih ON production_records(tarih);
    CREATE INDEX IF NOT EXISTS idx_production_yazici ON production_records(yazici_no);
    CREATE INDEX IF NOT EXISTS idx_production_bolum ON production_records(bolum);
  `;
  try {
    db.exec(sql);
    console.log('[PROD] production_records tablosu hazır');
  } catch (err) {
    if (!err.message.includes('already exists')) {
      console.error('[PROD] Tablo oluşturma hatası:', err.message);
    }
  }

  // ── Güvenli migration: elektrik ücreti kolonu (eski kayıtlar 0.09 varsayılanıyla kalır) ──
  try {
    const cols = db.prepare('PRAGMA table_info(production_records)').all();
    if (!cols.some(c => c.name === 'elektrik_saat_usd')) {
      db.exec('ALTER TABLE production_records ADD COLUMN elektrik_saat_usd REAL DEFAULT 0.09');
      console.log('[PROD] elektrik_saat_usd kolonu eklendi');
    }
  } catch (err) {
    console.error('[PROD] Migration hatası (elektrik_saat_usd):', err.message);
  }
}

export function insertProductionRecord(data) {
  const {
    tarih, yazici_no, masraf_kodu, bolum, malzeme_ismi, adet = 1,
    filament_turu, filament_rengi, filament_gramaji = 0, calisma_suresi = 0,
    orijinal_fiyati = 0, proje_bedeli = 0, siniflandirma = 'DIĞER', aciklama,
    filament_maliyeti = 0, satinalma_maliyeti = 0, uretim_maliyeti = 0,
    toplam_kar = 0, elektrik_saat_usd = 0.09, kullanici_id
  } = data;

  const stmt = db.prepare(`
    INSERT INTO production_records (
      tarih, yazici_no, masraf_kodu, bolum, malzeme_ismi, adet,
      filament_turu, filament_rengi, filament_gramaji, calisma_suresi,
      orijinal_fiyati, proje_bedeli, siniflandirma, aciklama,
      filament_maliyeti, satinalma_maliyeti, uretim_maliyeti, toplam_kar,
      elektrik_saat_usd, kullanici_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    tarih || new Date().toISOString().split('T')[0],
    yazici_no, masraf_kodu || null, bolum, malzeme_ismi, adet,
    filament_turu, filament_rengi, filament_gramaji, calisma_suresi,
    orijinal_fiyati, proje_bedeli, siniflandirma, aciklama,
    filament_maliyeti, satinalma_maliyeti, uretim_maliyeti, toplam_kar,
    elektrik_saat_usd, kullanici_id
  );
  return { id: result.lastInsertRowid };
}

export function getProductionRecords(filters = {}) {
  let sql = 'SELECT * FROM production_records WHERE 1=1';
  const values = [];
  if (filters.tarih_baslangic) { sql += ' AND tarih >= ?'; values.push(filters.tarih_baslangic); }
  if (filters.tarih_bitis)     { sql += ' AND tarih <= ?'; values.push(filters.tarih_bitis); }
  if (filters.yazici_no)       { sql += ' AND yazici_no = ?'; values.push(filters.yazici_no); }
  if (filters.bolum)           { sql += ' AND bolum = ?'; values.push(filters.bolum); }
  if (filters.filament_turu)   { sql += ' AND filament_turu = ?'; values.push(filters.filament_turu); }
  if (filters.malzeme_ismi)    { sql += ' AND malzeme_ismi LIKE ?'; values.push('%' + filters.malzeme_ismi + '%'); }
  sql += ' ORDER BY tarih DESC, olusturma_tarihi DESC';
  const stmt = db.prepare(sql);
  return stmt.all(...values) || [];
}

export function getMonthlyProductionSummary(year = 2026) {
  const sql = `
    SELECT
      strftime('%Y-%m', tarih) as ay,
      COUNT(*) as kayit_sayisi,
      SUM(adet) as toplam_adet,
      SUM(calisma_suresi) / 60.0 as toplam_saat,
      SUM(filament_maliyeti) as filament_maliyeti_toplam,
      SUM(satinalma_maliyeti) as satinalma_maliyeti_toplam,
      SUM(uretim_maliyeti) as uretim_maliyeti_toplam,
      SUM(toplam_kar) as kar_toplam
    FROM production_records
    WHERE strftime('%Y', tarih) = ?
    GROUP BY ay
    ORDER BY ay
  `;
  const stmt = db.prepare(sql);
  return stmt.all(String(year)) || [];
}

export function getPrinterProductionSummary() {
  const sql = `
    SELECT
      yazici_no,
      COUNT(*) as kayit_sayisi,
      SUM(adet) as toplam_adet,
      SUM(calisma_suresi) / 60.0 as toplam_saat,
      SUM(toplam_kar) as kar_toplam
    FROM production_records
    GROUP BY yazici_no
    ORDER BY toplam_saat DESC
  `;
  const stmt = db.prepare(sql);
  return stmt.all() || [];
}

export function getDepartmentProductionSummary() {
  const sql = `
    SELECT
      bolum,
      COUNT(*) as kayit_sayisi,
      SUM(adet) as toplam_adet,
      SUM(toplam_kar) as kar_toplam
    FROM production_records
    WHERE bolum IS NOT NULL
    GROUP BY bolum
    ORDER BY toplam_adet DESC
  `;
  const stmt = db.prepare(sql);
  return stmt.all() || [];
}

// ═══════════════════════════════════════════════════════════════
// ÜRETİM KAYDI: SİL / TEK KAYIT GETİR  (YENİ)
// ═══════════════════════════════════════════════════════════════

export function getProductionRecordById(id) {
  return db.prepare('SELECT * FROM production_records WHERE id = ?').get(id) || null;
}

export function deleteProductionRecord(id) {
  const result = db.prepare('DELETE FROM production_records WHERE id = ?').run(id);
  return { deleted: result.changes > 0, changes: result.changes };
}

export function getProductionFilamentTypes() {
  return db.prepare(
    "SELECT DISTINCT filament_turu FROM production_records WHERE filament_turu IS NOT NULL AND filament_turu <> '' ORDER BY filament_turu"
  ).all().map(r => r.filament_turu);
}

export function getProductionMaterialNames() {
  return db.prepare(
    "SELECT DISTINCT malzeme_ismi FROM production_records WHERE malzeme_ismi IS NOT NULL AND malzeme_ismi <> '' ORDER BY malzeme_ismi"
  ).all().map(r => r.malzeme_ismi);
}

// ═══════════════════════════════════════════════════════════════
// GÜVENLİ KELİME + ADMİN ONAYLI ŞİFRE SIFIRLAMA
// ═══════════════════════════════════════════════════════════════

// users tablosuna secure_word_hash kolonu ekle (varsa hata vermez)
try {
  db.exec(`ALTER TABLE users ADD COLUMN secure_word_hash TEXT`);
} catch (err) {
  // Kolon zaten varsa SQLite hata verir — görmezden gel
}

db.exec(`
  CREATE TABLE IF NOT EXISTS password_reset_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected
    requested_at INTEGER,
    handled_by INTEGER,
    handled_at INTEGER,
    temp_password_hash TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_reset_status ON password_reset_requests(status, requested_at DESC);
`);

// Kelimeyi normalize et: baş/son boşluk kırp + küçük harfe çevir (TR karakter uyumlu)
function normalizeWord(word) {
  return String(word || '').trim().toLocaleLowerCase('tr-TR');
}

// Kullanıcı kendi güvenli kelimesini belirler/günceller (mevcut şifresiyle doğrulanır)
export function setSecureWord(userId, currentPassword, secureWord) {
  const row = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(userId);
  if (!row) return { ok: false, message: 'Kullanıcı bulunamadı.' };

  if (hashPassword(currentPassword) !== row.password_hash) {
    return { ok: false, message: 'Mevcut şifre yanlış.' };
  }

  const normalized = normalizeWord(secureWord);
  if (normalized.length < 3) {
    return { ok: false, message: 'Güvenli kelime en az 3 karakter olmalı.' };
  }

  db.prepare('UPDATE users SET secure_word_hash = ? WHERE id = ?')
    .run(hashPassword(normalized), userId);

  return { ok: true };
}

export function hasSecureWord(userId) {
  const row = db.prepare('SELECT secure_word_hash FROM users WHERE id = ?').get(userId);
  return !!(row && row.secure_word_hash);
}

// Şifremi Unuttum akışı — kullanıcı adı + güvenli kelime doğru mu?
// NOT: Kullanıcı var mı yok mu her zaman aynı jenerik mesaj döner (enumeration koruması)
const GENERIC_MSG = 'Bilgiler doğruysa isteğiniz yöneticiye iletildi.';

export function requestPasswordReset(username, secureWord) {
  const user = db.prepare('SELECT id, username, secure_word_hash FROM users WHERE username = ?')
    .get(username);

  if (!user || !user.secure_word_hash) {
    return { ok: true, message: GENERIC_MSG }; // Bilgi sızdırma
  }

  const normalized = normalizeWord(secureWord);
  if (hashPassword(normalized) !== user.secure_word_hash) {
    return { ok: true, message: GENERIC_MSG }; // Yanlış kelime — yine aynı mesaj
  }

  // Aynı kullanıcının bekleyen isteği varsa tekrar oluşturma
  const existing = db.prepare(`
    SELECT id FROM password_reset_requests WHERE user_id = ? AND status = 'pending'
  `).get(user.id);

  if (!existing) {
    db.prepare(`
      INSERT INTO password_reset_requests (user_id, username, status, requested_at)
      VALUES (?, ?, 'pending', ?)
    `).run(user.id, user.username, Math.floor(Date.now() / 1000));
  }

  return { ok: true, message: GENERIC_MSG };
}

export function getPendingResetRequests() {
  return db.prepare(`
    SELECT id, username, requested_at FROM password_reset_requests
    WHERE status = 'pending'
    ORDER BY requested_at ASC
  `).all();
}

export function approveResetRequest(requestId, adminId) {
  const reqRow = db.prepare('SELECT * FROM password_reset_requests WHERE id = ?').get(requestId);
  if (!reqRow) return { ok: false, message: 'İstek bulunamadı.' };
  if (reqRow.status !== 'pending') return { ok: false, message: 'Bu istek zaten işlenmiş.' };

  const tempPassword = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex karakter

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(hashPassword(tempPassword), reqRow.user_id);

  db.prepare(`
    UPDATE password_reset_requests
    SET status = 'approved', handled_by = ?, handled_at = ?, temp_password_hash = ?
    WHERE id = ?
  `).run(adminId, Math.floor(Date.now() / 1000), hashPassword(tempPassword), requestId);

  return { ok: true, username: reqRow.username, tempPassword };
}

export function rejectResetRequest(requestId, adminId) {
  const reqRow = db.prepare('SELECT * FROM password_reset_requests WHERE id = ?').get(requestId);
  if (!reqRow) return { ok: false, message: 'İstek bulunamadı.' };
  if (reqRow.status !== 'pending') return { ok: false, message: 'Bu istek zaten işlenmiş.' };

  db.prepare(`
    UPDATE password_reset_requests
    SET status = 'rejected', handled_by = ?, handled_at = ?
    WHERE id = ?
  `).run(adminId, Math.floor(Date.now() / 1000), requestId);

  return { ok: true, username: reqRow.username };
}

export default db;
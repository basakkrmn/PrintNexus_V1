const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const APP_ROOT = app.getAppPath();

// ── .env'den sadece REMOTE_SERVER_URL'i oku ──
function readEnvValue(key) {
  try {
    const envPath = path.join(APP_ROOT, '.env');
    const content = fs.readFileSync(envPath, 'utf-8');
    const match = content.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm'));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// İSTEMCİ MODU (birden fazla bilgisayarda çalıştırmak için)
// ═══════════════════════════════════════════════════════════════
const REMOTE_SERVER_URL = readEnvValue('REMOTE_SERVER_URL');
const isClientMode = !!REMOTE_SERVER_URL;
const TARGET_URL = isClientMode ? REMOTE_SERVER_URL : 'http://localhost:3000';

let mainWindow;

// ═══════════════════════════════════════════════════════════════
// .env DOSYASINI APPDATA'YA KOPYALA (İlk kurulum için)
// ═══════════════════════════════════════════════════════════════
async function ensureEnvFile() {
  const srcEnv = path.join(APP_ROOT, '.env');
  const destDir = path.join(process.env.APPDATA || '', 'PrintNexus');
  const destEnv = path.join(destDir, '.env');
  
  // Hedef klasör varsa ve dosya zaten varsa, hiç yapma
  if (fs.existsSync(destEnv)) {
    return;
  }
  
  // Kaynak dosya (proje kökü) yoksa, hiç yapma
  if (!fs.existsSync(srcEnv)) {
    console.warn('[Setup] Kaynak .env dosyası bulunamadı:', srcEnv);
    return;
  }
  
  try {
    // Hedef klasörü oluştur
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    
    // Dosyayı kopyala
    fs.copyFileSync(srcEnv, destEnv);
    console.log('[Setup] ✅ .env dosyası AppData konumuna kopyalandı:', destEnv);
  } catch (err) {
    console.error('[Setup] ❌ .env kopyalama hatası:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// SUNUCUYU AYNI SÜREÇTE (in-process) BAŞLAT
// ═══════════════════════════════════════════════════════════════
async function startServerInProcess() {
  process.chdir(APP_ROOT);

  const serverPath = path.join(APP_ROOT, 'server.js');
  await import(pathToFileURL(serverPath).href);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL(TARGET_URL);

  if (process.env.DEBUG) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('ready', async () => {
  try {
    // .env dosyasını AppData'ya kopyala (ilk kurulum)
    await ensureEnvFile();
    
    if (isClientMode) {
      console.log(`[Electron] İSTEMCİ modu — yerel sunucu başlatılmıyor.`);
      console.log(`[Electron] Bağlanılacak sunucu: ${TARGET_URL}`);
    } else {
      console.log('[Electron] BİRİNCİL mod — sunucu aynı süreçte başlatılıyor...');
      await startServerInProcess();
      console.log('[Electron] Sunucu hazır (http://localhost:3000)');
    }

    createWindow();
    console.log(`[Electron] PrintNexus başarıyla başladı (${isClientMode ? 'İSTEMCİ' : 'BİRİNCİL'} mod)`);
  } catch (err) {
    console.error('[Electron] Başlatma hatası:', err);
    dialog.showErrorBox(
      'PrintNexus başlatılamadı',
      `Sunucu başlatılırken bir hata oluştu:\n\n${err.stack || err.message || err}`
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (!isClientMode) {
    process.emit('SIGTERM');
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

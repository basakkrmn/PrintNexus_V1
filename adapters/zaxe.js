import WebSocket from 'ws';
import { PrinterAdapter } from './base.js';

export class ZaxeAdapter extends PrinterAdapter {
  constructor(config) {
    super(config);
    this.port = 9294; 
    this.ws = null;
    this.isConnected = false;
    this.lastCamera = null;  // ✅ KAMERA GÖRÜNTÜSÜ STORE EDİLECEK
  }

  async connect() {
    return new Promise((resolve, reject) => {
      console.log(`[${this.config.id}] ZAXE WebSocket bağlanıyor...`);
      
      this.ws = new WebSocket(`ws://${this.config.ip}:${this.port}`);

      this.ws.on('open', () => {
        console.log(`[${this.config.id}] ✅ WebSocket bağlantısı açıldı.`);
        this.isConnected = true;
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this._handleMessage(message);
        } catch (err) {
          console.error(`[${this.config.id}] JSON parse hatası:`, err);
        }
      });

      this.ws.on('error', (err) => {
        console.error(`[${this.config.id}] WebSocket hatası:`, err.message);
        this.isConnected = false;
        reject(err);
      });

      this.ws.on('close', () => {
        console.log(`[${this.config.id}] ❌ Bağlantı kapandı.`);
        this.isConnected = false;
      });
    });
  }

  _handleMessage(data) {
    const event = data.event || 'unknown';

    // ✅ DEBUG: TÜM EVENT'LERİ GÖSTER (ping hariç)
    if (event !== 'ping') {
      console.log(`   📡 [${this.config.id}] WebSocket event: "${event}"`);
      if (event.includes('camera') || event.includes('image') || event.includes('frame') || event.includes('snapshot')) {
        console.log(`      📊 Kamera event data:`, Object.keys(data));
      }
    }

    // Event type'ına göre işle
    switch (event) {
      case 'hello':
        this._processHello(data);
        break;
      case 'temperature_update':
        this._processTemperature(data);
        break;
      case 'print_progress':
        this._processProgress(data);
        break;
      case 'layer_change':
        this._processLayerChange(data);
        break;
      case 'camera_frame':
        console.log(`      ✅ camera_frame işleniyor...`);
        this._processCamera(data);
        break;
      case 'camera_snapshot':
        console.log(`      ✅ camera_snapshot işleniyor...`);
        this._processCamera(data);
        break;
      case 'ping':
        // Heartbeat, işlem yok
        break;
      default:
        if (event !== 'unknown') {
          console.log(`[${this.config.id}] Bilinmeyen event: ${event}`);
        }
    }

    this._updateTimestamp();
  }

  /**
   * hello event - ilk bağlantıda gelen tüm durum bilgisi
   */
  _processHello(data) {
    console.log(`[${this.config.id}] 📊 HELLO EVENT`);
    
    // Durum
    this.lastStatus.state = this._mapState(data);
    
    // Sıcaklıklar (hello'da custom_* alanları var)
    this.lastStatus.nozzle = parseFloat(data.custom_ext_temperature) || 0;
    this.lastStatus.bed = parseFloat(data.custom_bed_temperature) || 0;
    
    // İlerleme (katman bilgisinden hesapla)
    if (data.current_layer && data.total_layers) {
      this.lastStatus.progress = Math.round((data.current_layer / data.total_layers) * 100);
    }
    
    // Kalan süre (estimated_time string formatında: "03:19:23")
    this.lastStatus.remainingSeconds = this._parseTimeString(data.estimated_time);
    
    console.log(`[${this.config.id}] ✓ Durum: ${this.lastStatus.state}, İlerleme: ${this.lastStatus.progress}%, Nozul: ${this.lastStatus.nozzle}°C`);
  }

  /**
   * temperature_update event - periyodik sıcaklık güncellemesi
   */
  _processTemperature(data) {
    this.lastStatus.nozzle = parseFloat(data.ext_temp) || 0;
    this.lastStatus.bed = parseFloat(data.bed_temp) || 0;
    
    // 10 derece değişimde log et (spam azaltmak için)
    if (this.lastStatus.nozzle % 10 < 1) {
      console.log(`[${this.config.id}] 🌡️  Nozul: ${this.lastStatus.nozzle}°C, Yatak: ${this.lastStatus.bed}°C`);
    }
  }

  /**
   * print_progress event - yazdırma ilerleme yüzdesi
   */
  _processProgress(data) {
    this.lastStatus.progress = parseInt(data.progress) || 0;
    
    // Her %10'da log et
    if (this.lastStatus.progress % 10 === 0) {
      console.log(`[${this.config.id}] 📈 İlerleme: ${this.lastStatus.progress}%`);
    }
  }

  /**
   * layer_change event - katman değişikliği
   */
  _processLayerChange(data) {
    const current = data.current || 0;
    const total = data.total || 1;
    this.lastStatus.progress = Math.round((current / total) * 100);
    
    console.log(`[${this.config.id}] 🔄 Katman: ${current}/${total} (${this.lastStatus.progress}%)`);
  }

  /**
   * Durum map'leme
   * hello event'de boolean alanları kontrol et
   */
  _mapState(data) {
    // hello event'de kontrol
    if (data.is_printing === 'True' || data.is_printing === true) {
      return 'printing';
    }
    if (data.is_paused === 'True' || data.is_paused === true) {
      return 'paused';
    }
    if (data.is_error === 'True' || data.is_error === true) {
      return 'error';
    }
    if (data.is_heating === 'True' || data.is_heating === true) {
      return 'heating';
    }
    
    return 'idle';
  }

  /**
   * Zaman string'ini saniyeye çevir
   * "03:19:23" → 11963 saniye
   */
  _parseTimeString(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return 0;
    
    const parts = timeStr.split(':');
    if (parts.length !== 3) return 0;
    
    const hours = parseInt(parts[0]) || 0;
    const minutes = parseInt(parts[1]) || 0;
    const seconds = parseInt(parts[2]) || 0;
    
    return hours * 3600 + minutes * 60 + seconds;
  }

  /**
   * camera_frame / camera_snapshot event - kamera görüntüsü
   */
  _processCamera(data) {
    console.log(`      🔍 _processCamera çağrıldı`);
    console.log(`      📊 data keys:`, Object.keys(data));
    
    // Base64 image data'sını store et
    const imageData = data.frame || data.image || data.snapshot || data.data;
    
    console.log(`      🔍 Checking imageData:`);
    console.log(`         frame: ${data.frame ? '✅' : '❌'}`);
    console.log(`         image: ${data.image ? '✅' : '❌'}`);
    console.log(`         snapshot: ${data.snapshot ? '✅' : '❌'}`);
    console.log(`         data: ${data.data ? '✅' : '❌'}`);
    
    if (imageData) {
      // Adapter'da store et (server.js'den erişebilsin)
      this.lastCamera = {
        timestamp: Date.now(),
        data: imageData,
        type: data.type || 'image/jpeg',
        size: imageData.length
      };
      
      console.log(`[${this.config.id}] 📷 Kamera frame alındı (${imageData.length} bytes)`);
    } else {
      console.log(`[${this.config.id}] ⚠️  Kamera frame veri bulunamadı!`);
    }
  }

  async sendCommand(command, params = {}) {
    if (!this.isConnected || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Printer not connected');
    }
    
    // ✅ 'start' komutunu 'resume'a map et (diğer adapter'larla uyumlu)
    const cmdMap = {
      'start': 'resume',    // ← Başlat = Devam et
      'pause': 'pause',     // ← DURAKLAT
      'resume': 'resume',   // ← DEVAM ET
      // ✅ 3 Buton Sistemi:
      // [DURAKLAT] → pause
      // [DEVAM ET] → resume
      // [DURDUR] → cancel (ZAXE'de işlemi durdur anlamına gelir)
      'stop': 'cancel'      // ← DURDUR (gerçek cancel/stop)
    };
    
    const actualCommand = cmdMap[command] || command;

    // ✅ ZAXE 'hello' event'ini sadece ilk bağlantıda gönderir, sonra durumu (state)
    // güncellemez. Bu yüzden komut gönderince durumu HEMEN elle güncelliyoruz ki
    // arayüz duraklat/devam et durumunu doğru görebilsin.
    if (command === 'pause') {
      this.lastStatus.state = 'paused';
    } else if (command === 'resume' || command === 'start') {
      this.lastStatus.state = 'printing';
    } else if (command === 'stop') {
      this.lastStatus.state = 'idle';
      this.lastStatus.progress = 0;
      this.lastStatus.error = null;
    }

    const payload = JSON.stringify({ request: actualCommand, ...params });
    console.log(`[${this.config.id}] 📤 Komut gönderiliyor: ${command} (WebSocket: ${actualCommand})`);
    this.ws.send(payload);
  }

  /**
   * Kamera görüntüsü al
   */
  getCamera() {
    return this.lastCamera || null;
  }

  // ✅ Yüksek seviye komut metodları
  async startPrint() {
    return this.sendCommand('start');
  }

  async pausePrint() {
    return this.sendCommand('pause');
  }

  async resumePrint() {
    return this.sendCommand('resume');
  }

  async stopPrint() {
    return this.sendCommand('stop');
  }
}

export default ZaxeAdapter;
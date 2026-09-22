/**
 * Raise3D Pro3 — FINAL FIX
 * 13-Haneli Millisecond Timestamp ve Doğru İmza Algoritması
 */

import { PrinterAdapter } from './base.js';
import crypto from 'crypto';

export class Raise3DAdapter extends PrinterAdapter {
  constructor(config) {
    super(config);
    this.baseUrl = `http://${this.config.ip}:10800/v1`; //31625 portu dene
    this.token = null;
    
    // Loglarda gördüğümüz üzere şifreniz "admin". Eğer config'den gelmiyorsa admin'i kullanır.
    this.password = config.auth?.password || 'admin';  
    this.loginAttempts = 0;
    this.maxLoginAttempts = 3;
  }

  async connect() {
    try {
      console.log(`[${this.config.id}] Raise3D bağlanıyor (${this.baseUrl})...`);
      await this._login();
      this.isConnected = true;
      this.lastStatus.capabilities = ['temperature', 'progress', 'error', 'commands'];
      console.log(`[${this.config.id}] ✓ Raise3D bağlandı`);
      await this._updateStatus();
    } catch (err) {
      console.error(`[${this.config.id}] Raise3D error:`, err.message);
      this.isConnected = false;
      this.lastStatus.state = 'offline';
      throw err;
    }
  }

  /**
   * SIGNATURE GENERATION (Raise3D Standart Formatı)
   */
  _generateSignature(timestamp) {
    // KURAL: password=ŞİFRE&timestamp=13HANELİMİLİSANİYE
    const data = `password=${this.password}&timestamp=${timestamp}`;
    
    console.log(`[${this.config.id}] DEBUG (Gönderilen İmza Metni): "${data}"`);
    
    // Adım 1: SHA1
    const sha1Hash = crypto.createHash('sha1').update(data).digest('hex');
    
    // Adım 2: MD5
    const md5Hash = crypto.createHash('md5').update(sha1Hash).digest('hex');
    
    return md5Hash;
  }

  /**
   * LOGIN
   */
  async _login() {
    try {
      const controller = new AbortController();
      // Zaman aşımı engeli olmaması için 15 saniyelik cömert bir süre
      const timeout = setTimeout(() => controller.abort(), 15000); 

      // KURAL: Zorunlu 13 haneli Milisaniye (Date.now())
      const timestamp = Date.now(); 
      const sign = this._generateSignature(timestamp);

      const url = `${this.baseUrl}/login?sign=${encodeURIComponent(sign)}&timestamp=${timestamp}`;
      console.log(`[${this.config.id}] LOGIN İSTEĞİ ATILIYOR: ${url}`);

      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal
      });

      clearTimeout(timeout);

      const data = await response.json();

      if (data.status === 1 && (data.token || data.data?.token)) {
        this.token = data.token || data.data.token;
        this.loginAttempts = 0;
        console.log(`[${this.config.id}] ✓ Login başarılı, Token alındı: ${this.token.substring(0,6)}...`);
      } else {
        const errorMsg = data.error?.msg || 'Unknown error';
        const errorCode = data.error?.code || 'N/A';
        throw new Error(`Login failed: ${errorMsg} (code: ${errorCode})`);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.error(`[${this.config.id}] ❌ Zaman Aşımı: Yazıcıdan yanıt alınamadı.`);
      } else {
        console.error(`[${this.config.id}] Login hatası:`, err.message);
      }
      
      this.loginAttempts++;
      if (this.loginAttempts >= this.maxLoginAttempts) {
        throw new Error('Login başarısız (Maksimum deneme sınırına ulaşıldı)');
      }
      throw err;
    }
  }

  /**
   * STATUS UPDATE
   */
  async _updateStatus() {
    if (!this.isConnected || !this.token) {
      this.lastStatus.state = 'offline';
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const url = `${this.baseUrl}/printer/system?token=${encodeURIComponent(this.token)}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (response.status === 401) {
        console.warn(`[${this.config.id}] Token süresi doldu, yeniden login olunuyor...`);
        await this._login();
        return this._updateStatus();
      }

      if (!response.ok) {
        console.warn(`[${this.config.id}] Status API HTTP Hatası: ${response.status}`);
        this.isConnected = false;
        this.lastStatus.state = 'offline';
        return;
      }

      const data = await response.json();
      const printerData = data.data || data;

      this.lastStatus.state = this._mapState(printerData.state || printerData.status);
      this.lastStatus.nozzle = Math.round(printerData.nozzle_temp || printerData.left_nozzle_temp || 0);
      this.lastStatus.bed = Math.round(printerData.bed_temp || 0);
      this.lastStatus.progress = printerData.print_progress || printerData.progress || 0;
      this.lastStatus.remainingSeconds = printerData.remaining_time || 0;
      this.lastStatus.error = printerData.error || null;

      this._updateTimestamp();
    } catch (err) {
      console.error(`[${this.config.id}] Status çekme hatası:`, err.message);
      this.isConnected = false;
      this.lastStatus.state = 'offline';
    }
  }

  _mapState(state) {
    if (!state) return 'idle';
    const s = String(state).toLowerCase().trim();
    const map = {
      'idle': 'idle', 'ready': 'idle', 'printing': 'printing', 'print': 'printing',
      'paused': 'paused', 'pause': 'paused', 'error': 'error', 'offline': 'offline',
      'finished': 'finished', 'complete': 'finished'
    };
    return map[s] || 'idle';
  }

  async sendCommand(command, params = {}) {
    if (!this.isConnected || !this.token) throw new Error('Yazıcıya bağlı değil');
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      // ✅ 'start' komutunu 'resume'a map et
      const cmdMap = { 
        start: 'resume',   // ← Başlat = Devam et
        pause: 'pause', 
        resume: 'resume', 
        stop: 'stop', 
        cancel: 'stop' 
      };
      const url = `${this.baseUrl}/printer/control?token=${encodeURIComponent(this.token)}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmdMap[command] || command, ...params }),
        signal: controller.signal
      });

      clearTimeout(timeout);
      if (response.status === 401) {
        await this._login();
        return this.sendCommand(command, params);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      // ✅ Komut gönderilince durumu HEMEN güncelle (API geri bildirimi birkaç
      // saniye gecikebilir; arayüzün butonları anında değişsin diye).
      if (command === 'pause') {
        this.lastStatus.state = 'paused';
      } else if (command === 'resume' || command === 'start') {
        this.lastStatus.state = 'printing';
      } else if (command === 'stop') {
        this.lastStatus.state = 'idle';
        this.lastStatus.progress = 0;
        this.lastStatus.error = null;
      }
      
      console.log(`[${this.config.id}] ✅ Komut gönderildi: ${command} (API: ${cmdMap[command] || command})`);
      await new Promise(r => setTimeout(r, 500));
      await this._updateStatus();
    } catch (err) {
      console.error(`[${this.config.id}] Komut hatası:`, err.message);
      throw err;
    }
  }

  async pausePrint() { return this.sendCommand('pause'); }
  async startPrint() { return this.sendCommand('start'); }  // ← YENİ
  async resumePrint() { return this.sendCommand('resume'); }
  async stopPrint() { return this.sendCommand('stop'); }

  async disconnect() {
    this.isConnected = false;
    this.token = null;
    await super.disconnect();
  }
}

export default Raise3DAdapter;
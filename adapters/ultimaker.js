/**
 * Ultimaker 3 / 3 Extended / S3 / S5 için adapter
 * Dokunmatik ekran modelleri — /api/v1/ kullan
 *
 * ÖNEMLİ: Okuma (GET) kimlik doğrulama İSTEMEZ.
 * Port: 80 (varsayılan HTTP)
 */

import { PrinterAdapter } from './base.js';

export class UltimakerAdapter extends PrinterAdapter {
  constructor(config) {
    super(config);
    this.apiUrl = `http://${this.config.ip}/api/v1`;
  }

  async _get(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const separator = path.includes('?') ? '&' : '?';
      const url = `${this.apiUrl}${path}${separator}_t=${Date.now()}`;

      const res = await fetch(url, { 
        signal: controller.signal,
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status} @ ${path}`);
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  async connect() {
    try {
      console.log(`[${this.config.id}] Ultimaker bağlanıyor (${this.apiUrl})...`);
      const status = await this._get('/printer/status');
      this.isConnected = true;
      this.lastStatus.capabilities = ['temperature', 'progress', 'error'];
      console.log(`[${this.config.id}] ✓ Ultimaker bağlandı (durum: ${status})`);
      await this._updateStatus();
    } catch (err) {
      console.error(`[${this.config.id}] Ultimaker error:`, err.message);
      this.isConnected = false;
      throw err;
    }
  }

  async _updateStatus() {
    if (!this.isConnected) return;

    try {
      // 1) Yazıcı ana durumu
      const printerStatus = await this._get('/printer/status');

      // 2) Sıcaklıklar ve Hedef Sıcaklıklar (Fail-safe için kritik)
      let nozzle = 0, bed = 0;
      let nozzleTarget = 0;
      
      try {
        const hotend = await this._get('/printer/heads/0/extruders/0/hotend/temperature');
        nozzle = Math.round(hotend?.current ?? 0);
        nozzleTarget = Math.round(hotend?.target ?? 0); // Hedef sıcaklığı alıyoruz
      } catch { /* koruma */ }

      try {
        const bedTemp = await this._get('/printer/bed/temperature');
        bed = Math.round(bedTemp?.current ?? 0);
      } catch { }

      this.lastStatus.nozzle = nozzle;
      this.lastStatus.bed = bed;

      // İlk haritalandırmayı ana duruma göre yapıyoruz
      let mappedState = this._mapState(printerStatus);

      // 3) Eğer cihaz "printing" diyorsa detayları deşiyoruz
      if (mappedState === 'printing') { 
        try {
          const job = await this._get('/print_job');
          
          this.lastStatus.progress = Math.round((job?.progress ?? 0) * 100);
          const total = job?.time_total ?? 0;
          const elapsed = job?.time_elapsed ?? 0;
          this.lastStatus.remainingSeconds = Math.max(0, total - elapsed);

          // KONTROL 1: Eğer aktif işin iç durumu daha spesifikse (örn: completed, wait_cleanup) onu baz al
          if (job?.state) {
            mappedState = this._mapState(job.state);
          }

          // KONTROL 2 (AKILLI FİLTRE): Cihaz ısrarla printing dese bile;
          // İlerleme %0 ise VE nozul ısıtma hedefi 0°C ise bu cihaz YANILGIYA DÜŞMÜŞTÜR, aslında boştadır.
          if (mappedState === 'printing' && this.lastStatus.progress === 0 && nozzleTarget === 0) {
            mappedState = 'idle';
          }

          this.lastStatus.state = mappedState;
        } catch {
          // Job detayına ulaşılamadıysa ve hedef sıcaklık yoksa boşta say
          this.lastStatus.state = (nozzleTarget === 0) ? 'idle' : 'printing';
        }
      } else {
        this.lastStatus.progress = 0;
        this.lastStatus.remainingSeconds = 0;
        this.lastStatus.state = mappedState; 
      }

      this.lastStatus.error = (printerStatus === 'error') ? '⚠️ Yazıcı hatası' : null;
      this._updateTimestamp();
    } catch (err) {
      console.error(`[${this.config.id}] Status error:`, err.message);
      this.isConnected = false;
      this.lastStatus.state = 'offline';
    }
  }

  _mapState(s) {
    const map = {
      idle: 'idle',
      printing: 'printing',
      error: 'error',
      maintenance: 'idle',
      booting: 'idle',
      
      // Ultimaker Genişletilmiş Durum Haritası
      pre_print: 'printing',    // Hazırlık/Isınma aşaması
      post_print: 'printing',   // Baskı bitti, soğuma aşaması
      wait_cleanup: 'idle',     // Ekranda onay bekliyor (Fiziksel olarak boşta)
      completed: 'idle',        // İş bitti
      aborted: 'idle',          // İptal edildi
      failed: 'error'           // Başarısız oldu
    };
    return map[String(s).toLowerCase()] || 'idle';
  }

  async sendCommand(command) {
    // Ultimaker yazıcılar salt-okunur moda ayarlanmıştır.
    // Komut göndermek için yazıcı yönetim arayüzünde eşleştirme yapılması gereklidir.
    throw new Error(`⚠️ ${this.config.id}: Ultimaker komutları (${command}) şu an desteklenmemektedir. Yazıcı yönetim arayüzünde eşleştirme yapınız.`);
  }

  // ✅ Yüksek seviye metodlar (frontend uyumluluk için)
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

  async disconnect() {
    this.isConnected = false;
    await super.disconnect();
  }
}

export default UltimakerAdapter;
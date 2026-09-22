/**
 * Bambu Lab yazıcıları için adapter (KAMERA İLE)
 * MQTT protokolü ile LAN'da iletişim + RTSP stream URL
 */

import mqtt from 'mqtt';
import { PrinterAdapter } from './base.js';

export class BambuAdapter extends PrinterAdapter {
  constructor(config) {
    super(config);
    this.mqttClient = null;
    this.lastFullReport = {};
    this.serial = config.serial || null;

    // ── Baskı süresi takibi (üretim kaydı için) ──
    this._trackedTaskId      = null;   // izlenen baskının task_id'si
    this._printStartedAt     = null;   // ms — baskı başlangıcı
    this._finishedDurationMin = null;  // dk — biten baskının ölçülen süresi
    this._finishedTaskId     = null;   // _finishedDurationMin HANGİ task'a ait (bayatlamayı önler)

    // ── Kullanılan filament hafızası ──
    // Baskı bitince yazıcı "tray_now"ı sıfırlayıp harici makaraya dönebiliyor;
    // o an okursak YANLIŞ filament türü görürüz. Bu yüzden baskı AKTİFKEN
    // hangi göz kullanılıyorsa onu donduruyoruz, bitince o değeri koruyoruz.
    this._usedFilament       = null;   // { type, color, weight } — baskı sırasında dondurulan
    this._usedFilamentTaskId = null;   // dondurulan veri hangi task'a ait

    // ── Baskı adı (malzeme ismi) hafızası ──
    // Bazı firmware sürümleri baskı bitip IDLE'a geçince subtask_name'i
    // boşaltıyor/değiştiriyor olabilir. Filament ile aynı mantık: baskı
    // AKTİFKEN doluysa donduruyoruz, bitince o değeri koruyoruz.
    this._usedSubtaskName       = null;
    this._usedSubtaskNameTaskId = null;
    this._usedSubtaskNameTuretildi = false;  // true: gerçek isim değil, dosya yolundan türetildi
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const url = `mqtts://${this.config.ip}:8883`;
      console.log(`[${this.config.id}] MQTT bağlanıyor: ${url}`);

      this.mqttClient = mqtt.connect(url, {
        username: 'bblp',
        password: this.config.accessCode,
        rejectUnauthorized: false,
        reconnectPeriod: 5000,
        connectTimeout: 10000
      });

      const connectionTimeout = setTimeout(() => {
        reject(new Error('MQTT connection timeout'));
      }, 15000);

      this.mqttClient.on('connect', () => {
        clearTimeout(connectionTimeout);
        console.log(`[${this.config.id}] ✓ MQTT bağlandı`);
        this.isConnected = true;
        this.lastStatus.capabilities = ['temperature', 'progress', 'error', 'commands'];

        const topic = this.serial ? `device/${this.serial}/report` : 'device/+/report';
        this.mqttClient.subscribe(topic, (err) => {
          if (err) console.error(`[${this.config.id}] Subscribe hatası:`, err.message);
          else console.log(`[${this.config.id}] Dinleniyor: ${topic}`);
        });

        if (this.serial) this._requestFullStatus();  
        resolve();
      });

      this.mqttClient.on('message', (topic, message) => {
        if (!this.serial) {
          const m = topic.match(/^device\/(.+)\/report$/);
          if (m) {
            this.serial = m[1];
            console.log(`[${this.config.id}] ✓ Seri no öğrenildi: ${this.serial}`);
            this._requestFullStatus();  
          }
        }
        this._onMessage(message);
      });

      this.mqttClient.on('error', (err) => {
        console.error(`[${this.config.id}] MQTT error:`, err.message);
        this.isConnected = false;
        this.lastStatus.state = 'offline';
      });

      this.mqttClient.on('close', () => {
        this.isConnected = false;
      });
    });
  }

  _requestFullStatus() {
    if (!this.serial) return;
    const msg = { pushing: { sequence_id: '0', command: 'pushall' } };
    this.mqttClient.publish(`device/${this.serial}/request`, JSON.stringify(msg));
  }

  _onMessage(message) {
    try {
      const data = JSON.parse(message.toString());

      if (data.print) {
        this.lastFullReport.print = { ...(this.lastFullReport.print || {}), ...data.print };
      }
      for (const key of Object.keys(data)) {
        if (key !== 'print') this.lastFullReport[key] = data[key];
      }

      const print = this.lastFullReport.print || {};

      if (print.gcode_state)            this.lastStatus.state           = this._mapState(print.gcode_state);
      if (print.nozzle_temper != null)  this.lastStatus.nozzle          = print.nozzle_temper;
      if (print.bed_temper != null)     this.lastStatus.bed             = print.bed_temper;
      if (print.chamber_temper != null) this.lastStatus.chamber         = print.chamber_temper;
      if (print.mc_percent != null)     this.lastStatus.progress        = print.mc_percent;
      if (print.mc_remaining_time != null) this.lastStatus.remainingSeconds = print.mc_remaining_time * 60; 
      if (print.layer_num != null)      this.lastStatus.currentLayer    = print.layer_num;
      if (print.total_layer_num != null) this.lastStatus.totalLayers    = print.total_layer_num;
      if (print.hms)                    this.lastStatus.error           = this._parseError(print.hms);
      
      // 🎬 KAMERA STREAM URL'Sİ
      if (print.ipcam?.rtsp_url)  this.lastStatus.cameraUrl = print.ipcam.rtsp_url;

      // ⏱ Baskı süresi + kullanılan filament takibi (üretim kaydında kullanılır)
      this._onPrintUpdate(print);

      this._updateTimestamp();
    } catch (err) {
      console.error(`[${this.config.id}] Message parse error:`, err.message);
    }
  }

  _mapState(state) {
    if (!state) return this.lastStatus.state || 'idle';
    const s = String(state).toUpperCase().trim();
    
    const map = {
      'IDLE': 'idle',
      'PREPARE': 'preparing',
      'SLICING': 'preparing',
      'RUNNING': 'printing',
      'PAUSED': 'paused',
      'PAUSE': 'paused',
      'FINISH': 'finished',
      'FAILED': 'error'
    };
    return map[s] || 'idle';
  }

  _parseError(hmsArray) {
    if (!hmsArray || !Array.isArray(hmsArray) || hmsArray.length === 0) return null;

    const filtered = hmsArray.filter(h => {
      const rawCode = typeof h === 'string' ? h : (h?.code || h?.attr || '');
      const strCode = String(rawCode);
      return !strCode.startsWith('0500') && !strCode.startsWith('0400');
    });
    
    if (filtered.length === 0) return null;  

    const first = filtered[0];
    const rawCode = typeof first === 'string' ? first : (first?.code || first?.attr || JSON.stringify(first));
    const strCode = String(rawCode);

    const hmsMap = {
      '0500-0300-0002-000E': 'Modül uyumsuzluğu (firmware)',
      '0500-0400-0001-0044': 'AMS firmware uyumsuzluğu',
      '0500-0500-0001-0007': 'MQTT doğrulama hatası',
      '0100-0000-0019-0004': 'Filament sona erdi',
      '0100-0000-0014-0040': 'Kapı açık'
    };
    
    if (hmsMap[strCode]) {
      return `⚠️ ${hmsMap[strCode]}`;
    }
    
    return null;
  }

  async sendCommand(command, params = {}) {
    if (!this.isConnected) throw new Error('Printer not connected');
    if (!this.serial) throw new Error('Seri no bilinmiyor — komut gönderilemez');

    const seq = Date.now().toString();
    
    // ✅ 'start' komutunu 'resume'a map et
    const cmdMap = {
      start:  { print: { sequence_id: seq, command: 'resume' } },  // ← Başlat = Devam et
      pause:  { print: { sequence_id: seq, command: 'pause' } },   // ← DURAKLAT
      resume: { print: { sequence_id: seq, command: 'resume' } },  // ← DEVAM ET
      // ✅ 3 Buton Sistemi:
      // [DURAKLAT] → pause
      // [DEVAM ET] → resume
      // [DURDUR] → stop (gerçek stop!)
      stop:   { print: { sequence_id: seq, command: 'stop' } }     // ← DURDUR (gerçek stop)
    };
    const payload = cmdMap[command];
    if (!payload) throw new Error(`Unknown command: ${command}`);

    return new Promise((resolve, reject) => {
      this.mqttClient.publish(
        `device/${this.serial}/request`,
        JSON.stringify(payload),
        { qos: 1 },
        (err) => {
          if (err) reject(err);
          else { 
            // ✅ Komut gönderilince durumu HEMEN güncelle (MQTT geri bildirimi birkaç
            // saniye gecikebilir; arayüzün butonları anında değişsin diye).
            // MQTT'den gerçek durum gelince zaten üzerine yazılır.
            if (command === 'pause') {
              this.lastStatus.state = 'paused';
            } else if (command === 'resume' || command === 'start') {
              this.lastStatus.state = 'printing';
            } else if (command === 'stop') {
              this.lastStatus.state = 'idle';
              this.lastStatus.error = null;
            }
            console.log(`[${this.config.id}] ✅ Komut gönderildi: ${command} (MQTT: ${cmdMap[command].print.command})`); 
            resolve(); 
          }
        }
      );
    });
  }

  // ✅ Yüksek seviye metodlar
  async startPrint()  { return this.sendCommand('start'); }   // ← YENİ: start komutu
  async pausePrint()  { return this.sendCommand('pause'); }
  async resumePrint() { return this.sendCommand('resume'); }
  async stopPrint()   { return this.sendCommand('stop'); }

  // ═══════════════════════════════════════════════════════════════
  // ⏱ BASKI SÜRESİ + 🧵 KULLANILAN FİLAMENT TAKİBİ
  // Bambu LAN MQTT'de ne "toplam baskı süresi" ne de "kullanılan gramaj"
  // alanı var — bu yüzden ikisi de CANLI izlenerek elde edilir:
  //   • Süre: RUNNING'de sayaç başlar, FINISH'te durur.
  //   • Filament: hangi AMS gözü/harici makara aktifse, baskı sürerken
  //     dondurulur. Baskı bitince yazıcı tray_now'ı sıfırlayıp harici
  //     makaraya dönebiliyor — o an okursak YANLIŞ tür görürüz, bu yüzden
  //     sadece printing/preparing/paused sırasında güncelleriz, sonrasında
  //     dondurulmuş değeri korur, üzerine yazmayız.
  //
  // Her ikisi de TEK bir yerden (_onPrintUpdate) yeni baskı algılar ve
  // sıfırlar — böylece bir önceki baskının verisi yenisine sızamaz.
  // ═══════════════════════════════════════════════════════════════

  _onPrintUpdate(print) {
    const taskId = print.task_id != null ? String(print.task_id) : null;

    // Yeni baskı algılandı → SÜRE ve FİLAMENT hafızasının ikisini de sıfırla.
    // (Eskiden sadece süre sıfırlanıyordu; bir önceki baskının "ölçülen süresi"
    //  yenisine stale olarak sızabiliyordu — bu artık engellendi.)
    if (taskId && taskId !== this._trackedTaskId) {
      this._trackedTaskId            = taskId;
      this._printStartedAt           = null;
      this._finishedDurationMin      = null;
      this._finishedTaskId           = null;
      this._usedFilament             = null;
      this._usedFilamentTaskId       = null;
      this._usedSubtaskName          = null;
      this._usedSubtaskNameTaskId    = null;
      this._usedSubtaskNameTuretildi = false;
    }

    this._trackDuration(print, taskId);
    this._trackFilament(print, taskId);
    this._trackSubtaskName(print, taskId);
  }

  /** Dosya yolundan ("/data/Metadata/plate_2.gcode" → "plate_2") okunabilir bir isim türetir */
  _dosyaAdindanIsimTuret(yol) {
    if (!yol) return null;
    const parca = String(yol).split(/[\\/]/).pop();      // son parça: "plate_2.gcode"
    if (!parca) return null;
    const uzantisiz = parca.replace(/\.(gcode|3mf|g)$/i, '');  // uzantıyı at
    return uzantisiz || null;
  }

  _trackSubtaskName(print, taskId) {
    const state = this._mapState(print.gcode_state);
    // Filament ile aynı prensip: sadece baskı aktifken güncelle, bitince/idle'da
    // DOKUNMA — aksi halde firmware subtask_name'i boşaltırsa elimizdeki doğru
    // isim sessizce silinir.
    if (state !== 'printing' && state !== 'preparing' && state !== 'paused') return;

    // 1. tercih: gerçek baskı adı (subtask_name)
    const isim = print.subtask_name;
    if (isim && String(isim).trim() !== '') {
      this._usedSubtaskName = String(isim).trim();
      this._usedSubtaskNameTaskId = taskId;
      this._usedSubtaskNameTuretildi = false;
      return;
    }

    // 2. tercih: subtask_name boşsa, dosya yolundan türet (gerçek isim DEĞİL ama boş kalmasın)
    // Not: bu daha önce doğru bir isim yakalanmışsa (henüz yeni task algılanmadıysa) üzerine YAZMAZ.
    if (this._usedSubtaskName && !this._usedSubtaskNameTuretildi && this._usedSubtaskNameTaskId === taskId) return;
    const turetilen = this._dosyaAdindanIsimTuret(print.gcode_file || print.file);
    if (turetilen) {
      this._usedSubtaskName = turetilen;
      this._usedSubtaskNameTaskId = taskId;
      this._usedSubtaskNameTuretildi = true;
    }
  }

  _trackDuration(print, taskId) {
    const state = this._mapState(print.gcode_state);
    const now   = Date.now();

    if (state === 'printing') {
      if (!this._printStartedAt) {
        // Sunucu baskının ortasında devreye girmiş olabilir:
        // yüzde + kalan süreden geçmiş süreyi tahmin edip başlangıcı geriye al.
        const gecen = this._tahminiGecenSureDk(print);
        this._printStartedAt = now - (gecen != null ? gecen * 60000 : 0);
      }
    } else if (state === 'finished') {
      if (this._printStartedAt) {
        this._finishedDurationMin = Math.max(1, Math.round((now - this._printStartedAt) / 60000));
        this._finishedTaskId      = taskId;
        this._printStartedAt      = null;
        console.log(`[${this.config.id}] ⏱ Baskı tamamlandı — ölçülen süre: ${this._finishedDurationMin} dk (task ${taskId})`);
      }
      // this._printStartedAt hiç set edilmediyse (sunucu baskıyı hiç canlı izlemedi):
      // _finishedDurationMin bilerek null bırakılır — uydurma yapılmaz.
    } else if (state === 'idle' || state === 'error') {
      this._printStartedAt = null;
    }
  }

  /** tray objesinden temiz bir anlık görüntü çıkarır */
  _traySnapshot(tray) {
    const w = parseFloat(tray.tray_weight);
    return {
      type:   tray.tray_type ? String(tray.tray_type).trim().toUpperCase() : null,
      color:  this._hexToColor(tray.tray_color),
      weight: Number.isFinite(w) && w > 0 ? w : null
    };
  }

  /**
   * Aktif tray'i BULUR — index'e (tray[trayNow]) değil, tray'in KENDİ "id"
   * alanına göre eşleştirir. Dizideki sıra ile gerçek göz numarası her zaman
   * birebir örtüşmeyebilir (bir göz boşsa/çıkarılmışsa dizi kayabilir, ya da
   * birden fazla AMS ünitesi varsa index tek bir üniteyi varsayar).
   * Ayrıca TÜM AMS ünitelerini (ams.ams dizisindeki hepsini) tarar —
   * eskiden sadece ams[0] (ilk ünite) bakılıyordu.
   */
  _aktifTrayiBul(print, trayNowStr) {
    const uniteler = print.ams?.ams;
    if (!Array.isArray(uniteler)) return null;
    for (const unite of uniteler) {
      const bulunan = (unite?.tray || []).find(t => t && String(t.id) === trayNowStr);
      if (bulunan && bulunan.tray_type) return bulunan;
    }
    return null;
  }

  _trackFilament(print, taskId) {
    const state = this._mapState(print.gcode_state);
    // SADECE aktif baskı sırasında güncelle. Bitince/idle'da DOKUNMA —
    // aksi halde tray_now sıfırlanınca (255) harici makaranın o anki
    // (baskıyla ilgisiz) içeriği üzerine yazar ve yanlış tür gösterilir.
    if (state !== 'printing' && state !== 'preparing' && state !== 'paused') return;

    const trayNowRaw = print.ams?.tray_now;
    const trayNow = parseInt(trayNowRaw, 10);

    if (Number.isFinite(trayNow) && trayNow >= 0 && trayNow < 250) {
      // ÖNCE id bazlı ara (güvenilir) — bulamazsa eski index yöntemine düş (geriye dönük uyum)
      let tray = this._aktifTrayiBul(print, String(trayNowRaw));
      if (!tray) tray = print.ams?.ams?.[0]?.tray?.[trayNow];

      if (tray && tray.tray_type) {
        this._usedFilament = this._traySnapshot(tray);
        this._usedFilamentTaskId = taskId;
        console.log(`[${this.config.id}] 🧵 Filament yakalandı: tray_now=${trayNowRaw} → ${this._usedFilament.type} (${this._usedFilament.color}) [task ${taskId}]`);
      } else {
        console.log(`[${this.config.id}] ⚠ Filament OKUNAMADI: tray_now=${trayNowRaw} ama eşleşen göz bulunamadı. AMS ham veri: ${JSON.stringify(print.ams?.ams)}`);
      }
      return;
    }
    // AMS yok / harici makara kullanılıyor (tray_now tipik olarak 254-255)
    const harici = print.vt_tray || print.vir_slot?.[0];
    if (harici && harici.tray_type) {
      this._usedFilament = this._traySnapshot(harici);
      this._usedFilamentTaskId = taskId;
    }
  }

  /**
   * Yüzde ve kalan süreden geçmiş süreyi tahmin eder.
   * Bambu: mc_percent = 0..100, mc_remaining_time = KALAN DAKİKA
   * Örn: %66 & 13 dk kalan → toplam ≈ 38 dk, geçen ≈ 25 dk
   */
  _tahminiGecenSureDk(print) {
    const pct    = Number(print?.mc_percent);
    const kalan  = Number(print?.mc_remaining_time);
    if (!Number.isFinite(pct) || !Number.isFinite(kalan)) return null;
    if (pct <= 0 || pct >= 100 || kalan < 0) return null;
    const toplam = kalan / (1 - pct / 100);
    const gecen  = toplam - kalan;
    return Number.isFinite(gecen) && gecen >= 0 ? Math.round(gecen) : null;
  }

  /**
   * Üretim kaydı için çalışma süresi.
   * @returns {{dakika:(number|null), kaynak:'olculen'|'devam-ediyor'|'tahmin'|'yok'}}
   */
  getCalismaSuresi() {
    // _finishedDurationMin YALNIZCA güncel takip edilen task'a aitse güvenilir —
    // aksi halde bir önceki baskının süresi yenisine sızmış olur (düzeltilen bug).
    if (this._finishedDurationMin != null && this._finishedTaskId === this._trackedTaskId) {
      return { dakika: this._finishedDurationMin, kaynak: 'olculen' };
    }
    if (this._printStartedAt) {
      return { dakika: Math.max(1, Math.round((Date.now() - this._printStartedAt) / 60000)), kaynak: 'devam-ediyor' };
    }
    const t = this._tahminiGecenSureDk(this.lastFullReport.print || {});
    if (t != null) return { dakika: t, kaynak: 'tahmin' };
    return { dakika: null, kaynak: 'yok' };
  }

  // ═══════════════════════════════════════════════════════════════
  // 🔧 ÜRETİM KAYDI VERİSİ
  // Yazıcıdan gelenler doldurulur; gelmeyenler null bırakılır (uydurulmaz).
  // ═══════════════════════════════════════════════════════════════

  extractPrintData() {

    const print = this.lastFullReport.print || {};
    const uyarilar = [];
    const taskId = print.task_id != null ? String(print.task_id) : null;

    const tarih      = new Date().toISOString().split('T')[0];
    const yazici_no  = this.config.id;

    // Malzeme adı: ÖNCE dondurulmuş hafızaya bak (baskı aktifken yakalanan).
    // Hafızada bu task için yoksa mevcut (anlık) alana, o da yoksa dosya yoluna düş.
    let malzeme_ismi = '';
    let malzemeTuretildi = false;
    if (this._usedSubtaskName && this._usedSubtaskNameTaskId === taskId) {
      malzeme_ismi = this._usedSubtaskName;
      malzemeTuretildi = this._usedSubtaskNameTuretildi;
    } else if (print.subtask_name) {
      malzeme_ismi = print.subtask_name;
    } else {
      const turetilen = this._dosyaAdindanIsimTuret(print.gcode_file || print.file);
      if (turetilen) { malzeme_ismi = turetilen; malzemeTuretildi = true; }
    }

    if (!malzeme_ismi) {
      uyarilar.push('Baskı adı yazıcıdan okunamadı — elle girin.');
    } else if (malzemeTuretildi) {
      uyarilar.push(`Baskı adı yazıcı tarafından gönderilmedi; dosya yolundan türetildi ("${malzeme_ismi}") — gerçek adı biliyorsanız düzeltin.`);
    }

    // ── Filament: ÖNCE dondurulmuş hafızaya bak (baskı sırasında yakalanan) ──
    // Baskı bitince yazıcı tray_now'ı sıfırlayıp harici makaraya dönebiliyor;
    // o an ANLIK okursak baskıda hiç kullanılmamış bambaşka bir filament türü
    // görebiliriz. Bu yüzden _trackFilament()'ın donmuş verisi ESAS alınır.
    let filament_turu   = null;
    let filament_rengi  = null;
    let filament_gramaji = null;   // ⚠ Bambu LAN'da kullanılan gramaj YAYINLANMIYOR
    let filamentGuvenilir = false;

    if (this._usedFilament && this._usedFilamentTaskId === taskId) {
      filament_turu     = this._usedFilament.type;
      filament_rengi    = this._usedFilament.color;
      filament_gramaji  = this._usedFilament.weight;
      filamentGuvenilir = true;
    } else {
      // Hafızada yok — sunucu bu baskıyı hiç canlı izlememiş demektir.
      // Anlık okuma dener ama bu YANILTICI olabilir (bitmiş baskıda tray_now
      // sıfırlanmış/harici makaraya dönmüş olabilir) — bu yüzden güçlü uyarı verilir.
      const trayNow = parseInt(print.ams?.tray_now, 10);
      let tray = null;
      if (Number.isFinite(trayNow) && trayNow >= 0 && trayNow < 250) {
        tray = print.ams?.ams?.[0]?.tray?.[trayNow] || null;
      }
      if (!tray) tray = print.vt_tray || print.vir_slot?.[0] || null;
      if (tray) {
        filament_turu  = tray.tray_type ? String(tray.tray_type).trim().toUpperCase() : null;
        filament_rengi = this._hexToColor(tray.tray_color);
        const w = parseFloat(tray.tray_weight);
        if (Number.isFinite(w) && w > 0) filament_gramaji = w;
      }
      uyarilar.push('⚠ Bu baskının filament türü/rengi CANLI İZLENEMEDİ (sunucu baskı sırasında bağlı değildi). ' +
                    'Gösterilen değer yazıcının ŞU ANKİ durumundan okundu ve YANLIŞ OLABİLİR — mutlaka kontrol edin.');
    }

    if (!filament_turu)  uyarilar.push('Filament türü okunamadı — elle seçin.');
    if (filament_gramaji === null) {
      uyarilar.push('Filament gramajı yazıcıdan gelmiyor (Bambu LAN bu veriyi yayınlamaz) — ELLE GİRİN.');
    }

    // ── Çalışma süresi ──
    const sure = this.getCalismaSuresi();
    if (sure.kaynak === 'tahmin')       uyarilar.push('Çalışma süresi yüzdeden TAHMİN edildi — kontrol edin.');
    if (sure.kaynak === 'devam-ediyor') uyarilar.push('Baskı hâlâ sürüyor — süre şu ana kadar geçen zamandır.');
    if (sure.kaynak === 'yok') {
      uyarilar.push('Çalışma süresi ölçülemedi (sunucu bu baskıyı canlı izlemedi) — yazıcı ekranındaki ' +
                    '"Print Complete" ekranında görünen süreyi elle girin.');
    }

    const bitti = print.gcode_state === 'FINISH';
    if (!bitti) uyarilar.push('Son baskı tamamlanmış görünmüyor (durum: ' + (print.gcode_state || 'bilinmiyor') + ').');

    return {
      tarih,
      yazici_no,
      masraf_kodu: null,       // elle
      bolum: null,             // elle
      malzeme_ismi,
      adet: 1,
      filament_turu,
      filament_rengi,
      filament_gramaji,        // null → elle
      calisma_suresi: sure.dakika,
      orijinal_fiyati: null,   // elle
      proje_bedeli: null,      // elle
      siniflandirma: 'DIĞER',
      aciklama: `Bambu Lab otomatik çekim | Task ID: ${print.task_id || 'N/A'}`,

      // ── Metadata (UI bilgilendirmesi için) ──
      _source: 'bambu',
      _taskId: print.task_id ?? null,
      _tamamlandi: bitti,
      _sureKaynak: sure.kaynak,
      _gramajKaynak: filament_gramaji === null ? 'yok' : 'yazici',
      _filamentGuvenilir: filamentGuvenilir,
      _nozzleTemp: print.nozzle_temper ?? null,
      _bedTemp: print.bed_temper ?? null,
      _layers: print.total_layer_num ?? null,
      _yuzde: print.mc_percent ?? null,
      _uyarilar: uyarilar
    };
  }

  /** HEX renk kodunu Türkçe renk adına çevirir (bilinmeyen kodlar HEX olarak kalır) */
  _hexToColor(hexCode) {
    if (!hexCode) return null;
    const colors = {
      'FFFFFF': 'Beyaz',  '000000': 'Siyah',   '161616': 'Siyah',
      '0ACC38': 'Yeşil',  '2850E0': 'Mavi',    'FF0000': 'Kırmızı',
      'FFFF00': 'Sarı',   'FFA500': 'Turuncu', 'FFC0CB': 'Pembe',
      'A020F0': 'Mor',    '808080': 'Gri',     'C0C0C0': 'Gümüş',
      '8B4513': 'Kahverengi'
    };
    const base = String(hexCode).substring(0, 6).toUpperCase();
    return colors[base] || ('#' + base);
  }

  async disconnect() {
    if (this.mqttClient) this.mqttClient.end();
    await super.disconnect();
  }
}

export default BambuAdapter;
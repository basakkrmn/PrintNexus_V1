/**
 * Flashforge Guider 2S için adapter (GELİŞTİRİLMİŞ)
 * TCP Socket ile iletişim (Flashforge protokolü, port 8899)
 * Persistent bağlantı + düzgün response handling
 */

import net from 'net';
import { PrinterAdapter } from './base.js';

export class GuiderAdapter extends PrinterAdapter {
  constructor(config) {
    super(config);
    this.port = 8899; // Flashforge TCP portu
    this.socket = null;
    this.reconnectInterval = null;
  }

  async connect() {
    try {
      console.log(`[${this.config.id}] Guider bağlanıyor (TCP ${this.config.ip}:${this.port})...`);

      // Persistent socket oluştur
      this.socket = net.createConnection({
        host: this.config.ip,
        port: this.port,
        timeout: 5000
      });

      return new Promise((resolve, reject) => {
        const onConnect = () => {
          this.isConnected = true;
          this.lastStatus.capabilities = ['temperature', 'progress', 'error'];
          console.log(`[${this.config.id}] ✓ Guider bağlandı`);
          
          // Başlangıç durumunu oku
          this._updateStatus().catch(err => 
            console.error(`[${this.config.id}] Initial status error:`, err.message)
          );
          
          resolve();
        };

        const onError = (err) => {
          this.isConnected = false;
          console.error(`[${this.config.id}] Guider error:`, err.message);
          this.socket = null;
          reject(err);
        };

        const onTimeout = () => {
          this.isConnected = false;
          this.socket?.destroy();
          this.socket = null;
          reject(new Error('Connection timeout'));
        };

        this.socket.once('connect', onConnect);
        this.socket.once('error', onError);
        this.socket.once('timeout', onTimeout);

        // Reconnect handler
        this.socket.on('close', () => {
          this.isConnected = false;
          this.socket = null;
        });
      });
    } catch (err) {
      console.error(`[${this.config.id}] Connect error:`, err.message);
      this.isConnected = false;
      throw err;
    }
  }

  /**
   * Flashforge TCP komutu gönder ve response bekle
   */
  _sendCommand(cmd) {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.isConnected) {
        return reject(new Error('Socket not connected'));
      }

      let response = '';
      const timeout = setTimeout(() => {
        reject(new Error(`TCP timeout on command: ${cmd}`));
      }, 3000);

      const onData = (data) => {
        response += data.toString();
        
        // Flashforge protokolü: ~ ile başlar, newline ile biter
        if (response.includes('\n')) {
          clearTimeout(timeout);
          this.socket.removeListener('data', onData);
          resolve(response.trim());
        }
      };

      const onError = (err) => {
        clearTimeout(timeout);
        this.socket.removeListener('data', onData);
        reject(err);
      };

      this.socket.once('error', onError);
      this.socket.on('data', onData);

      // Komut gönder: Flashforge protokolü ~COMMAND\r\n
      this.socket.write(`~${cmd}\r\n`);
    });
  }

  async _updateStatus() {
    if (!this.isConnected) {
      this.lastStatus.state = 'offline';
      return;
    }

    try {
      // M119: Durum bilgisi
      const statusStr = await this._sendCommand('M119');
      // M105: Sıcaklık bilgisi  
      const tempStr = await this._sendCommand('M105');

      // Durum belirleme
      const isPrinting = statusStr.includes('Building') || 
                         statusStr.includes('Transferring');
      const isPaused = statusStr.includes('Paused');

      // Sıcaklık parse et
      const nozzleMatch = tempStr.match(/T0:(\d+)/);
      const bedMatch = tempStr.match(/B:(\d+)/);

      this.lastStatus.nozzle = nozzleMatch ? parseInt(nozzleMatch[1]) : 0;
      this.lastStatus.bed = bedMatch ? parseInt(bedMatch[1]) : 0;

      if (isPaused) {
        this.lastStatus.state = 'paused';
      } else if (isPrinting) {
        this.lastStatus.state = 'printing';
      } else {
        this.lastStatus.state = 'idle';
      }

      this.lastStatus.error = statusStr.includes('error') ? 
        '⚠️ Yazıcı hatası' : null;

      this._updateTimestamp();
    } catch (err) {
      console.error(`[${this.config.id}] Status error:`, err.message);
      this.lastStatus.state = 'offline';
      this.isConnected = false;
    }
  }

  async sendCommand(command, params = {}) {
    if (!this.isConnected) throw new Error('Printer not connected');

    // ✅ 'start' komutunu 'resume' (M24) GCode'a map et
    const cmdMap = {
      'start': 'M24',   // Devam et (resume)
      'pause': 'M25',   // Duraklat
      'resume': 'M24',  // Devam et
      'stop': 'M26'     // Durdur
    };

    const gcode = cmdMap[command];
    if (!gcode) throw new Error(`Unknown command: ${command}`);

    try {
      await this._sendCommand(gcode);
      
      // ✅ Komut gönderilince durumu HEMEN güncelle
      if (command === 'pause') {
        this.lastStatus.state = 'paused';
      } else if (command === 'resume' || command === 'start') {
        this.lastStatus.state = 'printing';
      } else if (command === 'stop') {
        this.lastStatus.state = 'idle';
        this.lastStatus.progress = 0;
        this.lastStatus.error = null;
      }
      
      console.log(`[${this.config.id}] ✅ Komut gönderildi: ${command} (GCode: ${gcode})`);
    } catch (err) {
      console.error(`[${this.config.id}] Command error:`, err.message);
      throw err;
    }
  }

  async pausePrint() { return this.sendCommand('pause'); }
  async startPrint() { return this.sendCommand('start'); }  // ← YENİ
  async resumePrint() { return this.sendCommand('resume'); }
  async stopPrint() { return this.sendCommand('stop'); }

  async disconnect() {
    this.isConnected = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    await super.disconnect();
  }
}

export default GuiderAdapter;
/**
 * PrinterAdapter - Tüm yazıcı adaptörlerinin temel sınıfı
 * ES6 modules formatında
 */

export class PrinterAdapter {
  constructor(config) {
    this.config = config;
    this.isConnected = false;
    
    this.lastStatus = {
      id: config.id,
      name: config.name,
      type: config.type,
      state: 'offline',
      nozzle: null,
      bed: null,
      chamber: null,
      progress: 0,
      remainingSeconds: 0,
      remainingMinutes: 0,
      currentLayer: null,
      totalLayers: null,
      error: null,
      cameraUrl: null,  // ← KAMERA URL'Sİ
      lastUpdate: null,
      capabilities: []
    };
  }

  async connect() {
    throw new Error('connect() must be implemented in subclass');
  }

  async disconnect() {
    this.isConnected = false;
  }

  getStatus() {
    this.lastStatus.remainingMinutes = Math.round(
      this.lastStatus.remainingSeconds / 60
    );
    return this.lastStatus;
  }

  async sendCommand(command, params = {}) {
    throw new Error('sendCommand() must be implemented in subclass');
  }

  _updateTimestamp() {
    this.lastStatus.lastUpdate = Math.floor(Date.now() / 1000);
  }
}

export default PrinterAdapter;
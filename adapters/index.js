/**
 * Adaptör fabrikası - ES6 modules
 * config.type'a göre doğru adaptörü döndürür
 * Tüm yazıcı markaları destekli
 */

import { BambuAdapter } from './bambu.js';
import { UltimakerAdapter } from './ultimaker.js';
import { Raise3DAdapter } from './raise3d.js';
import { GuiderAdapter } from './guider.js';
import { ZaxeAdapter } from './zaxe.js';

/**
 * Konfigürasyona göre doğru adaptörü oluşturur
 * @param {Object} config - Yazıcı konfigürasyonu
 * @returns {PrinterAdapter} - İlgili adaptör instance'ı
 */
export function createAdapter(config) {
  switch (config.type) {
    case 'bambu':
      return new BambuAdapter(config);
    
    case 'ultimaker':
      return new UltimakerAdapter(config);
    
    case 'raise3d':
      return new Raise3DAdapter(config);
    
    case 'guider':
      return new GuiderAdapter(config);
    
    case 'zaxe':
      return new ZaxeAdapter(config);
    
    default:
      throw new Error(
        `Unknown printer type: ${config.type}. ` +
        `Supported types: bambu, ultimaker, raise3d, guider, zaxe`
      );
  }
}

export default createAdapter;
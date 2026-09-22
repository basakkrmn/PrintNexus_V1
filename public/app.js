/**
 * PrintHQ — Frontend
 * SPA navigasyon · Filo ızgarası · Tema-duyarlı grafikler
 * Ultimaker · Bambu · Raise3D · Guider · ZAXE
 */

/* ═══════════════════ AUTH ═══════════════════ */

function checkAuth() {
  const token = localStorage.getItem('token');
  const user = localStorage.getItem('user');
  if (!token || !user) {
    window.location.href = '/login.html';
    return null;
  }
  return JSON.parse(user);
}

const currentUser = checkAuth();

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('user');
  window.location.href = '/login.html';
}

/* ═══════════════════ STATE ═══════════════════ */

let printers = {};
let socket = null;
let chartsInited = false;
const charts = { temperature: null, successRate: null, efficiency: null };

const TAB_META = {
  overview:  { title: 'Genel Bakış',   sub: 'Filonun anlık durumu' },
  fleet:     { title: 'Yazıcı Filosu', sub: 'Tüm cihazlar ve kontroller' },
  analytics: { title: 'Analitik',      sub: 'Grafikler ve raporlar' },
  settings:  { title: 'Ayarlar',       sub: 'Kullanıcı ve yazıcı yönetimi' }
};

/* ═══════════════════ RBAC ═══════════════════ */

const PERMISSIONS = {
  admin: {
    canViewDashboard: true, canViewPrinters: true, canViewFullIP: true,
    canControlPrinter: true, canAddPrinter: true, canDeletePrinter: true,
    canManageUsers: true, canViewSettings: true, canViewReports: true
  },
  operator: {
    canViewDashboard: true, canViewPrinters: true, canViewFullIP: true,
    canControlPrinter: true, canAddPrinter: false, canDeletePrinter: false,
    canManageUsers: false, canViewSettings: true, canViewReports: true
  },
  viewer: {
    canViewDashboard: true, canViewPrinters: true, canViewFullIP: false,
    canControlPrinter: false, canAddPrinter: false, canDeletePrinter: false,
    canManageUsers: false, canViewSettings: false, canViewReports: false
  }
};

const ROLE_LABELS = {
  admin:    { label: 'Yönetici', desc: 'Tam erişim · kullanıcı yönetimi' },
  operator: { label: 'Operatör', desc: 'Yazıcı kontrolü · raporlar' },
  viewer:   { label: 'İzleyici', desc: 'Sadece görüntüleme' }
};

function hasPermission(action) {
  if (!currentUser) return false;
  const perms = PERMISSIONS[currentUser.role];
  return !!(perms && perms[action] === true);
}

function isAdmin() { return currentUser?.role === 'admin'; }

function getRoleLabel(role) { return ROLE_LABELS[role]?.label || role; }
function getRoleDesc(role)  { return ROLE_LABELS[role]?.desc  || ''; }

// IP'yi role göre maskele — sunucu zaten maskeliyor, bu ikinci katman
function maskIP(ip) {
  if (!ip) return '—';
  if (hasPermission('canViewFullIP')) return ip;
  const parts = String(ip).split('.');
  if (parts.length !== 4) return ip;
  return `${parts[0]}.${parts[1]}.**.***`;
}

/**
 * Yetkisi olmayan elemanları gizler.
 * ÖNEMLİ: Yetki VARSA display'e dokunulmaz — böylece kendi
 * mantığıyla gizlenen elemanlar (detay modalı butonları vb.) bozulmaz.
 */
function applyRoleBasedVisibility() {
  if (!currentUser) return;

  const hide = (el) => {
    el.style.display = 'none';
    if ('disabled' in el) el.disabled = true;
    el.dataset.rbacHidden = '1';
  };

  document.querySelectorAll('[data-require-permission]').forEach(el => {
    if (!hasPermission(el.dataset.requirePermission)) hide(el);
  });

  document.querySelectorAll('[data-require-admin]').forEach(el => {
    if (!isAdmin()) hide(el);
  });

  document.querySelectorAll('[data-hide-for-role]').forEach(el => {
    const roles = el.dataset.hideForRole.split(',').map(r => r.trim());
    if (roles.includes(currentUser.role)) hide(el);
  });
}

/* ═══════════════════ API YARDIMCISI ═══════════════════ */

/**
 * Tüm istekler için tek giriş noktası:
 *  - Authorization header otomatik eklenir
 *  - 401 → token refresh dene, başarısızsa login'e yönlendir
 *  - 403 → yetki yok, uyarı göster
 */
// Sayfa açılışında birden fazla istek paralel gider. Token süresi dolmuşsa
// hepsi aynı anda yenileme isteği atmasın diye tek bir promise paylaşılır.
let refreshPromise = null;
let sessionEnded = false;

async function refreshAccessToken() {
  const refreshToken = localStorage.getItem('refreshToken');
  if (!refreshToken) return null;

  const res = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken })
  });

  if (!res.ok) return null;

  const data = await res.json();
  if (!data?.token) return null;

  localStorage.setItem('token', data.token);
  if (data.user) localStorage.setItem('user', JSON.stringify(data.user));
  console.log('✅ Token yenilendi');
  return data.token;
}

// Oturum düştü: tek toast göster, tek kez çıkış yap
function endSession() {
  if (sessionEnded) return;
  sessionEnded = true;
  toast('Oturumunuzun süresi doldu, tekrar giriş yapın.', 'err');
  setTimeout(logout, 1200);
}

async function apiFetch(url, options = {}) {
  const token = localStorage.getItem('token');
  if (!token) { logout(); throw new Error('Oturum yok'); }

  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  let res = await fetch(url, { ...options, headers });

  // 401 = kimlik doğrulanamadı → token yenilemeyi BİR KEZ dene
  if (res.status === 401) {
    if (!refreshPromise) {
      console.log('🔄 Token süresi dolmuş, yenileniyor...');
      refreshPromise = refreshAccessToken()
        .catch(err => { console.error('Token yenileme hatası:', err); return null; })
        .finally(() => { setTimeout(() => { refreshPromise = null; }, 0); });
    }

    const newToken = await refreshPromise;

    if (!newToken) {
      endSession();
      throw new Error('401');
    }

    // İsteği yeni token ile bir kez tekrarla
    res = await fetch(url, {
      ...options,
      headers: { ...headers, Authorization: `Bearer ${newToken}` }
    });

    // Yeni token da reddedildiyse oturum gerçekten bitmiş
    if (res.status === 401) {
      endSession();
      throw new Error('401');
    }
  }

  let data = null;
  try { data = await res.json(); } catch { /* body yok (ör. dosya) */ }

  if (res.status === 403) {
    toast(data?.message || data?.error || 'Bu işlem için yetkiniz yok.', 'err');
    throw new Error('403');
  }

  if (!res.ok) {
    throw new Error(data?.message || data?.error || `Sunucu hatası (${res.status})`);
  }

  return data;
}

/* ═══════════════════ TOAST ═══════════════════ */

function toast(message, type = 'ok') {
  let host = document.getElementById('toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    host.style.cssText =
      'position:fixed;top:18px;right:18px;z-index:4000;display:flex;flex-direction:column;gap:10px;';
    document.body.appendChild(host);
  }

  const colors = {
    ok:   ['var(--ok-tint)',   'var(--ok)'],
    err:  ['var(--err-tint)',  'var(--err)'],
    warn: ['var(--warn-tint)', 'var(--warn)']
  };
  const [bg, fg] = colors[type] || colors.ok;

  const el = document.createElement('div');
  el.style.cssText = `
    background:${bg};color:${fg};
    border:1px solid ${fg};
    padding:12px 16px;border-radius:12px;
    font-size:.84rem;font-weight:700;max-width:340px;
    box-shadow:var(--shadow-md);
    animation:viewIn .25s ease;`;
  el.textContent = message;
  host.appendChild(el);

  setTimeout(() => {
    el.style.transition = 'opacity .3s ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

/* ═══════════════════ INIT ═══════════════════ */

async function init() {
  if (!currentUser) {
    console.error('❌ Kullanıcı bilgisi yok!');
    window.location.href = '/login.html';
    return;
  }

  const nameEl = document.getElementById('userName');
  const roleEl = document.getElementById('userRole');
  const avEl = document.getElementById('userAvatar');
  
  if (nameEl) nameEl.textContent = currentUser.username;
  if (roleEl) {
    roleEl.textContent = getRoleLabel(currentUser.role);
    roleEl.setAttribute('data-role', currentUser.role);
  }
  if (avEl) avEl.textContent = (currentUser.username || '?').charAt(0).toUpperCase();

  // Ayarlar sekmesi kişiselleştirmesi
  if (document.getElementById('accUsername')) {
    document.getElementById('accUsername').textContent = currentUser.username;
    document.getElementById('accRoleDesc').textContent = getRoleDesc(currentUser.role);
    document.getElementById('accAvatar').textContent = currentUser.username.charAt(0).toUpperCase();
    document.getElementById('accRoleTag').textContent = getRoleLabel(currentUser.role);
    document.getElementById('accRoleTag').className = `role-tag ${currentUser.role}`;
  }

  setupTheme();
  applyRoleBasedVisibility();
  loadUserList();  // Backend'den kullanıcıları yükle
  renderPermissionMatrix();
  loadSecureWordStatus();
  if (isAdmin()) loadResetRequests();
  
  await fetchPrinters();
  render();
  connectWebSocket();
  refreshIcons();
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

/* ═══════════════════ NAVIGATION (SPA) ═══════════════════ */

function switchTab(tab) {
  document.querySelectorAll('.nav-item').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.view').forEach(v =>
    v.classList.toggle('active', v.id === `view-${tab}`));

  const meta = TAB_META[tab];
  if (meta) {
    document.getElementById('pageTitle').textContent = meta.title;
    document.getElementById('pageSub').textContent = meta.sub;
  }

  // Grafikleri ilk kez analitik sekmesine geçilince kur (canvas boyutu için)
  if (tab === 'analytics' && !chartsInited) {
    initCharts();
    chartsInited = true;
  }

  // Mobilde menüyü kapat
  document.getElementById('app').classList.remove('nav-open');
  refreshIcons();
}

function toggleNav() {
  document.getElementById('app').classList.toggle('nav-open');
}

function refreshData() {
  fetchPrinters().then(render);
}

// 📊 RAPOR İNDİR
function downloadReport() {
  const token = localStorage.getItem('token');
  
  fetch('/api/analytics/report', {
    headers: { 'Authorization': `Bearer ${token}` }
  })
  .then(res => {
    if (!res.ok) throw new Error('Rapor indirilemedi');
    
    // Excel dosyasını indir
    const filename = `VeriRaporu_${new Date().toLocaleDateString('tr-TR').replace(/\./g, '_')}.xlsx`;
    const url = window.URL.createObjectURL(res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
    
    alert('✅ Rapor başarıyla indirildi!');
  })
  .catch(err => {
    console.error('Rapor indirme hatası:', err);
    alert('❌ Rapor indirilemedi: ' + err.message);
  });
}

/* ═══════════════════ THEME ═══════════════════ */

function setupTheme() {
  setTheme(localStorage.getItem('theme') || 'light');
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);

  const isDark = theme === 'dark';
  const btn = document.querySelector('.icon-btn[onclick*="toggleTheme"]');
  if (btn) {
    btn.innerHTML = `<i data-lucide="${isDark ? 'sun' : 'moon'}"></i><span>${isDark ? 'Açık Mod' : 'Koyu Mod'}</span>`;
  }
  refreshIcons();

  // Grafikler kuruluysa temaya göre yeniden çiz
  if (chartsInited) {
    destroyCharts();
    initCharts();
  }
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  setTheme(cur === 'dark' ? 'light' : 'dark');
}

/* ═══════════════════ API ═══════════════════ */

async function fetchPrinters() {
  try {
    const data = await apiFetch('/api/printers');
    
    // Marka gruplarını düzleştir: {ultimaker: [], bambu: [], ...} → {printer1, printer2, ...}
    printers = {};
    ['ultimaker', 'bambu', 'raise3d', 'guider', 'zaxe'].forEach(brand => {
      (data[brand] || []).forEach(p => { printers[p.id] = p; });
    });

    console.log(`✓ ${Object.keys(printers).length} yazıcı yüklendi`);
    render();
  } catch (err) {
    console.error('❌ Yazıcı yükleme hatası:', err.message);
  }
}

async function addPrinter() {
  const id = document.getElementById('printerId').value.trim();
  const ip = document.getElementById('printerIP').value.trim();
  const type = document.getElementById('printerType').value;

  if (!id || !ip) { toast('Ad ve IP zorunlu.', 'err'); return; }
  if (!hasPermission('canAddPrinter')) {
    toast('Yazıcı ekleme izniniz yok.', 'err'); return;
  }

  const printer = {
    id, ip, type,
    accessCode: document.getElementById('printerCode')?.value || null,
    serial: document.getElementById('printerSerial')?.value || null,
    auth: {
      username: document.getElementById('printerUser')?.value || null,
      password: document.getElementById('printerPass')?.value || null
    }
  };

  try {
    const res = await apiFetch('/api/printers', {
      method: 'POST',
      body: JSON.stringify({ type, printer })
    });
    
    if (res.ok) {
      toast(`${id} başarıyla eklendi.`, 'ok');
      clearForm();
      await fetchPrinters();
      loadManagerList();
      closeManager();
    }
  } catch (err) {
    toast(`Kaydedilemedi: ${err.message}`, 'err');
  }
}

async function deletePrinter(id) {
  if (!hasPermission('canDeletePrinter')) {
    toast('Yazıcı silme izniniz yok.', 'err');
    return;
  }

  if (!confirm(`"${id}" silinsin mi?`)) return;

  try {
    await apiFetch(`/api/printers/${id}`, { method: 'DELETE' });
    toast(`${id} silindi.`, 'ok');
    await fetchPrinters();
    render();
    loadManagerList();
  } catch (err) {
    toast(`Silinemedi: ${err.message}`, 'err');
  }
}

async function sendCommand(id, command) {
  if (!hasPermission('canControlPrinter')) {
    toast('Yazıcı kontrolü izniniz yok.', 'err');
    return;
  }

  try {
    const res = await apiFetch(`/api/command/${id}`, {
      method: 'POST',
      body: JSON.stringify({ command })
    });
    
    console.log(`✅ Komut gönderildi: ${id} → ${command}`);
    await fetchPrinters();
    render();
  } catch (err) {
    toast(`Komut gönderilemedi: ${err.message}`, 'err');
  }
}

function editPrinter(id) {
  const p = printers[id];
  if (!p) return;
  openManager();
  document.getElementById('printerId').value = p.id;
  document.getElementById('printerIP').value = p.ip;
  document.getElementById('printerType').value = p.type;
  if (p.type === 'bambu') {
    document.getElementById('printerCode').value = p.accessCode || '';
    document.getElementById('printerSerial').value = p.serial || '';
  } else if (['ultimaker', 'raise3d', 'zaxe'].includes(p.type)) {
    const u = document.getElementById('printerUser');
    const pw = document.getElementById('printerPass');
    if (u) u.value = p.username || '';
    if (pw) pw.value = p.password || '';
  }
  toggleFormFields();
}

// ✅ Kontrol kısayolları (izin kontrollü apiFetch'i kullanıyor)
function startPrinter(id)   { sendCommand(id, 'start'); }
function pausePrinter(id)   { sendCommand(id, 'pause'); }    // DURAKLAT
function resumePrinter(id)  { sendCommand(id, 'resume'); }   // DEVAM ET
// [DURDUR] butonu gerçekten durdurur (baskıyı iptal eder). Duraklatmak için
// ayrı [DURAKLAT] butonu var.
function stopPrinter(id)    { if (confirm(`"${id}" durdurulsun mu? Bu işlem baskıyı iptal eder.`)) sendCommand(id, 'stop'); }

/* ═══════════════════ FORM ═══════════════════ */

function toggleFormFields() {
  const type = document.getElementById('printerType').value;
  document.querySelectorAll('[data-form-field]').forEach(el => el.classList.add('hidden'));
  const map = {
    bambu: 'bambuFields', ultimaker: 'ultimakerFields',
    raise3d: 'raise3dFields', guider: 'guiderFields', zaxe: 'zaxeFields'
  };
  const el = document.getElementById(map[type]);
  if (el) el.classList.remove('hidden');
  refreshIcons();
}

function clearForm() {
  ['printerId','printerIP','printerCode','printerSerial','printerUser','printerPass']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('printerType').value = 'ultimaker';
  toggleFormFields();
}

/* ═══════════════════ WEBSOCKET ═══════════════════ */

function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${proto}//${location.host}`);

  socket.onopen = () => setConnection(true);
  socket.onclose = () => { setConnection(false); setTimeout(connectWebSocket, 3000); };
  socket.onerror = () => {};
  socket.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (!data.id) return;
      printers[data.id] = { ...printers[data.id], ...data, status: mapStatus(data) };
      render();
      // ✅ Modal açıksa ve bu güncelleme o yazıcıya aitse, modal'ı da yenile
      // (böylece duraklat/devam et butonları canlı olarak güncellenir)
      if (currentDetailPrinter && currentDetailPrinter.id === data.id) {
        currentDetailPrinter = printers[data.id];
        updatePrinterDetail();
      }
    } catch (err) { /* yoksay */ }
  };
}

function setConnection(on) {
  const el = document.getElementById('ws-badge');
  if (!el) return;
  el.className = 'status-pill' + (on ? ' online' : '');
  el.innerHTML = `<span class="dot"></span>${on ? 'Canlı veri akışı' : 'Bağlantı yok'}`;
}

/* ═══════════════════ STATUS MAP ═══════════════════ */

function mapStatus(d) {
  const s = (d.status || '').toLowerCase();
  if (s === 'offline' || d.is_online === false) return 'çevrim dışı';
  if (d.error || s.includes('error') || s.includes('fail')) return 'hata';
  // ✅ DURAKLAT kontrolü: progress kontrolünden ÖNCE olmalı
  // (yazıcı duraklatıldığında progress %0-100 arası kalır, bu yüzden önce paused'u yakala)
  if (s.includes('pause')) return 'duraklat';
  if (s.includes('finish') || s === 'completed' || d.progress >= 100) return 'tamamlandı';
  if (s.includes('print') || s.includes('run') || s.includes('busy') || s.includes('build') ||
      (d.progress > 0 && d.progress < 100)) return 'çalışıyor';
  if (!s) return 'çevrim dışı';
  return 'boşta';
}

function statusClass(status) {
  return ({
    'çalışıyor': 'running', 'hata': 'error', 'tamamlandı': 'finished',
    'çevrim dışı': 'offline', 'boşta': 'idle'
  })[status] || 'offline';
}

const STATUS_COLOR = {
  running: 'var(--ok)', idle: 'var(--idle)', finished: 'var(--warn)',
  error: 'var(--err)', offline: 'var(--off)'
};

/* ═══════════════════ RENDER ═══════════════════ */

function render() {
  const list = Object.values(printers);
  renderKPIs(list);
  renderFleetGrid(list);
  renderFleetCards(list);
  renderSettingsPrinters(list);
  refreshIcons();
}

function renderKPIs(list) {
  let act = 0, fin = 0, err = 0;
  list.forEach(p => {
    const s = p.status || 'çevrim dışı';
    if (s === 'çalışıyor') act++;
    if (s === 'tamamlandı') fin++;
    if (s === 'hata') err++;
  });
  const total = list.length || 0;
  set('activeCount', act);
  set('finishedCount', fin);
  set('errorCount', err);
  set('loadPercent', total ? Math.round((act / total) * 100) + '%' : '0%');
}

function set(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

/* SIGNATURE — filo ızgarası */
function renderFleetGrid(list) {
  const grid = document.getElementById('fleetGrid');
  if (!grid) return;
  if (!list.length) {
    grid.innerHTML = `<p style="color:var(--ink-muted);font-size:.85rem">Henüz yazıcı eklenmedi.</p>`;
    return;
  }
  grid.innerHTML = list.map(p => {
    const status = p.status || 'çevrim dışı';
    const c = STATUS_COLOR[statusClass(status)];
    const nozzle = p.nozzleTemp != null ? Math.round(p.nozzleTemp) : '–';
    const prog = p.progress || 0;
    return `
      <div class="fleet-tile" style="--tile-c:${c}" onclick="switchTab('fleet')" title="${p.id} · ${status}">
        <div class="tile-top">
          <span class="tile-id">${p.id}</span>
          <span class="tile-dot"></span>
        </div>
        <div class="tile-temp mono">${nozzle}<span>°C</span></div>
        <div class="tile-bar"><div class="tile-fill" style="width:${prog}%"></div></div>
      </div>`;
  }).join('');
}

function renderFleetCards(list) {
  const box = document.getElementById('fleetContainer');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = `
      <div class="empty">
        <i data-lucide="printer"></i>
        <h3>Henüz yazıcı yok</h3>
        <p>İlk yazıcını ekleyerek filonu izlemeye başla.</p>
        <button class="btn btn-primary" onclick="openManager()"><i data-lucide="plus"></i> Yazıcı Ekle</button>
      </div>`;
    return;
  }
  box.innerHTML = `<div class="fleet-cards">${list.map(printerCard).join('')}</div>`;
}

function printerCard(p) {
  const status = p.status || 'çevrim dışı';
  const cls = statusClass(status);
  const prog = p.progress || 0;
  const nozzle = p.nozzleTemp != null ? Math.round(p.nozzleTemp) : 0;
  const bed = p.bedTemp != null ? Math.round(p.bedTemp) : 0;
  const eta = status === 'çalışıyor' ? formatTime(p.remainingSeconds) : '';

  let controls = '';
  if (status === 'çalışıyor' || status === 'duraklat') {
    controls = `
      <div class="controls">
        ${status === 'çalışıyor'
          ? `<button class="ctrl" onclick="pausePrinter('${p.id}')"><i data-lucide="pause"></i> Duraklat</button>
             <button class="ctrl stop" onclick="stopPrinter('${p.id}')"><i data-lucide="square"></i> Durdur</button>`
          : `<button class="ctrl" onclick="resumePrinter('${p.id}')"><i data-lucide="play"></i> Devam Et</button>
             <button class="ctrl stop" onclick="stopPrinter('${p.id}')"><i data-lucide="square"></i> Durdur</button>`}
      </div>`;
  }

  return `
    <div class="card" onclick="openPrinterDetail('${p.id}')">
      <div class="card-head">
        <div>
          <div class="card-id">${p.id}</div>
          <div class="card-type">${p.type}</div>
        </div>
        <span class="badge ${cls}"><i></i>${status}</span>
      </div>
      <div class="progress-row">
        <span class="progress-pct mono">${prog}%</span>
        <span class="progress-eta"> Kalan Süre ~ ${eta}</span>
      </div>
      <div class="bar"><div class="fill ${cls}" style="width:${prog}%"></div></div>
      <div class="metrics">
        <div class="metric">
          <i data-lucide="thermometer"></i>
          <div><div class="m-val mono">${nozzle}°</div><div class="m-label">Nozul</div></div>
        </div>
        <div class="metric">
          <i data-lucide="grip"></i>
          <div><div class="m-val mono">${bed}°</div><div class="m-label">Tabla</div></div>
        </div>
      </div>
      ${controls}
    </div>`;
}

/* ═══════════════════ SETTINGS ═══════════════════ */

/* ═══════════════════ SETTINGS ═══════════════════ */

async function loadUserList() {
  try {
    const data = await apiFetch('/api/users');
    if (!data.ok || !data.data) return;

    const box = document.getElementById('userList');
    if (!box) return;

    const users = data.data;
    if (!users.length) {
      box.innerHTML = '<p style="color:var(--ink-muted);font-size:.85rem;padding:8px">Kullanıcı yok.</p>';
      return;
    }

    box.innerHTML = users.map(u => `
      <div class="user-row">
        <div class="avatar" style="width:36px;height:36px;border-radius:50%;background:var(--brand-tint);color:var(--brand);display:grid;place-items:center;font-weight:700">${u.username.charAt(0).toUpperCase()}</div>
        <div class="u-meta">
          <b>${u.username}</b>
          <span style="font-size:.75rem;color:var(--ink-muted)">${new Date(u.created_at * 1000).toLocaleDateString('tr-TR')}</span>
        </div>
        <span class="role-tag ${u.role}">${getRoleLabel(u.role)}</span>
        ${isAdmin() && String(u.id) !== String(currentUser.id) ? `
          <div class="row-actions">
            <button onclick="deleteUserConfirm(${u.id}, '${u.username}')" title="Sil" style="width:32px;height:32px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--ink-muted);cursor:pointer;display:grid;place-items:center;transition:all .15s ease">
              <i data-lucide="trash-2" style="width:15px;height:15px"></i>
            </button>
          </div>
        ` : ''}
      </div>
    `).join('');
    
    refreshIcons();
  } catch (err) {
    console.error('Kullanıcı listesi yükleme hatası:', err.message);
  }
}

function renderUserList() {
  loadUserList();
}

function renderSettingsPrinters(list) {
  const box = document.getElementById('settingsPrinterList');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = `<p style="color:var(--ink-muted);font-size:.85rem;padding:8px">Kayıtlı yazıcı yok.</p>`;
    return;
  }
  box.innerHTML = list.map(p => `
    <div class="printer-row">
      <div>
        <b>${p.id}</b><br>
        <small>${p.type} · ${maskIP(p.ip)}</small>
      </div>
      <div class="row-actions">
        ${hasPermission('canDeletePrinter') ? `<button onclick="deletePrinter('${p.id}')" title="Sil" style="width:32px;height:32px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--ink-muted);cursor:pointer;display:grid;place-items:center;transition:all .15s ease"><i data-lucide="trash-2" style="width:15px;height:15px"></i></button>` : ''}
      </div>
    </div>
  `).join('');
}

function renderPermissionMatrix() {
  const box = document.getElementById('permMatrix');
  if (!box) return;

  const actions = [
    ['Dashboard', 'canViewDashboard'],
    ['Yazıcıları Görüntüle', 'canViewPrinters'],
    ['Yazıcı Kontrolü', 'canControlPrinter'],
    ['Yazıcı Ekle', 'canAddPrinter'],
    ['Yazıcı Sil', 'canDeletePrinter'],
    ['Kullanıcı Yönetimi', 'canManageUsers'],
    ['Ayarlar', 'canViewSettings'],
    ['Raporlar', 'canViewReports']
  ];

  const roles = ['admin', 'operator', 'viewer'];
  const header = `
    <div style="display:grid;grid-template-columns:140px repeat(3, 1fr);gap:12px;align-items:center;margin-bottom:12px;font-weight:700;font-size:.8rem;color:var(--ink-muted)">
      <div>İşlem</div>
      ${roles.map(r => `<div style="text-align:center">${getRoleLabel(r)}</div>`).join('')}
    </div>`;

  const rows = actions.map(([label, key]) => `
    <div style="display:grid;grid-template-columns:140px repeat(3, 1fr);gap:12px;align-items:center;padding:8px 0;border-top:1px solid var(--line);font-size:.82rem">
      <div>${label}</div>
      ${roles.map(r => {
        const has = PERMISSIONS[r][key];
        return `<div style="text-align:center;color:${has ? 'var(--ok)' : 'var(--err)'}">
          <i data-lucide="${has ? 'check' : 'x'}" style="width:16px;height:16px"></i>
        </div>`;
      }).join('')}
    </div>
  `).join('');

  box.innerHTML = header + rows;
  refreshIcons();
}

/* ═══════════════════ MODAL ═══════════════════ */

function openManager() {
  document.getElementById('managerModal').classList.add('active');
  loadManagerList();
  toggleFormFields();
  refreshIcons();
}
function closeManager() {
  document.getElementById('managerModal').classList.remove('active');
  clearForm();
}
async function loadManagerList() {
  const box = document.getElementById('printerList');
  if (!box) return;
  const list = Object.values(printers);
  if (!list.length) {
    box.innerHTML = `<p style="color:var(--ink-muted);font-size:.85rem;padding:8px">Kayıtlı yazıcı yok.</p>`;
    return;
  }
  box.innerHTML = list.map(p => printerRow(p)).join('');
  refreshIcons();
}

/* ═══════════════════ UTIL ═══════════════════ */

function formatTime(sec) {
  if (!sec || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}s ${m}dk` : `${m}dk`;
}

/* ═══════════════════ CHARTS ═══════════════════ */

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function chartTheme() {
  return {
    text: cssVar('--ink-muted') || '#64748b',
    grid: cssVar('--line') || '#e2e8f0',
    brand: cssVar('--brand') || '#2563eb',
    ok: cssVar('--ok') || '#16a34a',
    warn: cssVar('--warn') || '#d97706',
    err: cssVar('--err') || '#dc2626',
    surface: cssVar('--surface') || '#ffffff'
  };
}

function destroyCharts() {
  Object.keys(charts).forEach(k => { if (charts[k]) { charts[k].destroy(); charts[k] = null; } });
}

async function loadAnalyticsData() {
  try {
    const token = localStorage.getItem('token');
    
    // 1. Sıcaklık verileri
    const tempRes = await fetch('/api/analytics/telemetry', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const tempData = await tempRes.json();
    
    // 2. Yazıcı verimliliği
    const statsRes = await fetch('/api/analytics/printer-stats', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const statsData = await statsRes.json();
    
    // 3. Baskı sonuçları
    const resultsRes = await fetch('/api/analytics/print-results', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const resultsData = await resultsRes.json();
    
    return {
      temperature: tempData.ok ? tempData.data : [],
      stats: statsData.ok ? statsData.data : [],
      results: resultsData.ok ? resultsData.data : { successful: 72, failed: 15, ongoing: 13 }
    };
  } catch (err) {
    console.error('Analytics veri yükleme hatası:', err);
    return null;
  }
}

function initCharts() {
  if (typeof Chart === 'undefined') return;
  const t = chartTheme();
  Chart.defaults.font.family = "'Plus Jakarta Sans', sans-serif";
  Chart.defaults.color = t.text;

  // Sıcaklık (çizgi + yumuşak dolgu)
  const c1 = document.getElementById('temperatureChart');
  if (c1) {
    const ctx = c1.getContext('2d');
    const gNoz = ctx.createLinearGradient(0, 0, 0, 260);
    gNoz.addColorStop(0, hexA(t.err, 0.25)); gNoz.addColorStop(1, hexA(t.err, 0));
    const gBed = ctx.createLinearGradient(0, 0, 0, 260);
    gBed.addColorStop(0, hexA(t.brand, 0.22)); gBed.addColorStop(1, hexA(t.brand, 0));
    
    charts.temperature = new Chart(ctx, {
      type: 'line',
      data: {
        labels: ['10:00','11:00','12:00','13:00','14:00','15:00','16:00'],
        datasets: [
          { label: 'Nozul °C', data: [210,212,211,210,213,212,211], borderColor: t.err,
            backgroundColor: gNoz, borderWidth: 2.5, fill: true, tension: 0.4,
            pointRadius: 0, pointHoverRadius: 5, pointBackgroundColor: t.err },
          { label: 'Tabla °C', data: [60,61,60,62,61,60,62], borderColor: t.brand,
            backgroundColor: gBed, borderWidth: 2.5, fill: true, tension: 0.4,
            pointRadius: 0, pointHoverRadius: 5, pointBackgroundColor: t.brand }
        ]
      },
      options: baseOpts(t, {
        scales: {
          y: { ticks: { color: t.text }, grid: { color: t.grid, drawBorder: false } },
          x: { ticks: { color: t.text }, grid: { display: false, drawBorder: false } }
        }
      })
    });
  }

  // Baskı sonuçları (doughnut, kenarlıksız)
  const c2 = document.getElementById('successRateChart');
  if (c2) {
    charts.successRate = new Chart(c2.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: ['Başarılı','Hata','Devam eden'],
        datasets: [{ data: [72,15,13], backgroundColor: [t.ok, t.err, t.brand],
          borderWidth: 0, hoverOffset: 6 }]
      },
      options: baseOpts(t, { cutout: '68%' })
    });
  }

  // Verimlilik (yatay bar, yuvarlak uç)
  const c3 = document.getElementById('efficiencyChart');
  if (c3) {
    charts.efficiency = new Chart(c3.getContext('2d'), {
      type: 'bar',
      data: {
        labels: ['Ultimaker 1','Bambu 8','Raise3D 2','Guider 13','ZAXE 14'],
        datasets: [{ label: 'Verim %', data: [94,87,91,78,85],
          backgroundColor: t.brand, borderRadius: 8, borderSkipped: false,
          barThickness: 16 }]
      },
      options: baseOpts(t, {
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: t.text }, grid: { color: t.grid, drawBorder: false }, max: 100 },
          y: { ticks: { color: t.text }, grid: { display: false, drawBorder: false } }
        }
      })
    });
  }
  
  // Verileri yükle ve grafikleri güncelle
  loadAnalyticsData().then(data => {
    if (data) {
      updateChartsWithData(data, t);
    }
  });
}

function updateChartsWithData(data, t) {
  // Baskı sonuçlarını güncelle
  if (charts.successRate && data.results) {
    charts.successRate.data.datasets[0].data = [
      data.results.successful,
      data.results.failed,
      data.results.ongoing
    ];
    charts.successRate.update();
  }
  
  // Verimlilik grafiğini güncelle
  if (charts.efficiency && data.stats && data.stats.length > 0) {
    const labels = data.stats.map(s => s.name).slice(0, 5);
    const efficiencyValues = data.stats.map(s => s.efficiency).slice(0, 5);
    
    charts.efficiency.data.labels = labels;
    charts.efficiency.data.datasets[0].data = efficiencyValues;
    charts.efficiency.update();
  }
}

function baseOpts(t, extra) {
  return Object.assign({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: { color: t.text, usePointStyle: true, pointStyle: 'circle',
          padding: 16, font: { weight: '600', size: 12 } }
      },
      tooltip: {
        backgroundColor: t.surface, titleColor: cssVar('--ink'), bodyColor: t.text,
        borderColor: t.grid, borderWidth: 1, padding: 10, cornerRadius: 8, usePointStyle: true
      }
    }
  }, extra || {});
}

// hex + alpha helper (destekli değilse rgba fallback)
function hexA(hex, a) {
  hex = (hex || '').trim();
  if (hex.startsWith('#')) {
    const n = hex.slice(1);
    const full = n.length === 3 ? n.split('').map(c => c + c).join('') : n;
    const r = parseInt(full.substring(0,2),16),
          g = parseInt(full.substring(2,4),16),
          b = parseInt(full.substring(4,6),16);
    return `rgba(${r},${g},${b},${a})`;
  }
  return hex; // zaten rgb/rgba ise
}

/* ═══════════════════ GO ═══════════════════ */

document.addEventListener('DOMContentLoaded', init);

/* ═══════════════════ PRINTER DETAIL MODAL ═══════════════════ */

let currentDetailPrinter = null;

function openPrinterDetail(printerId) {
  const p = printers[printerId];
  if (!p) return;
  currentDetailPrinter = p;
  updatePrinterDetail();
  document.getElementById('printerDetailModal').classList.add('active');
}

function closePrinterDetail() {
  document.getElementById('printerDetailModal').classList.remove('active');
  currentDetailPrinter = null;

  // 🔌 Zaxe stream'ini durdur — yazıcı aynı anda TEK TCP bağlantısı kabul ediyor,
  // modal kapanınca sunucudaki FFmpeg process'i de kapansın diye src temizleniyor.
  // Zaxe artık HLS kullanıyor; video/_hls temizliği updatePrinterDetail'de yapılıyor
}

function updatePrinterDetail() {
  if (!currentDetailPrinter) return;
  const p = currentDetailPrinter;
  const status = p.status || 'çevrim dışı';

  // 🧹 TÜMS STREAM'LERİ TEMİZLE (Eski görüntü kalmasın)
  const video = document.getElementById('detailCameraStream');
  const imgMJPEG = document.getElementById('detailCameraStreamMJPEG');
  const placeholder = document.getElementById('detailCameraPlaceholder');
  const largeModel = document.getElementById('detailLargeModel');
  
  // ⚠️ HLS'i her güncellemede YIKMA. updatePrinterDetail her telemetri
  // mesajında çalışıyor; oynatıcıyı saniyede bir yıkıp kurmak buffer
  // doldurmasına fırsat vermiyor ve görüntü hiç açılmıyor.
  // Sadece HLS kullanmayan bir yazıcıya geçildiyse kapatıyoruz.
  const usesHls = (p.type === 'bambu' || p.type === 'zaxe');
  const usesMjpeg = (p.type === 'ultimaker' || p.type === 'guider');

  if (video && !usesHls) {
    video.src = '';
    video.style.display = 'none';
    if (window._hls) window._hls.destroy();
    window._hls = null;
    window._hlsSource = null;
  }
  
  // ⚠️ MJPEG stream'ini her telemetri güncellemesinde SIFIRLAMIYORUZ.
  // imgMJPEG.src = '' stream bağlantısını koparıp yeniden başlatır;
  // her saniye kamera kesilip "yükleniyor" göründüğü için görüntü hiç oturmaz.
  // HLS'deki _hlsSource guard'ı ile aynı mantık: MJPEG kullanan yazıcıdaysak
  // zaten stream sürüyor, dokunma. Başka bir tipe geçildiyse sıfırla.
  if (imgMJPEG && !usesMjpeg) {
    imgMJPEG.onerror = null;
    imgMJPEG.onload = null;
    imgMJPEG.src = '';
    imgMJPEG.style.display = 'none';
  }

  // Zaxe stream'i: SADECE başka bir yazıcıya geçildiyse durdur.
  // (Aynı yazıcıdaysak dokunma — her telemetri güncellemesinde stream'i
  //  yeniden başlatmak FFmpeg'i sürekli öldürür, görüntü hiç oturmaz.)
  
  // ✅ PLACEHOLDER'I DEFAULT STATE'E GETIR
  if (placeholder) {
    placeholder.innerHTML = `
      <div style="text-align:center;color:var(--ink-muted)">
        <i data-lucide="camera-off" style="width:48px;height:48px;margin-bottom:8px"></i>
        <p>Kamera kullanılamıyor</p>
      </div>
    `;
    placeholder.style.display = 'flex';
    lucide.createIcons();
  }

  // Header
  document.getElementById('detailPrinterId').textContent = p.id;
  document.getElementById('detailPrinterType').textContent = (p.type || 'Bilinmiyor').toUpperCase();
  
  // Model thumbnail
  document.getElementById('detailModelThumbnail').innerHTML = getModelThumbnail(p.type, 48);
  
  if (video && placeholder && largeModel) {
    if (status === 'çevrim dışı') {
      // ⚠️ YAZICI ÇEVRİMDIŞI — kamerayı kapat.
      // Sebep: HLS segmentleri (.ts) diskte kalıyor. Yazıcı kapansa bile
      // hls.js bu bayat segmentleri oynatmaya devam ediyordu; ekranda
      // "çevrim dışı" yazarken saatler/günler önceki görüntü görünüyordu.
      if (window._hls) {
        window._hls.stopLoad();
        window._hls.destroy();
        window._hls = null;
      }
      window._hlsSource = null;

      video.pause();
      video.removeAttribute('src');
      video.load();               // tarayıcı buffer'ını da boşalt
      video.style.display = 'none';

      if (imgMJPEG) {
        imgMJPEG.onerror = null;
        imgMJPEG.onload = null;
        imgMJPEG.removeAttribute('src');
        imgMJPEG.style.display = 'none';
      }

      placeholder.innerHTML = `
        <div style="text-align:center;color:var(--ink-muted)">
          <i data-lucide="wifi-off" style="width:48px;height:48px;margin-bottom:8px"></i>
          <p>Yazıcı çevrimdışı</p>
        </div>
      `;
      placeholder.style.display = 'flex';
      lucide.createIcons();

    } else if (p.type === 'bambu') {
      // BAMBU: HLS streaming
      
      // ✅ ÖNCEKİ STREAM HANDLER'LARINI İPTAL ET (Ultimaker'dan kalma error)
      if (imgMJPEG) {
        imgMJPEG.onerror = null;
        imgMJPEG.onload = null;
      }
      
      const match = p.id.match(/(\d+)/);
      const streamName = match ? `bambu${match[1]}` : 'unknown';
      const hlsUrl = `http://localhost:3000/streams/${streamName}.m3u8`;
      
      // ✅ Placeholder'ı TAMAMEN gizle ve temizle
      placeholder.style.display = 'none';
      placeholder.innerHTML = '';
      
      if (window._hlsSource === hlsUrl && window._hls) {
        // Zaten bu kaynağa bağlı — dokunma, sadece görünür yap
        video.style.display = 'block';
      } else if (window.Hls && Hls.isSupported()) {
        if (window._hls) window._hls.destroy();
        window._hlsSource = hlsUrl;

        // ⚠️ ESKİ KARE KALMASIN: <video> elementi tüm Bambu'lar arasında
        // PAYLAŞIMLI. Farklı bir yazıcıya geçince kod doğru stream'e bağlanıyor
        // olsa da, tarayıcı yeni karenin ilk verisi gelene kadar ÖNCEKİ
        // yazıcının son görüntüsünü ekranda tutmaya devam ediyordu — bu da
        // "yanlış/eski işlem gösteriyor" şikayetinin sebebiydi. Şimdi yeni
        // kaynağa geçerken video'yu hemen gizleyip "hazırlanıyor" gösteriyoruz;
        // video SADECE yeni karenin gerçekten oynamaya başladığı an (native
        // 'playing' event) tekrar görünür oluyor — böylece hiçbir zaman başka
        // bir yazıcının donmuş karesi ekranda kalmıyor.
        if (window._hlsPlayingHandler) {
          video.removeEventListener('playing', window._hlsPlayingHandler);
          window._hlsPlayingHandler = null;
        }
        video.style.display = 'none';
        video.removeAttribute('src');
        video.load();
        placeholder.innerHTML = `
          <div style="text-align:center;color:var(--ink-muted)">
            <div style="width:48px;height:48px;margin:0 auto 8px;border:3px solid var(--ink-muted);border-top-color:var(--brand);border-radius:50%;animation:spin 1s linear infinite"></div>
            <p>Kamera hazırlanıyor...</p>
          </div>
        `;
        placeholder.style.display = 'flex';

        const onFirstFrame = () => {
          placeholder.style.display = 'none';
          placeholder.innerHTML = '';
          video.style.display = 'block';
          video.removeEventListener('playing', onFirstFrame);
          window._hlsPlayingHandler = null;
        };
        window._hlsPlayingHandler = onFirstFrame;
        video.addEventListener('playing', onFirstFrame);
        
        // ✅ HLS CLIENT OPTIMIZATION
        // DENGELİ ayarlar. Eskiden striveForLowLatencyMode + llHlsMode vardı;
        // oynatıcıyı canlı ucun dibinde tutuyordu, FFmpeg gerçek LL-HLS
        // üretmediği için buffer boşalıp görüntü sürekli donuyordu.
        window._hls = new Hls({
          debug: false,
          enableWorker: true,
          lowLatencyMode: false,
          maxBufferLength: 10,
          backBufferLength: 10,
          liveSyncDurationCount: 3,          // canlı uçtan 3 segment geride (stabil)
          liveMaxLatencyDurationCount: 10,
          fragLoadingMaxRetry: 6,            // segment 404 → pes etme, tekrar dene
          manifestLoadingMaxRetry: 999,      // manifest yoksa beklemeye devam et
          manifestLoadingRetryDelay: 1000
        });

        // Server yeni açıldığında FFmpeg manifest'i henüz üretmemiş olabilir.
        // Fatal ağ hatasında hls.js'i durdurmuyoruz — startLoad ile yeniden
        // deniyor, manifest gelince görüntü otomatik başlıyor. "Hazırlanıyor"
        // göstergesi kullanıcıya bilgi veriyor.
        window._hls.on(Hls.Events.ERROR, (evt, data) => {
          if (!data.fatal) return;
          console.warn(`⚠️ Bambu HLS (${streamName}): ${data.details}`);
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            placeholder.innerHTML = `
              <div style="text-align:center;color:var(--ink-muted)">
                <div style="width:48px;height:48px;margin:0 auto 8px;border:3px solid var(--ink-muted);border-top-color:var(--brand);border-radius:50%;animation:spin 1s linear infinite"></div>
                <p>Kamera hazırlanıyor...</p>
              </div>
            `;
            placeholder.style.display = 'flex';
            video.style.display = 'none';
            try { window._hls.startLoad(); } catch (e) {}   // manifest gelince yakalar
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            try { window._hls.recoverMediaError(); } catch (e) {}
          } else {
            try { window._hls.destroy(); } catch (e) {}
            window._hls = null;
            window._hlsSource = null;   // sonraki güncellemede sıfırdan denensin
          }
        });

        window._hls.loadSource(hlsUrl);
        window._hls.attachMedia(video);
        // NOT: video.style.display burada 'block' YAPILMIYOR — video sadece
        // yukarıdaki onFirstFrame() ('playing' event) tetiklenince görünür
        // olacak, böylece eski/donmuş kare asla ekrana çıkmıyor.
        console.log(`🎬 HLS yükleniyor: ${streamName}`);
      } else {
        video.src = hlsUrl;
        video.style.display = 'block';
        console.warn(`⚠️ HLS.js yüklenmedi, native video oynatılıyor`);
      }
    } else if (p.type === 'ultimaker') {
      // ULTIMAKER: MJPEG streaming (IMG tag)
      // ⚠️ onload/onerror KULLANILMIYOR:
      //    multipart/x-mixed-replace stream'inde tarayıcı her boundary'de
      //    onerror fırlatabilir → placeholder geliyor gidiyor.
      //    onload her kare için tetiklenir → src her seferinde yeniden set edilir.
      // ⚠️ Aynı yazıcıdaysak src'ye dokunmuyoruz — stream zaten akıyor.
      const mjpegUrl = `http://localhost:3000/stream/ultimaker/${encodeURIComponent(p.id)}`;

      if (imgMJPEG) {
        imgMJPEG.onerror = null;
        imgMJPEG.onload = null;
        // Aynı stream zaten çalışıyorsa yeniden başlatma
        if (!imgMJPEG.src || !imgMJPEG.src.includes(`/stream/ultimaker/${encodeURIComponent(p.id)}`)) {
          imgMJPEG.src = mjpegUrl;
        }
        imgMJPEG.style.display = 'block';
      }

      placeholder.style.display = 'none';
      placeholder.innerHTML = '';
      video.style.display = 'none';
      console.log(`🎬 Ultimaker MJPEG: ${p.id}`);
    } else if (p.type === 'guider') {
      // GUIDER: MJPEG streaming (IMG tag) — Ultimaker ile aynı mimari
      // Sunucu /stream/guider/:id → port 8080/?action=stream proxy
      // ⚠️ onload/onerror yok — boundary'de false-positive tetikleniyor
      // ⚠️ Aynı yazıcıdaysak src'ye dokunmuyoruz — stream zaten akıyor
      const mjpegUrl = `http://localhost:3000/stream/guider/${encodeURIComponent(p.id)}`;

      if (imgMJPEG) {
        imgMJPEG.onerror = null;
        imgMJPEG.onload = null;
        // Aynı stream zaten çalışıyorsa yeniden başlatma
        if (!imgMJPEG.src || !imgMJPEG.src.includes(`/stream/guider/${encodeURIComponent(p.id)}`)) {
          imgMJPEG.src = mjpegUrl;
        }
        imgMJPEG.style.display = 'block';
      }

      placeholder.style.display = 'none';
      placeholder.innerHTML = '';
      video.style.display = 'none';
      console.log(`🎬 Guider MJPEG: ${p.id}`);
    } else if (p.type === 'zaxe') {
      // ZAXE: HLS streaming (Bambu ile aynı mimari)
      // Sunucu, yazıcının port 5002'deki H.264 yayınını sürekli HLS'e çeviriyor.
      // Tarayıcı sadece hazır segment dosyalarını indiriyor — uzun ömürlü
      // bağlantı yok, dolayısıyla kopma/yeniden başlatma sorunu da yok.

      if (imgMJPEG) {
        imgMJPEG.onerror = null;
        imgMJPEG.onload = null;
      }

      // Sunucudaki zaxeStreamName() ile birebir aynı kural
      const streamName = 'zaxe_' + p.id.replace(/[^a-zA-Z0-9]/g, '_');
      const hlsUrl = `http://localhost:3000/streams/${streamName}.m3u8`;

      placeholder.style.display = 'none';
      placeholder.innerHTML = '';

      if (window._hlsSource === hlsUrl && window._hls) {
        // Zaten bu kaynağa bağlı — dokunma, sadece görünür yap
        video.style.display = 'block';
        placeholder.style.display = 'none';
      } else if (window.Hls && Hls.isSupported()) {
        if (window._hls) window._hls.destroy();
        window._hlsSource = hlsUrl;

        window._hls = new Hls({
          debug: false,
          enableWorker: true,
          lowLatencyMode: false,
          maxBufferLength: 10,
          backBufferLength: 10,
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 10,
          fragLoadingMaxRetry: 6,
          manifestLoadingMaxRetry: 999,
          manifestLoadingRetryDelay: 1000
        });

        // Server yeni açıldığında manifest henüz olmayabilir. Bambu ile aynı
        // sağlam mantık: ağ hatasında startLoad ile bekle, media hatasında
        // kurtar, diğerlerinde sıfırla.
        window._hls.on(Hls.Events.ERROR, (evt, data) => {
          if (!data.fatal) return;
          console.warn(`⚠️ Zaxe HLS (${streamName}): ${data.details}`);
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            placeholder.innerHTML = `
              <div style="text-align:center;color:var(--ink-muted)">
                <div style="width:48px;height:48px;margin:0 auto 8px;border:3px solid var(--ink-muted);border-top-color:var(--brand);border-radius:50%;animation:spin 1s linear infinite"></div>
                <p>Zaxe kamerası hazırlanıyor...</p>
              </div>
            `;
            placeholder.style.display = 'flex';
            video.style.display = 'none';
            try { window._hls.startLoad(); } catch (e) {}
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            try { window._hls.recoverMediaError(); } catch (e) {}
          } else {
            try { window._hls.destroy(); } catch (e) {}
            window._hls = null;
            window._hlsSource = null;
          }
        });

        window._hls.loadSource(hlsUrl);
        window._hls.attachMedia(video);
        video.style.display = 'block';
        console.log(`🎬 Zaxe HLS yükleniyor: ${streamName}`);
      } else {
        video.src = hlsUrl;
        video.style.display = 'block';
        console.warn(`⚠️ HLS.js yüklenmedi, native video oynatılıyor`);
      }
    } else {
      video.style.display = 'none';
      // ⚠️ largeModel.innerHTML KULLANMA — video/img/placeholder elementlerini siler
      // ve kamera bir daha hiç açılmaz. Thumbnail'i placeholder içine koyuyoruz.
      placeholder.innerHTML = getModelThumbnail(p.type, 200);
      placeholder.style.display = 'flex';
    }
  }

  // Progress
  const prog = p.progress || 0;
  document.getElementById('detailProgressPercent').textContent = `${prog}%`;
  document.getElementById('detailProgressFill').style.width = `${prog}%`;

  const progLabel = status === 'çalışıyor' ? 'Baskı devam ediyor' : 
                    status === 'duraklat' ? 'Duraklat' :
                    status === 'tamamlandı' ? 'Baskı tamamlandı' :
                    status === 'hata' ? 'Hata oluştu' :
                    'Boşta';
  document.getElementById('detailProgressLabel').textContent = progLabel;

  // Layer info
  const layer = p.currentLayer || 0;
  const totalLayer = p.totalLayers || 0;
  document.getElementById('detailLayerInfo').textContent = 
    totalLayer > 0 ? `Layer ${layer}/${totalLayer}` : '-';

  // Kalan süre
  const remaining = p.remainingSeconds || 0;
  document.getElementById('detailTimeRemaining').textContent = 
    remaining > 0 ? `Kalan Süre ~${formatTime(remaining)}` : '-';

  // Telemetry
  document.getElementById('detailStatus').textContent = status;
  document.getElementById('detailNozzle').textContent = 
    (p.nozzleTemp != null ? Math.round(p.nozzleTemp) : '-') + '°C';
  document.getElementById('detailBed').textContent = 
    (p.bedTemp != null ? Math.round(p.bedTemp) : '-') + '°C';
  document.getElementById('detailChamber').textContent = 
    (p.chamber != null ? Math.round(p.chamber) : '-') + '°C';
  document.getElementById('detailError').textContent = p.error || 'Yok';

  // Controls ✅ 3 BUTON SİSTEMİ: Duraklat, Devam Et, Durdur
  const btnPause = document.getElementById('detailBtnPause');    // DURAKLAT ✅
  const btnResume = document.getElementById('detailBtnResume');  // DEVAM ET ✅
  const btnStop = document.getElementById('detailBtnStop');      // DURDUR ✅

  // ✅ Durum-bazlı buton gösterilmesi
  if (status === 'çalışıyor') {
    // Yazıcı çalışıyor → [DURAKLAT] [DURDUR] göster
    if (btnPause) btnPause.style.display = 'block';    // ✅ DURAKLAT
    if (btnResume) btnResume.style.display = 'none';   // ✗ Gizle
    if (btnStop) btnStop.style.display = 'block';      // ✅ DURDUR
  } else if (status === 'duraklat') {
    // Yazıcı duraklatılı → [DEVAM ET] [DURDUR] göster
    if (btnPause) btnPause.style.display = 'none';     // ✗ Gizle
    if (btnResume) btnResume.style.display = 'block';  // ✅ DEVAM ET
    if (btnStop) btnStop.style.display = 'block';      // ✅ DURDUR
  } else {
    // Boşta, çevrim dışı, hata → Hiçbir şey gösterme
    if (btnPause) btnPause.style.display = 'none';
    if (btnResume) btnResume.style.display = 'none';
    if (btnStop) btnStop.style.display = 'none';
  }
}

/* ═══════════════════ MODEL THUMBNAILS (SVG) ═══════════════════ */

function getModelThumbnail(printerType, size) {
  const type = (printerType || '').toLowerCase();
  const s = size;

  const models = {
    ultimaker: `<svg width="${s}" height="${s}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="um-g"><stop offset="0%" style="stop-color:#ff6b35;stop-opacity:1"/><stop offset="100%" style="stop-color:#ff8c5a;stop-opacity:1"/></linearGradient></defs>
      <rect width="100" height="100" fill="var(--bg-alt)" rx="4"/>
      <g opacity="0.8">
        <rect x="25" y="20" width="50" height="50" fill="url(#um-g)" stroke="#ff6b35" stroke-width="1.5" rx="2"/>
        <rect x="30" y="25" width="40" height="40" fill="none" stroke="#fff" stroke-width="1" opacity="0.5"/>
        <circle cx="50" cy="60" r="4" fill="#fff" opacity="0.6"/>
      </g>
      <text x="50" y="82" text-anchor="middle" font-size="10" fill="var(--ink-muted)" font-family="monospace">UM</text>
    </svg>`,

    bambu: `<svg width="${s}" height="${s}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="bambu-g"><stop offset="0%" style="stop-color:#00d084;stop-opacity:1"/><stop offset="100%" style="stop-color:#00a366;stop-opacity:1"/></linearGradient></defs>
      <rect width="100" height="100" fill="var(--bg-alt)" rx="4"/>
      <g opacity="0.85">
        <path d="M 30 25 L 70 25 L 75 55 Q 75 70 50 70 Q 25 70 25 55 Z" fill="url(#bambu-g)" stroke="#00a366" stroke-width="1.5"/>
        <circle cx="50" cy="45" r="6" fill="#fff" opacity="0.4"/>
        <line x1="50" y1="65" x2="50" y2="75" stroke="#00a366" stroke-width="1.5"/>
      </g>
      <text x="50" y="88" text-anchor="middle" font-size="9" fill="var(--ink-muted)" font-family="monospace">Bambu</text>
    </svg>`,

    raise3d: `<svg width="${s}" height="${s}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="r3d-g"><stop offset="0%" style="stop-color:#0066ff;stop-opacity:1"/><stop offset="100%" style="stop-color:#0052cc;stop-opacity:1"/></linearGradient></defs>
      <rect width="100" height="100" fill="var(--bg-alt)" rx="4"/>
      <g opacity="0.8">
        <rect x="22" y="22" width="56" height="56" fill="url(#r3d-g)" stroke="#0052cc" stroke-width="1.5" rx="3"/>
        <polygon points="50,30 65,50 50,70 35,50" fill="#fff" opacity="0.3"/>
      </g>
      <text x="50" y="85" text-anchor="middle" font-size="9" fill="var(--ink-muted)" font-family="monospace">R3D</text>
    </svg>`,

    guider: `<svg width="${s}" height="${s}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="guider-g"><stop offset="0%" style="stop-color:#ff9500;stop-opacity:1"/><stop offset="100%" style="stop-color:#ff7b00;stop-opacity:1"/></linearGradient></defs>
      <rect width="100" height="100" fill="var(--bg-alt)" rx="4"/>
      <g opacity="0.85">
        <rect x="28" y="20" width="44" height="55" fill="url(#guider-g)" stroke="#ff7b00" stroke-width="1.5" rx="2"/>
        <rect x="32" y="24" width="36" height="45" fill="none" stroke="#fff" stroke-width="1" opacity="0.4"/>
        <circle cx="50" cy="65" r="3" fill="#ff7b00"/>
      </g>
      <text x="50" y="85" text-anchor="middle" font-size="9" fill="var(--ink-muted)" font-family="monospace">2S</text>
    </svg>`,

    zaxe: `<svg width="${s}" height="${s}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="zaxe-g"><stop offset="0%" style="stop-color:#e63946;stop-opacity:1"/><stop offset="100%" style="stop-color:#d62828;stop-opacity:1"/></linearGradient></defs>
      <rect width="100" height="100" fill="var(--bg-alt)" rx="4"/>
      <g opacity="0.8">
        <path d="M 25 35 L 75 35 L 72 70 L 28 70 Z" fill="url(#zaxe-g)" stroke="#d62828" stroke-width="1.5"/>
        <rect x="35" y="40" width="30" height="25" fill="none" stroke="#fff" stroke-width="1" opacity="0.3"/>
      </g>
      <text x="50" y="85" text-anchor="middle" font-size="9" fill="var(--ink-muted)" font-family="monospace">X4</text>
    </svg>`
  };

  return models[type] || `<svg width="${s}" height="${s}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <rect width="100" height="100" fill="var(--bg-alt)" rx="4"/>
    <g opacity="0.5"><circle cx="50" cy="50" r="20" fill="none" stroke="var(--ink-muted)" stroke-width="2"/></g>
  </svg>`;
}

/* ═══════════════════ KONTROL FONKSIYONLARI ═══════════════════ */

// ✅ Başlat fonksiyonu (resume + pause mantığını kombine eder)
async function startPrinterDetail() {
  if (currentDetailPrinter) {
    console.log(`▶️  Başlatılıyor: ${currentDetailPrinter.id}`);
    await startPrinter(currentDetailPrinter.id);
    updatePrinterDetail();
  }
}

// ✅ DURAKLAT fonksiyonu - pause komutu gönder
async function pausePrinterDetail() {
  if (currentDetailPrinter) {
    console.log(`⏸️  Duraklatılıyor: ${currentDetailPrinter.id}`);
    await pausePrinter(currentDetailPrinter.id);
    updatePrinterDetail();
  }
}

// ✅ DEVAM ET fonksiyonu - resume komutu gönder
async function resumePrinterDetail() {
  if (currentDetailPrinter) {
    console.log(`▶️  Devam ediliyor: ${currentDetailPrinter.id}`);
    await resumePrinter(currentDetailPrinter.id);
    updatePrinterDetail();
  }
}

// ✅ Durdur fonksiyonu (her durumda dur)
async function stopPrinterDetail() {
  if (currentDetailPrinter) {
    console.log(`⏹️  Durduruluyor: ${currentDetailPrinter.id}`);
    await stopPrinter(currentDetailPrinter.id);
    updatePrinterDetail();
  }
}

/* ═══════════════════ MODAL AÇILINCA UPDATE ═══════════════════ */

function updateDetailOnSocketMessage() {
  if (currentDetailPrinter && printers[currentDetailPrinter.id]) {
    currentDetailPrinter = printers[currentDetailPrinter.id];
    updatePrinterDetail();
  }
}
/* ═══════════════════ USER MANAGEMENT MODAL ═══════════════════ */

function openUserModal() {
  document.getElementById('userEditId').value = '';
  document.getElementById('userUsername').value = '';
  document.getElementById('userPassword').value = '';
  document.getElementById('userRoleSelect').value = 'viewer';
  document.getElementById('userModalTitle').textContent = 'Yeni Kullanıcı';
  document.getElementById('userPassLabel').textContent = 'Şifre';
  document.getElementById('userPassword').required = true;
  document.getElementById('userModal').classList.add('active');
  refreshIcons();
}

function closeUserModal() {
  document.getElementById('userModal').classList.remove('active');
}

function editUserModal(userId, username, role) {
  document.getElementById('userEditId').value = userId;
  document.getElementById('userUsername').value = username;
  document.getElementById('userUsername').disabled = true;
  document.getElementById('userPassword').value = '';
  document.getElementById('userPassword').required = false;
  document.getElementById('userRoleSelect').value = role;
  document.getElementById('userModalTitle').textContent = username + ' - Düzenle';
  document.getElementById('userPassLabel').textContent = 'Yeni Şifre (boş bırakırsa değişmez)';
  document.getElementById('userModal').classList.add('active');
}

async function submitUserForm() {
  const editId = document.getElementById('userEditId').value;
  const username = document.getElementById('userUsername').value.trim();
  const password = document.getElementById('userPassword').value;
  const role = document.getElementById('userRoleSelect').value;

  if (!username) { toast('Kullanıcı adı zorunlu.', 'err'); return; }
  if (!editId && !password) { toast('Yeni kullanıcı için şifre zorunlu.', 'err'); return; }

  try {
    if (editId) {
      // Güncelle
      const data = { role };
      if (password) data.password = password;
      await apiFetch(`/api/users/${editId}`, {
        method: 'PUT',
        body: JSON.stringify(data)
      });
      toast(`${username} güncellendi.`, 'ok');
    } else {
      // Yeni
      await apiFetch('/api/users', {
        method: 'POST',
        body: JSON.stringify({ username, password, role })
      });
      toast(`${username} oluşturuldu.`, 'ok');
    }
    closeUserModal();
    loadUserList();  // Listeyi yenile
  } catch (err) {
    toast(`Hata: ${err.message}`, 'err');
  }
}

async function deleteUserConfirm(userId, username) {
  if (!confirm(`${username} silinsin mi?`)) return;
  try {
    await apiFetch(`/api/users/${userId}`, { method: 'DELETE' });
    toast(`${username} silindi.`, 'ok');
    loadUserList();
  } catch (err) {
    toast(`Silinemedi: ${err.message}`, 'err');
  }
}

function editUserModal(userId, username, role) {
  document.getElementById('userEditId').value = userId;
  document.getElementById('userUsername').value = username;
  document.getElementById('userUsername').disabled = true;
  document.getElementById('userPassword').value = '';
  document.getElementById('userPassword').required = false;
  document.getElementById('userRoleSelect').value = role;
  document.getElementById('userModalTitle').textContent = username + ' - Düzenle';
  document.getElementById('userPassLabel').textContent = 'Yeni Şifre (boş bırakırsa değişmez)';
  document.getElementById('userModal').classList.add('active');
}

/* ═══════════════════ PASSWORD CHANGE ═══════════════════ */

async function submitChangePassword() {
  const old = document.getElementById('pwOld').value;
  const neu = document.getElementById('pwNew').value;
  const neu2 = document.getElementById('pwNew2').value;

  if (!old || !neu) { toast('Mevcut ve yeni şifre gerekli.', 'err'); return; }
  if (neu !== neu2) { toast('Yeni şifreler eşleşmiyor.', 'err'); return; }
  if (neu.length < 3) { toast('Şifre en az 3 karakter olmalı.', 'err'); return; }

  try {
    await apiFetch('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword: old, newPassword: neu })
    });
    toast('Şifreniz değiştirildi.', 'ok');
    document.getElementById('pwOld').value = '';
    document.getElementById('pwNew').value = '';
    document.getElementById('pwNew2').value = '';
  } catch (err) {
    toast(`Şifre değiştirilemedi: ${err.message}`, 'err');
  }
}

/* ═══════════════════ GÜVENLİ KELİME ═══════════════════ */

async function loadSecureWordStatus() {
  const el = document.getElementById('secureWordStatus');
  if (!el) return;
  try {
    const data = await apiFetch('/api/auth/secure-word-status');
    if (data.hasSecureWord) {
      el.textContent = '✅ Güvenli kelimeniz tanımlı';
      el.style.color = 'var(--ok, #059669)';
    } else {
      el.textContent = '⚠️ Henüz güvenli kelime belirlemediniz';
      el.style.color = 'var(--warn, #d97706)';
    }
  } catch (err) {
    el.textContent = '-';
  }
}

async function submitSetSecureWord() {
  const currentPassword = document.getElementById('swCurrentPw').value;
  const secureWord = document.getElementById('swWord').value.trim();

  if (!currentPassword || !secureWord) {
    toast('Mevcut şifre ve güvenli kelime gerekli.', 'err');
    return;
  }
  if (secureWord.length < 3) {
    toast('Güvenli kelime en az 3 karakter olmalı.', 'err');
    return;
  }

  try {
    await apiFetch('/api/auth/set-secure-word', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, secureWord })
    });
    toast('Güvenli kelimeniz kaydedildi.', 'ok');
    document.getElementById('swCurrentPw').value = '';
    document.getElementById('swWord').value = '';
    loadSecureWordStatus();
  } catch (err) {
    toast(`Kaydedilemedi: ${err.message}`, 'err');
  }
}

/* ═══════════════════ ADMİN: ŞİFRE SIFIRLAMA İSTEKLERİ ═══════════════════ */

async function loadResetRequests() {
  const box = document.getElementById('resetRequestList');
  if (!box || !isAdmin()) return;

  try {
    const data = await apiFetch('/api/admin/reset-requests');
    const requests = data.data || [];

    if (!requests.length) {
      box.innerHTML = '<p style="color:var(--ink-muted);font-size:.85rem;padding:8px">Bekleyen istek yok.</p>';
      return;
    }

    box.innerHTML = requests.map(r => `
      <div class="user-row">
        <div class="avatar" style="width:36px;height:36px;border-radius:50%;background:var(--warn-tint, #fef3c7);color:var(--warn, #d97706);display:grid;place-items:center;font-weight:700">${r.username.charAt(0).toUpperCase()}</div>
        <div class="u-meta">
          <b>${r.username}</b>
          <span style="font-size:.75rem;color:var(--ink-muted)">${new Date(r.requested_at * 1000).toLocaleString('tr-TR')}</span>
        </div>
        <div class="row-actions" style="display:flex;gap:8px">
          <button onclick="approveResetRequest(${r.id}, '${r.username}')" title="Onayla" style="padding:6px 12px;border-radius:8px;border:1px solid var(--ok, #059669);background:var(--ok-tint, #ecfdf5);color:var(--ok, #059669);cursor:pointer;font-weight:700;font-size:.78rem">
            Onayla
          </button>
          <button onclick="rejectResetRequest(${r.id}, '${r.username}')" title="Reddet" style="padding:6px 12px;border-radius:8px;border:1px solid var(--err);background:var(--err-tint);color:var(--err);cursor:pointer;font-weight:700;font-size:.78rem">
            Reddet
          </button>
        </div>
      </div>
    `).join('');

    refreshIcons();
  } catch (err) {
    box.innerHTML = `<p style="color:var(--err);font-size:.85rem;padding:8px">Yüklenemedi: ${err.message}</p>`;
  }
}

async function approveResetRequest(id, username) {
  if (!confirm(`${username} için geçici şifre üretilsin mi?`)) return;

  try {
    const data = await apiFetch(`/api/admin/reset-requests/${id}/approve`, { method: 'POST' });
    // Geçici şifre SADECE burada, admin ekranında gösterilir
    alert(`✅ ${data.username} için geçici şifre üretildi:\n\n${data.tempPassword}\n\nBu şifreyi güvenli bir kanaldan (telefon/yüz yüze) kullanıcıya iletin. Ekran görüntüsü almayın.`);
    loadResetRequests();
  } catch (err) {
    toast(`Onaylanamadı: ${err.message}`, 'err');
  }
}

async function rejectResetRequest(id, username) {
  if (!confirm(`${username} isteği reddedilsin mi?`)) return;

  try {
    await apiFetch(`/api/admin/reset-requests/${id}/reject`, { method: 'POST' });
    toast(`${username} isteği reddedildi.`, 'ok');
    loadResetRequests();
  } catch (err) {
    toast(`Reddedilemedi: ${err.message}`, 'err');
  }
}

/* ═══════════════════ YAZICI ANALİTİK SEKMESİ (YENİ) ═══════════════════ */

function switchDetailTab(tabName) {
  document.querySelectorAll('.detail-tab-content').forEach(el => {
    el.style.display = 'none';
    el.classList.remove('active');
  });
  document.querySelectorAll('.detail-tab-btn').forEach(el => {
    el.style.color = 'var(--ink-muted)';
    el.style.borderBottomColor = 'transparent';
  });
  const selectedTab = document.getElementById('detailTab-' + tabName);
  if (selectedTab) {
    selectedTab.style.display = 'block';
    selectedTab.classList.add('active');
  }
  const btn = event.target.closest('.detail-tab-btn');
  if (btn) {
    btn.style.color = 'var(--primary)';
    btn.style.borderBottomColor = 'var(--primary)';
  }
  if (tabName === 'analytics' && currentDetailPrinter) {
    loadPrinterAnalytics(currentDetailPrinter.id);
  }
}

async function loadPrinterAnalytics(printerId) {
  const box = document.getElementById('analyticsContent');
  if (!box) return;
  try {
    const data = await apiFetch(`/api/printer/${encodeURIComponent(printerId)}/analytics`);
    if (!data || !data.ok) {
      box.innerHTML = `<div style="padding:20px;color:var(--err)">${(data && data.error) || 'Analitik verisi yüklenemedi'}</div>`;
      return;
    }
    const a = data.data.analytics;
    let html = '';

    if (a.uptime) {
      html += `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-bottom:18px">
          <div style="background:var(--surface-2,rgba(127,127,127,.08));padding:12px;border-radius:8px;text-align:center">
            <div style="font-size:22px;font-weight:700;color:var(--ok,#43a047)">${a.uptime.uptime_percent}%</div>
            <div style="font-size:11px;color:var(--ink-muted);text-transform:uppercase">Uptime</div>
          </div>
          <div style="background:var(--surface-2,rgba(127,127,127,.08));padding:12px;border-radius:8px;text-align:center">
            <div style="font-size:22px;font-weight:700;color:var(--primary)">${a.uptime.printing_percent}%</div>
            <div style="font-size:11px;color:var(--ink-muted);text-transform:uppercase">Çalışıyor</div>
          </div>
          <div style="background:var(--surface-2,rgba(127,127,127,.08));padding:12px;border-radius:8px;text-align:center">
            <div style="font-size:22px;font-weight:700;color:var(--warn,#f9a825)">${a.uptime.error_percent}%</div>
            <div style="font-size:11px;color:var(--ink-muted);text-transform:uppercase">Hata</div>
          </div>
          <div style="background:var(--surface-2,rgba(127,127,127,.08));padding:12px;border-radius:8px;text-align:center">
            <div style="font-size:22px;font-weight:700;color:var(--ink-muted)">${a.uptime.offline_percent}%</div>
            <div style="font-size:11px;color:var(--ink-muted);text-transform:uppercase">Kapalı</div>
          </div>
        </div>`;
    }

    if (a.monthly && a.monthly.length > 0) {
      html += `
        <div style="margin-bottom:18px">
          <h3 style="font-size:14px;font-weight:600;margin:0 0 10px;color:var(--ink)">Son 6 Ayın Performansı</h3>
          <table style="width:100%;font-size:12px;border-collapse:collapse">
            <thead><tr style="background:var(--surface-2,rgba(127,127,127,.08))">
              <th style="padding:8px;text-align:left">Ay</th>
              <th style="padding:8px;text-align:right">Saat</th>
              <th style="padding:8px;text-align:right">Başarı</th>
              <th style="padding:8px;text-align:right">Hata</th>
            </tr></thead><tbody>`;
      for (const m of a.monthly) {
        const col = m.success_rate >= 80 ? 'var(--ok,#43a047)' : m.success_rate >= 50 ? 'var(--warn,#f9a825)' : 'var(--err)';
        html += `<tr style="border-bottom:1px solid var(--line)">
          <td style="padding:8px">${m.month}</td>
          <td style="padding:8px;text-align:right;font-weight:600">${m.working_hours}h</td>
          <td style="padding:8px;text-align:right;color:${col}">${m.success_rate}%</td>
          <td style="padding:8px;text-align:right;color:var(--err)">${m.error_records}</td>
        </tr>`;
      }
      html += `</tbody></table></div>`;
    }

    if (a.costs && a.costs.total_prints > 0) {
      html += `
        <div style="background:var(--primary);color:#fff;padding:16px;border-radius:10px;margin-bottom:18px">
          <h3 style="font-size:14px;font-weight:600;margin:0 0 10px;opacity:.95">Üretim Metrikleri (2026)</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12px">
            <div><span style="opacity:.85">Toplam Baskı:</span> <strong>${a.costs.total_prints}</strong></div>
            <div><span style="opacity:.85">Üretilen Parça:</span> <strong>${a.costs.total_items}</strong></div>
            <div><span style="opacity:.85">Çalışma Saati:</span> <strong>${a.costs.total_hours}h</strong></div>
            <div><span style="opacity:.85">Ort. Kâr/Baskı:</span> <strong>$${(a.costs.avg_profit_per_print || 0).toFixed(2)}</strong></div>
            <div style="grid-column:1/-1;padding-top:8px;border-top:1px solid rgba(255,255,255,.25)">
              <span style="opacity:.85">Toplam Kâr:</span> <strong>$${(a.costs.total_profit || 0).toFixed(2)}</strong>
            </div>
          </div>
        </div>`;
    }

    if (a.errors && a.errors.length > 0) {
      html += `<div><h3 style="font-size:14px;font-weight:600;margin:0 0 10px;color:var(--ink)">Son Hatalar (${a.errors.length})</h3><div style="max-height:200px;overflow-y:auto">`;
      for (const e of a.errors.slice(0, 10)) {
        const d = new Date(e.timestamp * 1000).toLocaleDateString('tr-TR');
        html += `<div style="background:var(--surface-2,rgba(127,127,127,.08));padding:10px;border-radius:6px;margin-bottom:8px;border-left:3px solid var(--err);font-size:12px">
          <div style="display:flex;justify-content:space-between;margin-bottom:4px">
            <span style="font-weight:600;color:var(--err)">${(e.type || '').toUpperCase()}</span>
            <span style="color:var(--ink-muted)">${d}</span>
          </div>
          <div style="color:var(--ink-muted);font-size:11px">${e.message || '(Açıklama yok)'}</div>
        </div>`;
      }
      html += `</div></div>`;
    }

    if (!html) html = '<div style="padding:20px;text-align:center;color:var(--ink-muted)">Bu yazıcı için henüz analitik verisi yok</div>';
    box.innerHTML = html;
    if (window.lucide) lucide.createIcons();
  } catch (err) {
    box.innerHTML = `<div style="padding:20px;color:var(--err)">Hata: ${err.message}</div>`;
  }
}
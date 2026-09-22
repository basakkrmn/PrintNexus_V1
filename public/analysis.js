/**
 * PrintHQ - Analysis Page
 * Marka bazında analitik ve raporlar
 */

// ═══════════════════════════════════════════════════════════════
// AUTH & INIT
// ═══════════════════════════════════════════════════════════════

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
let currentBrand = 'ultimaker';
const charts = {};
let initedBrands = new Set();

async function init() {
  if (currentUser) {
    const nameEl = document.getElementById('userName');
    const roleEl = document.getElementById('userRole');
    const avEl = document.getElementById('userAvatar');
    if (nameEl) nameEl.textContent = currentUser.username;
    if (roleEl) roleEl.textContent = currentUser.role;
    if (avEl) avEl.textContent = (currentUser.username || '?').charAt(0).toUpperCase();
  }

  setupTheme();
  await loadBrandData(currentBrand);
  refreshIcons();
  setupWebSocket();
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.location.href = '/login.html';
}

function goTo(path) {
  window.location.href = path;
}

// ═══════════════════════════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════════════════════════

function setupTheme() {
  const savedTheme = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeButton();
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const newTheme = current === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
  updateThemeButton();
}

function updateThemeButton() {
  const theme = document.documentElement.getAttribute('data-theme');
  const icon = document.getElementById('themeIcon');
  const text = document.getElementById('themeText');
  if (theme === 'dark') {
    if (icon) icon.setAttribute('data-lucide', 'sun');
    if (text) text.textContent = 'Açık Mod';
  } else {
    if (icon) icon.setAttribute('data-lucide', 'moon');
    if (text) text.textContent = 'Koyu Mod';
  }
  refreshIcons();
}

// ═══════════════════════════════════════════════════════════════
// BRAND SWITCHING
// ═══════════════════════════════════════════════════════════════

async function switchBrand(brand) {
  currentBrand = brand;
  
  // Tab butonlarını güncelle
  document.querySelectorAll('.brand-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.brand === brand);
  });

  // Content'i göster
  document.querySelectorAll('.tab-content').forEach(tab => {
    tab.classList.toggle('active', tab.id === `tab-${brand}`);
  });

  // Canvas'ın görünür hale gelmesi için kısa bekleme (Chart.js boyut hesaplaması için)
  await new Promise(resolve => setTimeout(resolve, 50));

  // Verileri yükle (yazıcı selector'ı da içeride dolduruluyor)
  await loadBrandData(brand);

  refreshIcons();
}

// ═══════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════

async function loadBrandData(brand) {
  try {
    console.log(`📊 ${brand.toUpperCase()} verisi yükleniyor...`);

    const token = localStorage.getItem('token');

    // "all" brand için farklı endpoint'ler
    const telemetryUrl = brand === 'all'
      ? `/api/analytics/telemetry/all`
      : `/api/analytics/telemetry/${brand}`;

    const printResultsUrl = brand === 'all' 
      ? `/api/analytics/print-results/all` 
      : `/api/analytics/print-results/${brand}`;
    
    const efficiencyUrl = brand === 'all' 
      ? `/api/analytics/efficiency/all` 
      : `/api/analytics/efficiency/${brand}`;

    // Verileri paralel olarak çek
    const [telemetry, printResults, efficiency, printers] = await Promise.all([
      fetch(telemetryUrl, {
        headers: { 'Authorization': `Bearer ${token}` }
      }).then(r => r.json()),
      fetch(printResultsUrl, {
        headers: { 'Authorization': `Bearer ${token}` }
      }).then(r => r.json()),
      fetch(efficiencyUrl, {
        headers: { 'Authorization': `Bearer ${token}` }
      }).then(r => r.json()),
      fetch(`/api/printers`, {
        headers: { 'Authorization': `Bearer ${token}` }
      }).then(r => r.json())
    ]);

    // Tüm yazıcılar sekmesiyse hepsini birleştir
    let brandPrinters = [];
    if (brand === 'all') {
      brandPrinters = Object.values(printers).flat();
    } else {
      brandPrinters = printers[brand] || [];
    }

    const data = {
      telemetry: telemetry.ok ? telemetry.data : [],
      printResults: printResults.ok ? printResults.data : { successful: 0, failed: 0, ongoing: 0 },
      efficiency: efficiency.ok ? efficiency.data : [],
      printers: brandPrinters
    };

    console.log(`✅ ${brand.toUpperCase()} verisi yüklendi:`, data);

    // İstatistikleri güncelle
    updateStats(brand, data);

    // Yazıcı seçim listesini doldur (ilk açılışta da çalışsın)
    updatePrinterSelector(brand, brandPrinters);

    // Grafikleri oluştur/güncelle - HER MARKA İÇİN AYRI
    if (!initedBrands.has(brand)) {
      initCharts(brand, data);
      initedBrands.add(brand);
    } else {
      updateCharts(brand, data);
    }

  } catch (err) {
    console.error(`❌ ${brand} veri yükleme hatası:`, err);
  }
}

// ═══════════════════════════════════════════════════════════════
// STATS UPDATE
// ═══════════════════════════════════════════════════════════════

function updateStats(brand, data) {
  const { printers, printResults, efficiency } = data;

  // Toplam yazıcı
  document.getElementById(`stat-printers-${brand}`).textContent = printers.length;

  // Başarılı/Başarısız
  document.getElementById(`stat-success-${brand}`).textContent = 
    (printResults.successful || 0).toLocaleString('tr-TR');
  document.getElementById(`stat-failed-${brand}`).textContent = 
    (printResults.failed || 0).toLocaleString('tr-TR');

  // Ortalama verimlilik
  const avgEff = efficiency.length > 0 
    ? Math.round(efficiency.reduce((sum, e) => sum + (e.efficiency || 0), 0) / efficiency.length)
    : 0;
  document.getElementById(`stat-avg-efficiency-${brand}`).textContent = `${avgEff}%`;
}

// ═══════════════════════════════════════════════════════════════
// CHARTS INITIALIZATION
// ═══════════════════════════════════════════════════════════════

function initCharts(brand, data) {
  const t = chartTheme();
  Chart.defaults.font.family = "'Plus Jakarta Sans', sans-serif";
  Chart.defaults.color = t.text;

  // Sıcaklık Grafiği
  initTemperatureChart(brand, data, t);

  // Baskı Sonuçları Grafiği
  initSuccessRateChart(brand, data, t);

  // Verimlilik Grafiği
  initEfficiencyChart(brand, data, t);
}

function initTemperatureChart(brand, data, t) {
  const canvas = document.getElementById(`temperatureChart-${brand}`);
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const datasets = createTemperatureDatasets(data, t);
  const labels = generateTimeLabels();

  charts[`temp-${brand}`] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: datasets
    },
    options: baseChartOptions(t, {
      scales: {
        y: { 
          ticks: { color: t.text }, 
          grid: { color: t.grid, drawBorder: false },
          beginAtZero: false
        },
        x: { ticks: { color: t.text }, grid: { display: false, drawBorder: false } }
      }
    })
  });
}

function initSuccessRateChart(brand, data, t) {
  // "all" brand için farklı canvas ID
  const canvasId = brand === 'all' ? `printResultsChart-${brand}` : `successRateChart-${brand}`;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const { successful, failed, ongoing } = data.printResults;

  charts[`success-${brand}`] = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: ['Başarılı', 'Başarısız', 'Devam Eden'],
      datasets: [{
        data: [successful || 0, failed || 0, ongoing || 0],
        backgroundColor: [t.ok, t.err, t.brand],
        borderWidth: 0,
        hoverOffset: 6
      }]
    },
    options: baseChartOptions(t, { cutout: '68%' })
  });
}

function initEfficiencyChart(brand, data, t) {
  const canvas = document.getElementById(`efficiencyChart-${brand}`);
  if (!canvas) return;

  const labels = data.efficiency.map(e => e.name);
  const values = data.efficiency.map(e => e.efficiency || 0);

  charts[`efficiency-${brand}`] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Verim %',
        data: values,
        backgroundColor: t.brand,
        borderRadius: 8,
        borderSkipped: false,
        barThickness: 16
      }]
    },
    options: baseChartOptions(t, {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { 
          ticks: { color: t.text }, 
          grid: { color: t.grid, drawBorder: false }, 
          max: 100 
        },
        y: { ticks: { color: t.text }, grid: { display: false, drawBorder: false } }
      }
    })
  });
}

// ═══════════════════════════════════════════════════════════════
// CHARTS UPDATE
// ═══════════════════════════════════════════════════════════════

function updateCharts(brand, data) {
  const t = chartTheme();

  // Sıcaklık
  const tempChart = charts[`temp-${brand}`];
  if (tempChart) {
    const datasets = createTemperatureDatasets(data, t);
    tempChart.data.labels = generateTimeLabels(); // saat etiketleri de güncellensin
    tempChart.data.datasets = datasets;
    tempChart.update('none');
  }

  // Baskı Sonuçları
  const successChart = charts[`success-${brand}`];
  if (successChart && data.printResults) {
    successChart.data.datasets[0].data = [
      data.printResults.successful || 0,
      data.printResults.failed || 0,
      data.printResults.ongoing || 0
    ];
    successChart.update('none');
  }

  // Verimlilik
  const effChart = charts[`efficiency-${brand}`];
  if (effChart && data.efficiency) {
    const labels = data.efficiency.map(e => e.name);
    const values = data.efficiency.map(e => e.efficiency || 0);
    effChart.data.labels = labels;
    effChart.data.datasets[0].data = values;
    effChart.update('none');
  }
}

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// SICAKLIK GRAFİĞİ — SAATLİK ORTALAMA
// ═══════════════════════════════════════════════════════════════
// Telemetri 5 saniyede bir kaydediliyor; son 6 saatte binlerce nokta
// oluşuyor. Bunları X eksenindeki 7 saat etiketine ham olarak
// bindirmek, çizgiyi zaman ekseniyle uyumsuz hale getiriyordu (nokta
// sayısı >> etiket sayısı). Bunun yerine son 7 saati saatlik kovalara
// bölüp her yazıcı için o saatteki ortalama nozzle sıcaklığını
// gösteriyoruz → 7 etiket = 7 nokta, zaman ekseni artık gerçek veriyi
// yansıtıyor.

// Son 7 saatin başlangıç epoch'larını (saniye) döndürür — hem etiketler
// hem veri aynı sınırları kullansın diye tek kaynak.
function getHourBuckets() {
  const buckets = [];
  const now = new Date();
  // Şu anki saati saat başına yuvarla (dakika/saniye sıfırlanır)
  const currentHourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(currentHourStart.getTime() - i * 60 * 60 * 1000);
    buckets.push({
      startSec: Math.floor(d.getTime() / 1000),
      endSec: Math.floor(d.getTime() / 1000) + 3600,
      label: d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
    });
  }
  return buckets;
}

function createTemperatureDatasets(data, t) {
  const colors = [
    '#EF4444', '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6',
    '#EC4899', '#06B6D4', '#D97706', '#6366F1', '#14B8A6'
  ];

  const buckets = getHourBuckets();

  // Yazıcı bazında telemetriyi grupla
  const grouped = {};
  data.telemetry.forEach(item => {
    if (!grouped[item.printer_id]) grouped[item.printer_id] = [];
    grouped[item.printer_id].push(item);
  });

  return Object.entries(grouped).map(([printerId, items], idx) => {
    const color = colors[idx % colors.length];

    // Her saat kovası için o aralığa düşen nozzle değerlerinin ortalamasını al
    const hourlyAverages = buckets.map(b => {
      const inBucket = items.filter(i =>
        i.nozzle !== null &&
        i.timestamp >= b.startSec &&
        i.timestamp < b.endSec
      );
      if (inBucket.length === 0) return null; // Veri yoksa boş (çizgi kesintisi)
      const sum = inBucket.reduce((s, i) => s + i.nozzle, 0);
      return Math.round(sum / inBucket.length);
    });

    return {
      label: printerId,
      data: hourlyAverages,
      borderColor: color,
      backgroundColor: color + '20',
      borderWidth: 2,
      fill: false,
      tension: 0.4,
      spanGaps: true,        // Arada veri olmayan saatlerde çizgiyi bağla
      pointRadius: 3,        // Noktalar görünsün (saatlik olduğu için az sayıda)
      pointHoverRadius: 5
    };
  });
}

function generateTimeLabels() {
  // createTemperatureDatasets ile AYNI kovaları kullan → tam hizalı
  return getHourBuckets().map(b => b.label);
}

function chartTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    text: getComputedStyle(document.documentElement).getPropertyValue('--text').trim(),
    textSecondary: getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim(),
    grid: getComputedStyle(document.documentElement).getPropertyValue('--border').trim(),
    brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(),
    ok: '#10B981',
    err: '#EF4444'
  };
}

function baseChartOptions(t, extra) {
  return Object.assign({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: { 
          color: t.text, 
          usePointStyle: true, 
          pointStyle: 'circle',
          padding: 16, 
          font: { weight: '600', size: 12 } 
        }
      },
      tooltip: {
        backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(),
        titleColor: t.text,
        bodyColor: t.text,
        borderColor: t.grid,
        borderWidth: 1,
        padding: 10,
        cornerRadius: 8,
        usePointStyle: true
      }
    }
  }, extra || {});
}

// ═══════════════════════════════════════════════════════════════
// REPORT DOWNLOAD
// ═══════════════════════════════════════════════════════════════

async function downloadBrandReport(brand) {
  try {
    const token = localStorage.getItem('token');
    const format = document.getElementById(`reportFormat-${brand}`)?.value || 'txt';
    
    console.log(`📥 ${brand.toUpperCase()} raporu (${format.toUpperCase()}) indiriliyor...`);

    const res = await fetch(`/api/analytics/report/${brand}?format=${format}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    const now = new Date();
    const ext = format === 'xlsx' ? 'xlsx' : format === 'csv' ? 'csv' : 'txt';
    a.download = `${brand.toUpperCase()}_Raporu_${now.getDate()}_${now.getMonth()+1}_${now.getFullYear()}.${ext}`;
    
    document.body.appendChild(a);
    a.click();
    
    setTimeout(() => {
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    }, 100);

    alert(`✅ ${brand.toUpperCase()} raporu (${format.toUpperCase()}) indirildi!`);
    console.log(`✅ Rapor indirildi`);

  } catch (err) {
    console.error(`❌ Rapor indirme hatası:`, err);
    alert(`❌ Rapor indirilemedi:\n${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════════════════

function setupWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${window.location.host}`);

  ws.onopen = () => {
    updateConnectionBadge(true);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'status') {
        // Durumları güncelle
        loadBrandData(currentBrand);
      }
    } catch (e) {
      // JSON parse hatası
    }
  };

  ws.onclose = () => {
    updateConnectionBadge(false);
    setTimeout(setupWebSocket, 5000);
  };

  window.ws = ws;
}

function updateConnectionBadge(connected) {
  const badge = document.getElementById('ws-badge');
  if (badge) {
    if (connected) {
      badge.innerHTML = '<span class="dot" style="background: #10B981;"></span>Bağlı';
    } else {
      badge.innerHTML = '<span class="dot"></span>Bağlantı yok';
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════

function toggleSidebar() {
  document.getElementById('app').classList.toggle('sidebar-collapsed');
  const chevron = document.getElementById('sidebarChevron');
  if (chevron) {
    chevron.setAttribute('data-lucide', 
      document.getElementById('app').classList.contains('sidebar-collapsed') 
        ? 'chevron-right' 
        : 'chevron-left'
    );
    refreshIcons();
  }
}

function toggleNav() {
  document.getElementById('app').classList.toggle('nav-open');
}

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', init);

// ═══════════════════════════════════════════════════════════════
// PRINTER SELECTOR & DETAIL
// ═══════════════════════════════════════════════════════════════

async function updatePrinterSelector(brand, printerList = null) {
  try {
    // Liste hazırsa onu kullan; yoksa API'den çek
    let printers = printerList;
    if (printers === null) {
      const token = localStorage.getItem('token');
      const response = await fetch('/api/printers', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json();
      printers = brand === 'all'
        ? Object.values(data).flat()
        : (data[brand.toLowerCase()] || []);
    }
    const select = document.getElementById(`printerSelect-${brand}`);
    const container = document.getElementById(`printerSelectorContainer-${brand}`);
    if (!select || !container) return;
    
    select.innerHTML = '<option value="">-- Yazıcı Seçin --</option>';
    printers.forEach(p => {
      const option = document.createElement('option');
      option.value = p.id;
      option.textContent = p.name;
      select.appendChild(option);
    });
    
    container.style.display = printers.length > 0 ? 'block' : 'none';
    const detailPanel = document.getElementById(`printerDetailStats-${brand}`);
    if (detailPanel) detailPanel.style.display = 'none';
  } catch (err) {
    console.error('Printer selector error:', err);
  }
}

async function selectPrinter(printerId, brand) {
  const detailPanel = document.getElementById(`printerDetailStats-${brand}`);
  if (!printerId) {
    if (detailPanel) detailPanel.style.display = 'none';
    return;
  }

  try {
    const token = localStorage.getItem('token');
    const url = `/api/analytics/printer-detail/${encodeURIComponent(printerId)}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const result = await response.json();

    if (!result.ok) {
      console.error(`Yazıcı detayı alınamadı:`, result.error);
      return;
    }

    const stats = result.data.stats;
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    setVal(`detail-workingHours-${brand}`, stats.workingHours);
    setVal(`detail-totalPrints-${brand}`, stats.totalPrints);
    setVal(`detail-successful-${brand}`, stats.successfulPrints);
    setVal(`detail-failed-${brand}`, stats.failedPrints);
    setVal(`detail-successRate-${brand}`, stats.successRate + '%');
    setVal(`detail-errorRate-${brand}`, stats.errorRate + '%');
    // Bakim: tavsiye niteliginde geri sayim
    const gun = stats.daysUntilMaintenance;
    let bakimMetni;
    if (gun < 0)       bakimMetni = `${Math.abs(gun)} gün gecikti`;
    else if (gun === 0) bakimMetni = 'Bugün önerilir';
    else                bakimMetni = `${gun} gün`;
    setVal(`detail-daysUntilMaintenance-${brand}`, bakimMetni);
    if (detailPanel) detailPanel.style.display = 'block';

  } catch (err) {
    console.error('Printer detail error:', err);
  }
}
/* ── DOM helpers ── */
const $ = id => document.getElementById(id);
const DPR = Math.min(window.devicePixelRatio || 1, 2);

const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const fmt = n => n == null ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtChg = n => n == null ? '' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

/* ── Storage keys ── */
const KEY_STATE = 'bk_ptstate';
const KEY_THEME = 'bk_theme';
const KEY_FINNHUB = 'bk_finnhub_key';
const finnhubKey = () => localStorage.getItem(KEY_FINNHUB) || '';

/* ── State ── */
let state = { accounts: [], prices: {}, history: {}, lastUpdated: null };
let currentAccountId = null;
let chartDots = [], detailDots = [];
let dropdownActive = -1;
let tickerSearchInit = false;
let dragCleanup = null;
let floatState = { x: null, y: null, w: 340, h: 360 };
let refreshTimer = null;
let resizeRaf = 0;

function loadState() {
  try { const s = localStorage.getItem(KEY_STATE); if (s) state = JSON.parse(s); } catch (e) {}
  if (!state.accounts || !state.accounts.length) {
    state = {
      accounts: [
        { id: 'acct1', name: 'Main Brokerage', holdings: [] },
        { id: 'acct2', name: 'Roth IRA', holdings: [] }
      ],
      prices: {}, history: {}, lastUpdated: null
    };
  }
  if (!state.history) state.history = {};
  if (!state.prices) state.prices = {};
}
function saveState() {
  try { localStorage.setItem(KEY_STATE, JSON.stringify(state)); } catch (e) {}
}

/* ── Price fetching ── */
async function fetchPrice(ticker) {
  const key = finnhubKey();
  if (key) {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(key)}`);
      if (r.ok) {
        const d = await r.json();
        if (d?.c && d.c !== 0) return { price: d.c, chgPct: d.pc ? ((d.c - d.pc) / d.pc) * 100 : null };
      }
    } catch (e) {}
  }
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`);
      if (!r.ok) continue;
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        const price = meta.regularMarketPrice;
        const prev = meta.previousClose || meta.chartPreviousClose;
        return { price, chgPct: prev ? ((price - prev) / prev) * 100 : null };
      }
    } catch (e) {}
  }
  return null;
}

async function fetchHistoricalPrices(ticker) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - (31 * 24 * 60 * 60);
  const key = finnhubKey();

  if (key) {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(ticker)}&resolution=D&from=${from}&to=${to}&token=${encodeURIComponent(key)}`);
      if (r.ok) {
        const d = await r.json();
        if (d.s === 'ok' && d.c?.length) {
          const out = {};
          d.t.forEach((ts, i) => { if (d.c[i] != null) out[new Date(ts * 1000).toISOString().split('T')[0]] = d.c[i]; });
          if (Object.keys(out).length > 1) return out;
        }
      }
    } catch (e) {}
  }

  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1mo`);
      if (!r.ok) continue;
      const d = await r.json();
      const result = d?.chart?.result?.[0];
      const timestamps = result?.timestamp;
      const closes = result?.indicators?.quote?.[0]?.close;
      if (!timestamps?.length || !closes?.length) continue;
      const out = {};
      timestamps.forEach((ts, i) => { if (closes[i] != null) out[new Date(ts * 1000).toISOString().split('T')[0]] = closes[i]; });
      if (Object.keys(out).length > 1) return out;
    } catch (e) {}
  }
  return null;
}

async function refreshAll() {
  const btn = $('refreshBtn');
  btn.classList.add('spinning'); btn.disabled = true;
  const tickers = [...new Set(state.accounts.flatMap(a => a.holdings.map(h => h.ticker)))];
  const results = await Promise.all(tickers.map(t => fetchPrice(t).then(r => [t, r])));
  results.forEach(([t, r]) => { if (r) state.prices[t] = r; });
  state.lastUpdated = new Date().toLocaleTimeString();
  takeSnapshot(); saveState(); render();
  btn.classList.remove('spinning'); btn.disabled = false;

  const acctsWith = state.accounts.filter(a => a.holdings.length);
  if (acctsWith.length) {
    Promise.all(acctsWith.map(a => backfillHistory(a.id)))
      .then(() => { saveState(); render(); });
  }
}

/* ── Render ── */
function render() {
  const list = $('accountsList');
  let totalVal = 0, totalDayGain = 0, totalPos = 0, hasPrices = false;

  const cards = state.accounts.map(acct => {
    let acctVal = 0;
    const acctIdSafe = escHtml(acct.id);
    const rows = acct.holdings.map((h, hi) => {
      const p = state.prices[h.ticker];
      const price = p?.price, chgPct = p?.chgPct;
      const val = price != null ? price * h.shares : null;
      if (val != null) { acctVal += val; hasPrices = true; }
      const dayChg = (price != null && chgPct != null) ? (price - price / (1 + chgPct / 100)) * h.shares : null;
      if (dayChg != null) totalDayGain += dayChg;
      totalPos++;
      const priceCell = price != null
        ? `<span class="price-mono">${fmt(price)}</span> <span class="chg ${chgPct >= 0 ? 'pos' : 'neg'}">${fmtChg(chgPct)}</span>`
        : `<span class="loading-price">fetching...</span>`;
      return `<tr>
        <td><span class="ticker">${escHtml(h.ticker)}</span></td>
        <td class="r">${h.shares.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
        <td class="r">${priceCell}</td>
        <td class="r price-mono">${val != null ? fmt(val) : '—'}</td>
        <td class="r price-mono col-cost">${h.costBasis ? fmt(h.costBasis * h.shares) : '—'}</td>
        <td class="r"><button class="del-row" data-action="delete-holding" data-acct-id="${acctIdSafe}" data-idx="${hi}">×</button></td>
      </tr>`;
    }).join('');
    totalVal += acctVal;
    return `<div class="account-card">
      <div class="account-header">
        <div class="account-name-wrap"><div class="account-dot"></div><span class="account-name" data-action="rename-account" data-acct-id="${acctIdSafe}" title="Click to rename">${escHtml(acct.name)}</span></div>
        <div class="account-header-right">
          <span class="account-total">${acctVal ? fmt(acctVal) : '—'}</span>
          <div class="account-actions">
            <button class="btn-small" data-action="add-stock" data-acct-id="${acctIdSafe}">+ Add</button>
            <button class="btn-small danger" data-action="delete-account" data-acct-id="${acctIdSafe}">Remove</button>
          </div>
        </div>
      </div>
      ${acct.holdings.length
        ? `<div class="table-wrap"><table class="holdings-table">
            <thead><tr><th>Ticker</th><th class="r">Shares</th><th class="r">Price</th><th class="r">Value</th><th class="r col-cost">Avg buy price</th><th class="r"></th></tr></thead>
            <tbody>${rows}</tbody></table></div>`
        : `<div class="empty">No holdings — click + Add to get started.</div>`}
    </div>`;
  });
  list.innerHTML = cards.join('');

  $('totalVal').textContent = hasPrices ? fmt(totalVal) : '—';
  const dg = $('dayGain');
  if (hasPrices) {
    dg.textContent = (totalDayGain >= 0 ? '+' : '') + fmt(totalDayGain);
    dg.className = 'metric-value ' + (totalDayGain >= 0 ? 'pos' : 'neg');
  } else {
    dg.textContent = '—'; dg.className = 'metric-value';
  }
  $('acctCount').textContent = state.accounts.length;
  $('posCount').textContent = totalPos;
  if (state.lastUpdated) $('lastUpdated').textContent = 'Updated ' + state.lastUpdated;

  renderMainChart();
}

/* ── Historical backfill ── */
async function backfillHistory(acctId) {
  const acct = state.accounts.find(a => a.id === acctId);
  if (!acct || !acct.holdings.length) return;

  const histMap = {};
  for (const h of acct.holdings) {
    const prices = await fetchHistoricalPrices(h.ticker);
    if (prices) histMap[h.ticker] = { prices, shares: h.shares };
  }
  if (!Object.keys(histMap).length) return;

  const allDates = new Set();
  Object.values(histMap).forEach(({ prices }) => Object.keys(prices).forEach(d => allDates.add(d)));

  if (!state.history[acctId]) state.history[acctId] = [];
  const existingDates = new Set(state.history[acctId].map(s => s.date));

  [...allDates].sort().forEach(date => {
    if (existingDates.has(date)) return;
    let val = 0, hasData = false;
    Object.values(histMap).forEach(({ prices, shares }) => {
      if (prices[date] != null) { val += prices[date] * shares; hasData = true; }
    });
    if (hasData && val > 0) state.history[acctId].push({ date, value: val });
  });

  state.history[acctId].sort((a, b) => a.date.localeCompare(b.date));
  if (state.history[acctId].length > 90) state.history[acctId] = state.history[acctId].slice(-90);
}

function pruneHistory() {
  if (!state.history) return;
  const activeIds = new Set(state.accounts.filter(a => a.holdings.length > 0).map(a => a.id));
  Object.keys(state.history).forEach(id => { if (!activeIds.has(id)) delete state.history[id]; });
}

function takeSnapshot() {
  const today = new Date().toISOString().split('T')[0];
  if (!state.history) state.history = {};
  state.accounts.forEach(acct => {
    if (!state.history[acct.id]) state.history[acct.id] = [];
    let val = 0, hasPrice = false;
    acct.holdings.forEach(h => {
      const p = state.prices[h.ticker];
      if (p?.price) { val += p.price * h.shares; hasPrice = true; }
    });
    if (!hasPrice || val === 0) return;
    const existing = state.history[acct.id].find(s => s.date === today);
    if (existing) { existing.value = val; }
    else {
      state.history[acct.id].push({ date: today, value: val });
      state.history[acct.id].sort((a, b) => a.date.localeCompare(b.date));
      if (state.history[acct.id].length > 90) state.history[acct.id].shift();
    }
  });
}

/* ── Chart ── */
const ACCT_COLORS = ['#FDD023', '#6a3dab', '#4ade80', '#60a5fa', '#f87171', '#fb923c'];
const acctColor = idx => ACCT_COLORS[idx % ACCT_COLORS.length];

function getAllDates() {
  const dates = new Set();
  if (!state.history) return [];
  Object.values(state.history).forEach(h => h.forEach(s => dates.add(s.date)));
  return [...dates].sort();
}

function renderMainChart() {
  const canvas = $('mainChart');
  const wrap = $('chartCanvasWrap');
  const empty = $('chartEmpty');
  const hint = $('chartHint');
  if (!canvas || !wrap) return;
  renderLegend();

  const dates = getAllDates();
  const hasHistory = dates.length >= 1 && state.accounts.some(a => (state.history?.[a.id] || []).length > 0);

  if (!hasHistory) {
    canvas.style.display = 'none'; empty.style.display = 'block'; hint.style.display = 'none'; return;
  }
  canvas.style.display = 'block'; empty.style.display = 'none'; hint.style.display = 'block';

  const W = wrap.clientWidth;
  const H = wrap.clientHeight - 8;
  if (!W || H < 60) return;

  canvas.width = W * DPR; canvas.height = H * DPR;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const PAD = { top: 12, right: 10, bottom: 26, left: 54 };
  const cW = W - PAD.left - PAD.right, cH = H - PAD.top - PAD.bottom;

  // O(1) date → index
  const dateIdx = new Map(dates.map((d, i) => [d, i]));

  let minVal = Infinity, maxVal = -Infinity;
  state.accounts.forEach(a => {
    (state.history?.[a.id] || []).forEach(s => {
      if (s.value < minVal) minVal = s.value;
      if (s.value > maxVal) maxVal = s.value;
    });
  });
  if (!isFinite(minVal)) return;
  const spread = maxVal - minVal || maxVal * 0.1 || 1000;
  minVal -= spread * 0.12; maxVal += spread * 0.12;

  const toX = i => PAD.left + (dates.length === 1 ? cW / 2 : (i / (dates.length - 1)) * cW);
  const toY = v => PAD.top + cH - ((v - minVal) / (maxVal - minVal)) * cH;
  const gridC = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.05)';
  const labelC = isDark ? '#444' : '#bbb';

  for (let i = 0; i <= 3; i++) {
    const v = minVal + (maxVal - minVal) * (i / 3), y = toY(v);
    ctx.strokeStyle = gridC; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cW, y); ctx.stroke();
    ctx.fillStyle = labelC; ctx.font = '9px Courier New, monospace'; ctx.textAlign = 'right';
    ctx.fillText(v >= 1000 ? '$' + (v / 1000).toFixed(0) + 'k' : '$' + Math.round(v), PAD.left - 4, y + 3);
  }
  ctx.fillStyle = labelC; ctx.font = '9px Georgia, serif'; ctx.textAlign = 'center';
  const iv = Math.max(1, Math.floor(dates.length / 4));
  dates.forEach((d, i) => { if (i % iv !== 0 && i !== dates.length - 1) return; ctx.fillText(d.slice(5), toX(i), H - 5); });

  chartDots = [];
  state.accounts.forEach((acct, ai) => {
    const hist = state.history?.[acct.id] || [];
    if (!hist.length) return;
    const color = acctColor(ai);
    ctx.save(); ctx.beginPath();
    hist.forEach((s, si) => {
      const x = toX(dateIdx.get(s.date)), y = toY(s.value);
      si === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.lineTo(toX(dateIdx.get(hist[hist.length - 1].date)), toY(minVal));
    ctx.lineTo(toX(dateIdx.get(hist[0].date)), toY(minVal));
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + cH);
    grad.addColorStop(0, color + '1a'); grad.addColorStop(1, color + '00');
    ctx.fillStyle = grad; ctx.fill(); ctx.restore();

    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
    hist.forEach((s, si) => {
      const x = toX(dateIdx.get(s.date)), y = toY(s.value);
      si === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    hist.forEach(s => {
      const x = toX(dateIdx.get(s.date)), y = toY(s.value);
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
      ctx.strokeStyle = isDark ? '#111' : '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      chartDots.push({ x, y, acctId: acct.id, acctName: acct.name, date: s.date, value: s.value, color, acctIdx: ai });
    });
  });
}

function renderLegend() {
  const el = $('chartLegend');
  if (!el) return;
  el.innerHTML = state.accounts.filter(a => a.holdings.length > 0).map(a => {
    const ai = state.accounts.indexOf(a);
    const c = acctColor(ai);
    return `<div class="legend-item"><div class="legend-dot" style="background:${c}"></div><span style="color:${c}">${escHtml(a.name)}</span></div>`;
  }).join('');
}

function findDot(dots, mx, my, r = 18) {
  let best = null, bd = r;
  dots.forEach(d => { const dist = Math.hypot(d.x - mx, d.y - my); if (dist < bd) { bd = dist; best = d; } });
  return best;
}

/* Setup chart interaction once — handlers read latest chartDots from closure */
function setupChartInteraction() {
  const canvas = $('mainChart');
  const tooltip = $('chartTooltip');
  if (!canvas || !tooltip || canvas._wired) return;
  canvas._wired = true;
  canvas.addEventListener('mousemove', e => {
    const r = canvas.getBoundingClientRect();
    const dot = findDot(chartDots, e.clientX - r.left, e.clientY - r.top);
    if (dot) {
      canvas.style.cursor = 'pointer'; tooltip.style.display = 'block';
      tooltip.style.left = (dot.x + 10) + 'px'; tooltip.style.top = Math.max(0, dot.y - 44) + 'px';
      tooltip.innerHTML = `<span style="color:${dot.color}">${escHtml(dot.acctName)}</span><br>${dot.date}<br>${fmt(dot.value)}`;
    } else { canvas.style.cursor = 'default'; tooltip.style.display = 'none'; }
  });
  canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
  canvas.addEventListener('click', e => {
    const r = canvas.getBoundingClientRect();
    const dot = findDot(chartDots, e.clientX - r.left, e.clientY - r.top);
    if (dot) openDetail(dot.acctId, e.clientX, e.clientY);
  });
}

/* Coalesce resize-driven re-renders into one frame */
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; renderMainChart(); });
  }).observe($('chartCanvasWrap'));
}

/* ── Pop out / Dock ── */
function popOutChart() {
  const panel = $('chartPanel');
  const rect = panel.getBoundingClientRect();
  floatState = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };

  panel.classList.add('is-floating');
  panel.style.left = floatState.x + 'px';
  panel.style.top = floatState.y + 'px';
  panel.style.width = floatState.w + 'px';
  panel.style.height = floatState.h + 'px';

  $('popBtn').style.display = 'none';
  $('dockBtn').style.display = 'flex';
  $('chartPlaceholder').style.display = 'block';

  enableDragResize();
  requestAnimationFrame(renderMainChart);
}

function dockChart() {
  const panel = $('chartPanel');
  panel.classList.remove('is-floating');
  panel.style.cssText = '';

  $('popBtn').style.display = 'flex';
  $('dockBtn').style.display = 'none';
  $('chartPlaceholder').style.display = 'none';

  disableDragResize();
  requestAnimationFrame(renderMainChart);
}

/* ── Drag / Resize ── */
function enableDragResize() {
  disableDragResize();

  const panel = $('chartPanel');
  const grip = $('dragGrip');
  const resizeEl = $('chartResize');
  let mode = null, startX, startY, startL, startT, startW, startH;

  function onMouseDown(e, m) {
    if (e.button !== 0) return;
    mode = m;
    const rect = panel.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startL = rect.left; startT = rect.top;
    startW = rect.width; startH = rect.height;
    document.body.style.userSelect = 'none';
    e.preventDefault(); e.stopPropagation();
  }
  function onMove(e) {
    if (!mode) return;
    if (mode === 'drag') {
      panel.style.left = Math.max(0, Math.min(window.innerWidth - 80, startL + e.clientX - startX)) + 'px';
      panel.style.top = Math.max(0, Math.min(window.innerHeight - 60, startT + e.clientY - startY)) + 'px';
    } else if (mode === 'resize') {
      panel.style.width = Math.max(280, startW + e.clientX - startX) + 'px';
      panel.style.height = Math.max(240, startH + e.clientY - startY) + 'px';
      if (!resizeRaf) resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; renderMainChart(); });
    }
  }
  function onUp() { if (mode) { mode = null; document.body.style.userSelect = ''; } }

  const onGripDown = e => onMouseDown(e, 'drag');
  const onResizeDown = e => onMouseDown(e, 'resize');

  grip.addEventListener('mousedown', onGripDown);
  resizeEl.addEventListener('mousedown', onResizeDown);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);

  // Touch
  let tStartX, tStartY, tStartL, tStartT;
  const onTouchStart = e => {
    const t = e.touches[0];
    const rect = panel.getBoundingClientRect();
    tStartX = t.clientX; tStartY = t.clientY; tStartL = rect.left; tStartT = rect.top;
  };
  const onTouchMove = e => {
    const t = e.touches[0];
    panel.style.left = Math.max(0, tStartL + t.clientX - tStartX) + 'px';
    panel.style.top = Math.max(0, tStartT + t.clientY - tStartY) + 'px';
  };
  grip.addEventListener('touchstart', onTouchStart, { passive: true });
  grip.addEventListener('touchmove', onTouchMove, { passive: true });

  dragCleanup = () => {
    grip.removeEventListener('mousedown', onGripDown);
    resizeEl.removeEventListener('mousedown', onResizeDown);
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    grip.removeEventListener('touchstart', onTouchStart);
    grip.removeEventListener('touchmove', onTouchMove);
  };
}
function disableDragResize() {
  if (dragCleanup) { dragCleanup(); dragCleanup = null; }
}

/* ── Detail iris ── */
function openDetail(acctId, originX, originY) {
  const acct = state.accounts.find(a => a.id === acctId);
  if (!acct) return;
  const ai = state.accounts.indexOf(acct);
  spawnBurst(originX, originY);
  $('detailName').textContent = acct.name;
  const hist = state.history?.[acctId] || [];
  if (hist.length >= 2) {
    const chg = ((hist[hist.length - 1].value - hist[0].value) / hist[0].value) * 100;
    const col = chg >= 0 ? 'var(--pos)' : 'var(--neg)';
    $('detailPerf').innerHTML = `<span style="color:${col}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% all time</span>`;
  } else { $('detailPerf').textContent = ''; }
  const overlay = $('shutterOverlay');
  overlay.style.display = 'flex';
  overlay.style.clipPath = `circle(0% at ${originX}px ${originY}px)`;
  overlay.style.transition = 'none'; void overlay.offsetHeight;
  overlay.style.transition = 'clip-path 0.52s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
  overlay.style.clipPath = `circle(160% at ${originX}px ${originY}px)`;
  setTimeout(() => renderDetailChart(acctId, acctColor(ai)), 300);
}

function closeDetail() {
  const overlay = $('shutterOverlay');
  overlay.style.transition = 'clip-path 0.38s cubic-bezier(0.55, 0, 0.55, 0.2)';
  overlay.style.clipPath = `circle(0% at 50% 50%)`;
  setTimeout(() => { overlay.style.display = 'none'; overlay.style.clipPath = ''; }, 400);
}

function spawnBurst(x, y) {
  [false, true].forEach(r2 => {
    const b = document.createElement('div');
    b.className = 'click-burst' + (r2 ? ' r2' : '');
    b.style.cssText = `left:${x}px;top:${y}px`;
    document.body.appendChild(b);
    setTimeout(() => b.remove(), 900);
  });
}

function renderDetailChart(acctId, color) {
  const canvas = $('detailChart');
  const wrap = $('detailCanvasWrap');
  if (!canvas || !wrap) return;
  const W = wrap.clientWidth, H = wrap.clientHeight - 20;
  if (!W || H < 50) return;
  canvas.width = W * DPR; canvas.height = H * DPR;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d'); ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const hist = (state.history?.[acctId] || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  if (!hist.length) return;
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const PAD = { top: 20, right: 24, bottom: 44, left: 72 };
  const cW = W - PAD.left - PAD.right, cH = H - PAD.top - PAD.bottom;

  // O(n) min/max via reduce
  let minV = Infinity, maxV = -Infinity;
  hist.forEach(s => { if (s.value < minV) minV = s.value; if (s.value > maxV) maxV = s.value; });
  const sp = maxV - minV || maxV * 0.1 || 1000;
  minV -= sp * 0.15; maxV += sp * 0.15;

  const toX = i => PAD.left + (hist.length === 1 ? cW / 2 : (i / (hist.length - 1)) * cW);
  const toY = v => PAD.top + cH - ((v - minV) / (maxV - minV)) * cH;
  const gridC = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';
  const labelC = isDark ? '#555' : '#aaa';

  for (let i = 0; i <= 4; i++) {
    const v = minV + (maxV - minV) * (i / 4), y = toY(v);
    ctx.strokeStyle = gridC; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cW, y); ctx.stroke();
    ctx.fillStyle = labelC; ctx.font = '10px Courier New, monospace'; ctx.textAlign = 'right';
    ctx.fillText('$' + Math.round(v).toLocaleString(), PAD.left - 6, y + 4);
  }
  ctx.fillStyle = labelC; ctx.font = '10px Georgia, serif'; ctx.textAlign = 'center';
  const iv = Math.max(1, Math.floor(hist.length / 6));
  hist.forEach((s, i) => { if (i % iv !== 0 && i !== hist.length - 1) return; ctx.fillText(s.date.slice(5), toX(i), H - 12); });

  ctx.save(); ctx.beginPath();
  hist.forEach((s, i) => { i === 0 ? ctx.moveTo(toX(i), toY(s.value)) : ctx.lineTo(toX(i), toY(s.value)); });
  ctx.lineTo(toX(hist.length - 1), toY(minV)); ctx.lineTo(toX(0), toY(minV)); ctx.closePath();
  const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + cH);
  grad.addColorStop(0, color + '30'); grad.addColorStop(1, color + '00');
  ctx.fillStyle = grad; ctx.fill(); ctx.restore();
  ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round';
  hist.forEach((s, i) => { i === 0 ? ctx.moveTo(toX(i), toY(s.value)) : ctx.lineTo(toX(i), toY(s.value)); });
  ctx.stroke();

  detailDots = [];
  hist.forEach((s, i) => {
    const x = toX(i), y = toY(s.value);
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = isDark ? '#0a0a0a' : '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    detailDots.push({ x, y, date: s.date, value: s.value, color });
  });
  setupDetailInteraction();
}

function setupDetailInteraction() {
  const canvas = $('detailChart');
  const tooltip = $('detailTooltip');
  if (!canvas || !tooltip || canvas._wired) return;
  canvas._wired = true;
  canvas.addEventListener('mousemove', e => {
    const r = canvas.getBoundingClientRect();
    const dot = findDot(detailDots, e.clientX - r.left, e.clientY - r.top, 24);
    if (dot) {
      canvas.style.cursor = 'crosshair'; tooltip.style.display = 'block';
      tooltip.style.left = (dot.x + 12) + 'px'; tooltip.style.top = Math.max(0, dot.y - 44) + 'px';
      tooltip.innerHTML = `${dot.date}<br>${fmt(dot.value)}`;
    } else { canvas.style.cursor = 'default'; tooltip.style.display = 'none'; }
  });
  canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
}

/* ── Ticker autocomplete ── */
const STOCK_DB = [
  { s: 'AAPL', n: 'Apple Inc' }, { s: 'MSFT', n: 'Microsoft Corp' }, { s: 'NVDA', n: 'NVIDIA Corp' },
  { s: 'AMZN', n: 'Amazon.com Inc' }, { s: 'GOOGL', n: 'Alphabet Inc Class A' }, { s: 'GOOG', n: 'Alphabet Inc Class C' },
  { s: 'META', n: 'Meta Platforms Inc' }, { s: 'TSLA', n: 'Tesla Inc' }, { s: 'BRK.B', n: 'Berkshire Hathaway B' },
  { s: 'LLY', n: 'Eli Lilly & Co' }, { s: 'JPM', n: 'JPMorgan Chase & Co' }, { s: 'V', n: 'Visa Inc' },
  { s: 'UNH', n: 'UnitedHealth Group Inc' }, { s: 'XOM', n: 'Exxon Mobil Corp' }, { s: 'MA', n: 'Mastercard Inc' },
  { s: 'AVGO', n: 'Broadcom Inc' }, { s: 'PG', n: 'Procter & Gamble Co' }, { s: 'JNJ', n: 'Johnson & Johnson' },
  { s: 'HD', n: 'Home Depot Inc' }, { s: 'MRK', n: 'Merck & Co Inc' }, { s: 'COST', n: 'Costco Wholesale Corp' },
  { s: 'ABBV', n: 'AbbVie Inc' }, { s: 'CVX', n: 'Chevron Corp' }, { s: 'BAC', n: 'Bank of America Corp' },
  { s: 'CRM', n: 'Salesforce Inc' }, { s: 'NFLX', n: 'Netflix Inc' }, { s: 'AMD', n: 'Advanced Micro Devices' },
  { s: 'WMT', n: 'Walmart Inc' }, { s: 'PEP', n: 'PepsiCo Inc' }, { s: 'KO', n: 'Coca-Cola Co' },
  { s: 'TMO', n: 'Thermo Fisher Scientific' }, { s: 'ORCL', n: 'Oracle Corp' }, { s: 'ACN', n: 'Accenture PLC' },
  { s: 'MCD', n: "McDonald's Corp" }, { s: 'CSCO', n: 'Cisco Systems Inc' }, { s: 'ABT', n: 'Abbott Laboratories' },
  { s: 'ADBE', n: 'Adobe Inc' }, { s: 'WFC', n: 'Wells Fargo & Co' }, { s: 'LIN', n: 'Linde PLC' },
  { s: 'TXN', n: 'Texas Instruments' }, { s: 'PM', n: 'Philip Morris International' },
  { s: 'NOW', n: 'ServiceNow Inc' }, { s: 'INTU', n: 'Intuit Inc' }, { s: 'CAT', n: 'Caterpillar Inc' },
  { s: 'AMGN', n: 'Amgen Inc' }, { s: 'GS', n: 'Goldman Sachs Group' }, { s: 'IBM', n: 'IBM Corp' },
  { s: 'DIS', n: 'Walt Disney Co' }, { s: 'MS', n: 'Morgan Stanley' }, { s: 'GE', n: 'GE Aerospace' },
  { s: 'RTX', n: 'RTX Corp' }, { s: 'SPGI', n: 'S&P Global Inc' }, { s: 'BKNG', n: 'Booking Holdings' },
  { s: 'HON', n: 'Honeywell International' }, { s: 'UBER', n: 'Uber Technologies' },
  { s: 'PFE', n: 'Pfizer Inc' }, { s: 'ISRG', n: 'Intuitive Surgical' }, { s: 'AXP', n: 'American Express Co' },
  { s: 'AMAT', n: 'Applied Materials' }, { s: 'BA', n: 'Boeing Co' }, { s: 'BX', n: 'Blackstone Inc' },
  { s: 'VRTX', n: 'Vertex Pharmaceuticals' }, { s: 'GILD', n: 'Gilead Sciences' },
  { s: 'DE', n: 'Deere & Co' }, { s: 'LRCX', n: 'Lam Research Corp' }, { s: 'MU', n: 'Micron Technology' },
  { s: 'ADI', n: 'Analog Devices Inc' }, { s: 'REGN', n: 'Regeneron Pharmaceuticals' },
  { s: 'PANW', n: 'Palo Alto Networks' }, { s: 'KLAC', n: 'KLA Corp' }, { s: 'SYK', n: 'Stryker Corp' },
  { s: 'ETN', n: 'Eaton Corp PLC' }, { s: 'BSX', n: 'Boston Scientific' }, { s: 'C', n: 'Citigroup Inc' },
  { s: 'BLK', n: 'BlackRock Inc' }, { s: 'ADP', n: 'Automatic Data Processing' },
  { s: 'SCHW', n: 'Charles Schwab Corp' }, { s: 'TJX', n: 'TJX Companies Inc' },
  { s: 'SBUX', n: 'Starbucks Corp' }, { s: 'TMUS', n: 'T-Mobile US Inc' },
  { s: 'CME', n: 'CME Group Inc' }, { s: 'EOG', n: 'EOG Resources Inc' }, { s: 'DUK', n: 'Duke Energy Corp' },
  { s: 'WM', n: 'Waste Management Inc' }, { s: 'MCO', n: "Moody's Corp" }, { s: 'USB', n: 'US Bancorp' },
  { s: 'INTC', n: 'Intel Corp' }, { s: 'MMM', n: '3M Co' }, { s: 'PYPL', n: 'PayPal Holdings' },
  { s: 'COIN', n: 'Coinbase Global Inc' }, { s: 'PLTR', n: 'Palantir Technologies' },
  { s: 'SNOW', n: 'Snowflake Inc' }, { s: 'DDOG', n: 'Datadog Inc' }, { s: 'CRWD', n: 'CrowdStrike Holdings' },
  { s: 'NET', n: 'Cloudflare Inc' }, { s: 'RBLX', n: 'Roblox Corp' }, { s: 'SHOP', n: 'Shopify Inc' },
  { s: 'SQ', n: 'Block Inc' }, { s: 'ROKU', n: 'Roku Inc' }, { s: 'HOOD', n: 'Robinhood Markets' },
  { s: 'RIVN', n: 'Rivian Automotive' }, { s: 'LCID', n: 'Lucid Group Inc' }, { s: 'NIO', n: 'NIO Inc' },
  { s: 'BABA', n: 'Alibaba Group' }, { s: 'JD', n: 'JD.com Inc' }, { s: 'PDD', n: 'PDD Holdings' },
  { s: 'MELI', n: 'MercadoLibre Inc' }, { s: 'SE', n: 'Sea Ltd' }, { s: 'SPOT', n: 'Spotify Technology' },
  { s: 'ARM', n: 'Arm Holdings PLC' }, { s: 'SMCI', n: 'Super Micro Computer' }, { s: 'MSTR', n: 'MicroStrategy' },
  { s: 'TSM', n: 'Taiwan Semiconductor' }, { s: 'ASML', n: 'ASML Holding NV' }, { s: 'TM', n: 'Toyota Motor' },
  { s: 'NVO', n: 'Novo Nordisk AS' }, { s: 'F', n: 'Ford Motor Co' }, { s: 'GM', n: 'General Motors Co' },
  { s: 'T', n: 'AT&T Inc' }, { s: 'VZ', n: 'Verizon Communications' }, { s: 'QCOM', n: 'Qualcomm Inc' },
  { s: 'TGT', n: 'Target Corp' }, { s: 'LOW', n: "Lowe's Companies" }, { s: 'NKE', n: 'Nike Inc' },
  { s: 'ABNB', n: 'Airbnb Inc' }, { s: 'LYFT', n: 'Lyft Inc' }, { s: 'DASH', n: 'DoorDash Inc' },
  { s: 'SNAP', n: 'Snap Inc' }, { s: 'PINS', n: 'Pinterest Inc' }, { s: 'ZM', n: 'Zoom Video' },
  { s: 'DOCU', n: 'DocuSign Inc' }, { s: 'PTON', n: 'Peloton Interactive' },
  { s: 'CVS', n: 'CVS Health Corp' }, { s: 'UNP', n: 'Union Pacific Corp' }, { s: 'CSX', n: 'CSX Corp' },
  { s: 'UPS', n: 'United Parcel Service' }, { s: 'FDX', n: 'FedEx Corp' },
  { s: 'LMT', n: 'Lockheed Martin' }, { s: 'NOC', n: 'Northrop Grumman' }, { s: 'GD', n: 'General Dynamics' },
  { s: 'NEE', n: 'NextEra Energy Inc' }, { s: 'D', n: 'Dominion Energy Inc' },
  { s: 'SPY', n: 'SPDR S&P 500 ETF' }, { s: 'QQQ', n: 'Invesco QQQ Trust' },
  { s: 'VTI', n: 'Vanguard Total Stock Market ETF' }, { s: 'IWM', n: 'iShares Russell 2000 ETF' },
  { s: 'VOO', n: 'Vanguard S&P 500 ETF' }, { s: 'VGT', n: 'Vanguard Info Technology ETF' },
  { s: 'XLK', n: 'Technology Select Sector SPDR' }, { s: 'XLF', n: 'Financial Select Sector SPDR' },
  { s: 'GLD', n: 'SPDR Gold Shares' }, { s: 'SLV', n: 'iShares Silver Trust' },
  { s: 'TLT', n: 'iShares 20+ Year Treasury Bond ETF' }, { s: 'ARKK', n: 'ARK Innovation ETF' },
  { s: 'SOXL', n: 'Direxion Semiconductor Bull 3X' }, { s: 'TQQQ', n: 'ProShares UltraPro QQQ' },
  { s: 'SQQQ', n: 'ProShares UltraPro Short QQQ' },
];

function localSearch(q) {
  const ql = q.toLowerCase();
  return STOCK_DB.filter(x => x.s.toLowerCase().startsWith(ql) || x.n.toLowerCase().includes(ql)).slice(0, 8);
}

function initTickerSearch() {
  const input = $('mTicker');
  const drop = $('tickerDropdown');
  input.addEventListener('input', () => {
    const q = input.value.trim(); dropdownActive = -1;
    if (q.length < 1) { closeDrop(); return; }
    const results = localSearch(q);
    if (!results.length) {
      drop.innerHTML = '<div class="ticker-searching">No match — type the ticker directly</div>';
      drop.classList.add('open'); return;
    }
    drop.innerHTML = results.map(x => `<div class="ticker-opt" data-sym="${escHtml(x.s)}"><span class="ticker-opt-sym">${escHtml(x.s)}</span><span class="ticker-opt-name">${escHtml(x.n)}</span></div>`).join('');
    drop.classList.add('open');
    drop.querySelectorAll('.ticker-opt').forEach(opt => {
      opt.addEventListener('click', () => {
        $('mTicker').value = opt.dataset.sym; closeDrop(); $('mShares').focus();
      });
    });
  });
  input.addEventListener('keydown', e => {
    const opts = drop.querySelectorAll('.ticker-opt'); if (!opts.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); dropdownActive = Math.min(dropdownActive + 1, opts.length - 1); opts.forEach((o, i) => o.classList.toggle('active', i === dropdownActive)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); dropdownActive = Math.max(dropdownActive - 1, 0); opts.forEach((o, i) => o.classList.toggle('active', i === dropdownActive)); }
    else if (e.key === 'Enter' && dropdownActive >= 0) { e.preventDefault(); opts[dropdownActive].click(); }
    else if (e.key === 'Escape') { closeDrop(); }
  });
  document.addEventListener('click', e => { if (!e.target.closest('.ticker-wrap')) closeDrop(); });
}
function closeDrop() {
  const d = $('tickerDropdown'); if (d) { d.classList.remove('open'); d.innerHTML = ''; }
  dropdownActive = -1;
}

/* ── Holdings / Accounts ── */
function openAddStock(acctId) {
  currentAccountId = acctId;
  ['mTicker', 'mShares', 'mCost'].forEach(id => $(id).value = '');
  $('modalError').textContent = '';
  closeDrop();
  $('stockModal').classList.add('open');
  if (!tickerSearchInit) { initTickerSearch(); tickerSearchInit = true; }
  setTimeout(() => $('mTicker').focus(), 50);
}
function closeModal() { $('stockModal').classList.remove('open'); }

async function saveHolding() {
  const ticker = $('mTicker').value.trim().toUpperCase().split(' ')[0];
  const shares = parseFloat($('mShares').value);
  const cost = parseFloat($('mCost').value) || null;
  const err = $('modalError');
  if (!ticker) { err.textContent = 'Enter a ticker symbol.'; return; }
  if (!shares || shares <= 0) { err.textContent = 'Enter a valid share count.'; return; }
  err.textContent = 'Fetching price...';
  const p = await fetchPrice(ticker);
  if (!p) { err.textContent = `Could not fetch price for "${ticker}". Check your connection or try again.`; return; }
  state.prices[ticker] = p;
  const acct = state.accounts.find(a => a.id === currentAccountId);
  const existing = acct.holdings.find(h => h.ticker === ticker);
  if (existing) {
    const newTotal = existing.shares + shares;
    if (cost && existing.costBasis) existing.costBasis = (existing.costBasis * existing.shares + cost * shares) / newTotal;
    existing.shares = newTotal;
  } else {
    acct.holdings.push({ ticker, shares, costBasis: cost });
  }
  takeSnapshot();
  saveState(); render(); closeModal();
  backfillHistory(currentAccountId).then(() => { saveState(); render(); });
}

function deleteHolding(acctId, idx) {
  state.accounts.find(a => a.id === acctId).holdings.splice(idx, 1);
  pruneHistory(); saveState(); render();
}
function deleteAccount(acctId) {
  if (!confirm('Remove this account and all holdings?')) return;
  state.accounts = state.accounts.filter(a => a.id !== acctId);
  if (state.history) delete state.history[acctId];
  saveState(); render();
}
function openAddAccount() {
  $('aName').value = '';
  $('accountError').textContent = '';
  $('accountModal').classList.add('open');
  setTimeout(() => $('aName').focus(), 50);
}
function closeAccountModal() { $('accountModal').classList.remove('open'); }
function saveAccount() {
  const name = $('aName').value.trim();
  if (!name) { $('accountError').textContent = 'Enter an account name.'; return; }
  state.accounts.push({ id: 'acct_' + Date.now(), name, holdings: [] });
  saveState(); render(); closeAccountModal();
}

function editAccountName(acctId, el) {
  const current = el.textContent;
  const input = document.createElement('input');
  input.className = 'account-name-input';
  input.value = current;
  el.replaceWith(input);
  input.focus();
  input.select();

  function commit() {
    const name = input.value.trim() || current;
    const acct = state.accounts.find(a => a.id === acctId);
    if (acct) acct.name = name;
    saveState(); render();
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = current; input.blur(); }
  });
}

/* ── Export / Import ── */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'futures-portfolio.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}
function importData(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const imported = JSON.parse(ev.target.result);
      if (!imported.accounts) { alert('Invalid file.'); return; }
      if (!confirm('This will replace all your current data. Continue?')) return;
      state = imported;
      if (!state.history) state.history = {};
      if (!state.prices) state.prices = {};
      saveState(); render(); refreshAll();
    } catch (e) { alert('Could not read file.'); }
  };
  reader.readAsText(file); e.target.value = '';
}

/* ── Event delegation ── */
document.addEventListener('click', e => {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const a = target.dataset.action;
  const acctId = target.dataset.acctId;
  const idx = target.dataset.idx;
  switch (a) {
    case 'refresh': refreshAll(); break;
    case 'add-account': openAddAccount(); break;
    case 'add-stock': openAddStock(acctId); break;
    case 'delete-account': deleteAccount(acctId); break;
    case 'delete-holding': deleteHolding(acctId, +idx); break;
    case 'rename-account': editAccountName(acctId, target); break;
    case 'pop-out': popOutChart(); break;
    case 'dock': dockChart(); break;
    case 'close-modal': closeModal(); break;
    case 'save-holding': saveHolding(); break;
    case 'close-account-modal': closeAccountModal(); break;
    case 'save-account': saveAccount(); break;
    case 'close-detail': closeDetail(); break;
    case 'export': exportData(); break;
    case 'import': $('importFile').click(); break;
    case 'toggle-settings': $('settingsOverlay').classList.toggle('open'); break;
    case 'close-settings': $('settingsOverlay').classList.remove('open'); break;
  }
});

/* Modal click-outside-to-close */
$('stockModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
$('accountModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeAccountModal(); });
$('importFile').addEventListener('change', importData);

/* ── Settings ── */
$('themeToggle').addEventListener('change', e => {
  const theme = e.target.checked ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(KEY_THEME, theme);
  renderMainChart();
});
const savedTheme = localStorage.getItem(KEY_THEME) || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);
if (savedTheme === 'light') $('themeToggle').checked = true;

const finnhubInput = $('finnhubKey');
if (finnhubInput) {
  finnhubInput.value = finnhubKey();
  finnhubInput.addEventListener('change', () => {
    const v = finnhubInput.value.trim();
    if (v) localStorage.setItem(KEY_FINNHUB, v);
    else localStorage.removeItem(KEY_FINNHUB);
  });
}

/* ── Refresh interval, visibility-aware ── */
function startRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (!document.hidden) refreshAll(); }, 60000);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }
  else { startRefreshTimer(); }
});

/* ── Init ── */
loadState();
render();
setupChartInteraction();
refreshAll();
startRefreshTimer();

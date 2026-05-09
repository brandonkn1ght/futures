/* ── Helpers ── */
const $ = id => document.getElementById(id);
const DPR = Math.min(window.devicePixelRatio || 1, 2);
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => n == null ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtChg = n => n == null ? '' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

const KEY_STATE = 'bk_ptstate';
const KEY_THEME = 'bk_theme';
const KEY_FINNHUB = 'bk_finnhub_key';
const finnhubKey = () => localStorage.getItem(KEY_FINNHUB) || '';

/* ── State ── */
let state = { accounts: [], prices: {}, history: {}, lastUpdated: null };
let currentAccountId = null;
let chartDots = [];
let dropdownActive = -1;
let tickerSearchInit = false;
let refreshTimer = null;
let resizeRaf = 0;
let searchTimer = 0;

function loadState() {
  try { const s = localStorage.getItem(KEY_STATE); if (s) state = JSON.parse(s); } catch (e) {}
  if (!state.accounts || !state.accounts.length) {
    state = {
      accounts: [
        { id: 'acct1', name: 'Main Brokerage', holdings: [] },
        { id: 'acct2', name: 'Roth IRA', holdings: [] }
      ], prices: {}, history: {}, lastUpdated: null
    };
  }
  if (!state.history) state.history = {};
  if (!state.prices) state.prices = {};
}
const saveState = () => { try { localStorage.setItem(KEY_STATE, JSON.stringify(state)); } catch (e) {} };

/* ── Finnhub ── */
async function fetchPrice(ticker) {
  const key = finnhubKey();
  if (!key) return null;
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(key)}`);
    if (!r.ok) return null;
    const d = await r.json();
    if (!d?.c) return null;
    return { price: d.c, chgPct: d.pc ? ((d.c - d.pc) / d.pc) * 100 : null };
  } catch { return null; }
}

async function fetchHistoricalPrices(ticker) {
  const key = finnhubKey();
  if (!key) return null;
  const to = Math.floor(Date.now() / 1000);
  const from = to - (31 * 24 * 60 * 60);
  try {
    const r = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(ticker)}&resolution=D&from=${from}&to=${to}&token=${encodeURIComponent(key)}`);
    if (!r.ok) return null;
    const d = await r.json();
    if (d.s !== 'ok' || !d.c?.length) return null;
    const out = {};
    d.t.forEach((ts, i) => { if (d.c[i] != null) out[new Date(ts * 1000).toISOString().split('T')[0]] = d.c[i]; });
    return Object.keys(out).length > 1 ? out : null;
  } catch { return null; }
}

const searchStocks = async q => {
  const key = finnhubKey();
  if (!key || !q) return [];
  try {
    const r = await fetch(`https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${encodeURIComponent(key)}`);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.result || []).slice(0, 8);
  } catch { return []; }
};

async function refreshAll() {
  if (!finnhubKey()) return;
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
    Promise.all(acctsWith.map(a => backfillHistory(a.id))).then(() => { saveState(); render(); });
  }
}

/* ── Render ── */
function render() {
  const list = $('accountsList');
  let totalVal = 0, totalDayGain = 0, totalPos = 0, hasPrices = false;

  list.innerHTML = state.accounts.map(acct => {
    let acctVal = 0;
    const aid = escHtml(acct.id);
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
        <td class="r"><button class="del-row" data-action="delete-holding" data-acct-id="${aid}" data-idx="${hi}">×</button></td>
      </tr>`;
    }).join('');
    totalVal += acctVal;
    return `<div class="account-card">
      <div class="account-header">
        <div class="account-name-wrap"><div class="account-dot"></div><span class="account-name" data-action="rename-account" data-acct-id="${aid}" title="Click to rename">${escHtml(acct.name)}</span></div>
        <div class="account-header-right">
          <span class="account-total">${acctVal ? fmt(acctVal) : '—'}</span>
          <div class="account-actions">
            <button class="btn-small" data-action="add-stock" data-acct-id="${aid}">+ Add</button>
            <button class="btn-small danger" data-action="delete-account" data-acct-id="${aid}">Remove</button>
          </div>
        </div>
      </div>
      ${acct.holdings.length
        ? `<div class="table-wrap"><table class="holdings-table">
            <thead><tr><th>Ticker</th><th class="r">Shares</th><th class="r">Price</th><th class="r">Value</th><th class="r col-cost">Avg buy price</th><th class="r"></th></tr></thead>
            <tbody>${rows}</tbody></table></div>`
        : `<div class="empty">No holdings — click + Add to get started.</div>`}
    </div>`;
  }).join('');

  $('totalVal').textContent = hasPrices ? fmt(totalVal) : '—';
  const dg = $('dayGain');
  if (hasPrices) {
    dg.textContent = (totalDayGain >= 0 ? '+' : '') + fmt(totalDayGain);
    dg.className = 'metric-value ' + (totalDayGain >= 0 ? 'pos' : 'neg');
  } else { dg.textContent = '—'; dg.className = 'metric-value'; }
  $('acctCount').textContent = state.accounts.length;
  $('posCount').textContent = totalPos;
  if (state.lastUpdated) $('lastUpdated').textContent = 'Updated ' + state.lastUpdated;

  renderMainChart();
}

/* ── History ── */
async function backfillHistory(acctId) {
  const acct = state.accounts.find(a => a.id === acctId);
  if (!acct?.holdings.length) return;
  const histMap = {};
  for (const h of acct.holdings) {
    const prices = await fetchHistoricalPrices(h.ticker);
    if (prices) histMap[h.ticker] = { prices, shares: h.shares };
  }
  if (!Object.keys(histMap).length) return;
  const allDates = new Set();
  Object.values(histMap).forEach(({ prices }) => Object.keys(prices).forEach(d => allDates.add(d)));
  if (!state.history[acctId]) state.history[acctId] = [];
  const existing = new Set(state.history[acctId].map(s => s.date));
  [...allDates].sort().forEach(date => {
    if (existing.has(date)) return;
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
  const active = new Set(state.accounts.filter(a => a.holdings.length).map(a => a.id));
  Object.keys(state.history).forEach(id => { if (!active.has(id)) delete state.history[id]; });
}

function takeSnapshot() {
  const today = new Date().toISOString().split('T')[0];
  state.accounts.forEach(acct => {
    if (!state.history[acct.id]) state.history[acct.id] = [];
    let val = 0, hasPrice = false;
    acct.holdings.forEach(h => {
      const p = state.prices[h.ticker];
      if (p?.price) { val += p.price * h.shares; hasPrice = true; }
    });
    if (!hasPrice || val === 0) return;
    const ex = state.history[acct.id].find(s => s.date === today);
    if (ex) { ex.value = val; }
    else {
      state.history[acct.id].push({ date: today, value: val });
      state.history[acct.id].sort((a, b) => a.date.localeCompare(b.date));
      if (state.history[acct.id].length > 90) state.history[acct.id].shift();
    }
  });
}

/* ── Chart ── */
const ACCT_COLORS = ['#FDD023', '#6a3dab', '#4ade80', '#60a5fa', '#f87171', '#fb923c'];
const acctColor = i => ACCT_COLORS[i % ACCT_COLORS.length];

function renderMainChart() {
  const canvas = $('mainChart'), wrap = $('chartCanvasWrap'), empty = $('chartEmpty');
  if (!canvas || !wrap) return;
  renderLegend();

  const dates = [...new Set(Object.values(state.history).flatMap(h => h.map(s => s.date)))].sort();
  const hasHistory = dates.length && state.accounts.some(a => state.history[a.id]?.length);
  if (!hasHistory) { canvas.style.display = 'none'; empty.style.display = 'block'; return; }
  canvas.style.display = 'block'; empty.style.display = 'none';

  const W = wrap.clientWidth, H = wrap.clientHeight - 8;
  if (!W || H < 60) return;
  canvas.width = W * DPR; canvas.height = H * DPR;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d'); ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const PAD = { top: 12, right: 10, bottom: 26, left: 54 };
  const cW = W - PAD.left - PAD.right, cH = H - PAD.top - PAD.bottom;
  const dateIdx = new Map(dates.map((d, i) => [d, i]));

  let minV = Infinity, maxV = -Infinity;
  state.accounts.forEach(a => (state.history[a.id] || []).forEach(s => {
    if (s.value < minV) minV = s.value;
    if (s.value > maxV) maxV = s.value;
  }));
  if (!isFinite(minV)) return;
  const sp = maxV - minV || maxV * 0.1 || 1000;
  minV -= sp * 0.12; maxV += sp * 0.12;

  const toX = i => PAD.left + (dates.length === 1 ? cW / 2 : (i / (dates.length - 1)) * cW);
  const toY = v => PAD.top + cH - ((v - minV) / (maxV - minV)) * cH;
  const gridC = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.05)';
  const labelC = isDark ? '#444' : '#bbb';

  for (let i = 0; i <= 3; i++) {
    const v = minV + (maxV - minV) * (i / 3), y = toY(v);
    ctx.strokeStyle = gridC; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cW, y); ctx.stroke();
    ctx.fillStyle = labelC; ctx.font = '9px Courier New, monospace'; ctx.textAlign = 'right';
    ctx.fillText(v >= 1000 ? '$' + (v / 1000).toFixed(0) + 'k' : '$' + Math.round(v), PAD.left - 4, y + 3);
  }
  ctx.fillStyle = labelC; ctx.font = '9px Georgia, serif'; ctx.textAlign = 'center';
  const iv = Math.max(1, Math.floor(dates.length / 4));
  dates.forEach((d, i) => { if (i % iv !== 0 && i !== dates.length - 1) return; ctx.fillText(d.slice(5), toX(i), H - 5); });

  chartDots = [];
  state.accounts.forEach((acct, ai) => {
    const hist = state.history[acct.id] || [];
    if (!hist.length) return;
    const color = acctColor(ai);
    ctx.save(); ctx.beginPath();
    hist.forEach((s, si) => {
      const x = toX(dateIdx.get(s.date)), y = toY(s.value);
      si === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.lineTo(toX(dateIdx.get(hist[hist.length - 1].date)), toY(minV));
    ctx.lineTo(toX(dateIdx.get(hist[0].date)), toY(minV));
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
      chartDots.push({ x, y, acctName: acct.name, date: s.date, value: s.value, color });
    });
  });
}

function renderLegend() {
  $('chartLegend').innerHTML = state.accounts.filter(a => a.holdings.length).map(a => {
    const c = acctColor(state.accounts.indexOf(a));
    return `<div class="legend-item"><div class="legend-dot" style="background:${c}"></div><span style="color:${c}">${escHtml(a.name)}</span></div>`;
  }).join('');
}

function setupChartInteraction() {
  const canvas = $('mainChart'), tooltip = $('chartTooltip');
  if (!canvas || !tooltip || canvas._wired) return;
  canvas._wired = true;
  canvas.addEventListener('mousemove', e => {
    const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = 18;
    chartDots.forEach(d => { const dist = Math.hypot(d.x - mx, d.y - my); if (dist < bd) { bd = dist; best = d; } });
    if (best) {
      canvas.style.cursor = 'pointer'; tooltip.style.display = 'block';
      tooltip.style.left = (best.x + 10) + 'px'; tooltip.style.top = Math.max(0, best.y - 44) + 'px';
      tooltip.innerHTML = `<span style="color:${best.color}">${escHtml(best.acctName)}</span><br>${best.date}<br>${fmt(best.value)}`;
    } else { canvas.style.cursor = 'default'; tooltip.style.display = 'none'; }
  });
  canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
}

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; renderMainChart(); });
  }).observe($('chartCanvasWrap'));
}

/* ── Ticker autocomplete (Finnhub /search) ── */
function initTickerSearch() {
  const input = $('mTicker'), drop = $('tickerDropdown');
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) return closeDrop();
    searchTimer = setTimeout(async () => {
      const results = await searchStocks(q);
      dropdownActive = -1;
      if (!results.length) {
        drop.innerHTML = '<div class="ticker-searching">No match — type the ticker directly</div>';
        drop.classList.add('open'); return;
      }
      drop.innerHTML = results.map(x => `<div class="ticker-opt" data-sym="${escHtml(x.symbol)}"><span class="ticker-opt-sym">${escHtml(x.displaySymbol || x.symbol)}</span><span class="ticker-opt-name">${escHtml(x.description)}</span></div>`).join('');
      drop.classList.add('open');
      drop.querySelectorAll('.ticker-opt').forEach(opt => {
        opt.addEventListener('click', () => {
          input.value = opt.dataset.sym; closeDrop(); $('mShares').focus();
        });
      });
    }, 200);
  });
  input.addEventListener('keydown', e => {
    const opts = drop.querySelectorAll('.ticker-opt');
    if (!opts.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); dropdownActive = Math.min(dropdownActive + 1, opts.length - 1); opts.forEach((o, i) => o.classList.toggle('active', i === dropdownActive)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); dropdownActive = Math.max(dropdownActive - 1, 0); opts.forEach((o, i) => o.classList.toggle('active', i === dropdownActive)); }
    else if (e.key === 'Enter' && dropdownActive >= 0) { e.preventDefault(); opts[dropdownActive].click(); }
    else if (e.key === 'Escape') closeDrop();
  });
  document.addEventListener('click', e => { if (!e.target.closest('.ticker-wrap')) closeDrop(); });
}
const closeDrop = () => { const d = $('tickerDropdown'); if (d) { d.classList.remove('open'); d.innerHTML = ''; } dropdownActive = -1; };

/* ── CRUD ── */
function openAddStock(acctId) {
  currentAccountId = acctId;
  ['mTicker', 'mShares', 'mCost'].forEach(id => $(id).value = '');
  $('modalError').textContent = '';
  closeDrop();
  $('stockModal').classList.add('open');
  if (!tickerSearchInit) { initTickerSearch(); tickerSearchInit = true; }
  setTimeout(() => $('mTicker').focus(), 50);
}
const closeModal = () => $('stockModal').classList.remove('open');

async function saveHolding() {
  const ticker = $('mTicker').value.trim().toUpperCase().split(' ')[0];
  const shares = parseFloat($('mShares').value);
  const cost = parseFloat($('mCost').value) || null;
  const err = $('modalError');
  if (!ticker) { err.textContent = 'Enter a ticker symbol.'; return; }
  if (!shares || shares <= 0) { err.textContent = 'Enter a valid share count.'; return; }
  if (!finnhubKey()) { err.textContent = 'Add your Finnhub key in Settings first.'; return; }
  err.textContent = 'Fetching price...';
  const p = await fetchPrice(ticker);
  if (!p) { err.textContent = `Could not fetch price for "${ticker}".`; return; }
  state.prices[ticker] = p;
  const acct = state.accounts.find(a => a.id === currentAccountId);
  const ex = acct.holdings.find(h => h.ticker === ticker);
  if (ex) {
    const total = ex.shares + shares;
    if (cost && ex.costBasis) ex.costBasis = (ex.costBasis * ex.shares + cost * shares) / total;
    ex.shares = total;
  } else { acct.holdings.push({ ticker, shares, costBasis: cost }); }
  takeSnapshot(); saveState(); render(); closeModal();
  backfillHistory(currentAccountId).then(() => { saveState(); render(); });
}

function deleteHolding(acctId, idx) {
  state.accounts.find(a => a.id === acctId).holdings.splice(idx, 1);
  pruneHistory(); saveState(); render();
}
function deleteAccount(acctId) {
  if (!confirm('Remove this account and all holdings?')) return;
  state.accounts = state.accounts.filter(a => a.id !== acctId);
  delete state.history[acctId];
  saveState(); render();
}
function renameAccount(acctId) {
  const acct = state.accounts.find(a => a.id === acctId);
  if (!acct) return;
  const name = prompt('Rename account:', acct.name);
  if (name?.trim()) { acct.name = name.trim(); saveState(); render(); }
}
function openAddAccount() {
  $('aName').value = ''; $('accountError').textContent = '';
  $('accountModal').classList.add('open');
  setTimeout(() => $('aName').focus(), 50);
}
const closeAccountModal = () => $('accountModal').classList.remove('open');
function saveAccount() {
  const name = $('aName').value.trim();
  if (!name) { $('accountError').textContent = 'Enter an account name.'; return; }
  state.accounts.push({ id: 'acct_' + Date.now(), name, holdings: [] });
  saveState(); render(); closeAccountModal();
}

/* ── Export / Import ── */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'futures-portfolio.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}
function importData(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const imp = JSON.parse(ev.target.result);
      if (!imp.accounts) return alert('Invalid file.');
      if (!confirm('This will replace all your current data. Continue?')) return;
      state = imp;
      if (!state.history) state.history = {};
      if (!state.prices) state.prices = {};
      saveState(); render(); refreshAll();
    } catch { alert('Could not read file.'); }
  };
  reader.readAsText(file); e.target.value = '';
}

/* ── Event delegation ── */
const ACTIONS = {
  'refresh': () => refreshAll(),
  'add-account': openAddAccount,
  'add-stock': (_, t) => openAddStock(t.dataset.acctId),
  'delete-account': (_, t) => deleteAccount(t.dataset.acctId),
  'delete-holding': (_, t) => deleteHolding(t.dataset.acctId, +t.dataset.idx),
  'rename-account': (_, t) => renameAccount(t.dataset.acctId),
  'close-modal': closeModal,
  'save-holding': saveHolding,
  'close-account-modal': closeAccountModal,
  'save-account': saveAccount,
  'export': exportData,
  'import': () => $('importFile').click(),
  'toggle-settings': () => $('settingsOverlay').classList.toggle('open'),
  'close-settings': () => $('settingsOverlay').classList.remove('open'),
};
document.addEventListener('click', e => {
  const t = e.target.closest('[data-action]');
  if (t && ACTIONS[t.dataset.action]) ACTIONS[t.dataset.action](e, t);
});
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

const fk = $('finnhubKey');
fk.value = finnhubKey();
fk.addEventListener('change', () => {
  const v = fk.value.trim();
  if (v) localStorage.setItem(KEY_FINNHUB, v); else localStorage.removeItem(KEY_FINNHUB);
});

/* ── Refresh interval ── */
function startRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (!document.hidden) refreshAll(); }, 60000);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }
  else startRefreshTimer();
});

/* ── Init ── */
loadState();
render();
setupChartInteraction();
refreshAll();
startRefreshTimer();

// Lapisan UI. Semua data melalui js/store.js — fail ini tidak menyentuh storan kewangan secara langsung.
import * as store from './js/store.js';
import * as sync from './js/sync.js';
import { exportBackup, parseBackup, downloadText } from './js/backup.js';
import { fmt, toSen, senToInput, esc, debounce, fromLegacy, APP_VERSION } from './js/utils.js';
import { t, loadLang, setLang, getLang, applyI18n, fmtDate, fmtDateTimeL, monthYear, monthName, catLabel, CATEGORIES } from './js/i18n.js';

const $ = id => document.getElementById(id);
const ALL = '__all';
const ui = { filter: ALL, query: '', sort: 'added', editing: null, seen: null, pulse: null, replay: false, month: 0, h: { q: '', kind: 'all', sort: 'new' } };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const prefGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const prefSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* tiada storan */ } };
const getName = () => (prefGet('rb-name') ?? 'Amzar').trim() || 'Amzar';

// Nombor "naik" ke nilai baharu (render pertama terus; hormati prefers-reduced-motion).
function tween(el, to, f = fmt) {
  cancelAnimationFrame(el._raf);
  const from = ui.replay ? 0 : (el._v ?? to);
  el._v = to;
  if (from === to || reduceMotion.matches) { el.textContent = f(to); return; }
  const t0 = performance.now(), dur = 600;
  const step = now => {
    const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    el.textContent = p < 1 ? f(from + (to - from) * e) : f(to);
    if (p < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}
const sum = list => list.reduce((s, e) => s + e.amountSen, 0);
const setVal = (el, v) => { if (document.activeElement !== el) el.value = v; };
const commute = () => ({ ...store.DEFAULTS.commute, ...(store.getSetting('commute') || {}) });
const clamp01 = n => Math.max(0, Math.min(1, n));
const setP = (el, r) => el.style.setProperty('--p', clamp01(r));
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();

// ---------- Tema ----------
const THEME_BG = { light: '#F3F0E8', dark: '#181A18' };
const sysDark = matchMedia('(prefers-color-scheme: dark)');
function applyTheme(pref = prefGet('rb-theme') || 'system') {
  if (!['light', 'dark', 'system'].includes(pref)) pref = 'system';
  const eff = pref === 'system' ? (sysDark.matches ? 'dark' : 'light') : pref;
  const h = document.documentElement;
  h.dataset.theme = eff; h.dataset.themePref = pref;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', THEME_BG[eff]);
  document.querySelectorAll('#theme-seg [data-theme-pref]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.themePref === pref)));
}
sysDark.addEventListener?.('change', () => { if ((prefGet('rb-theme') || 'system') === 'system') applyTheme(); });
$('theme-seg').onclick = e => { const b = e.target.closest('[data-theme-pref]'); if (b) { prefSet('rb-theme', b.dataset.themePref); applyTheme(b.dataset.themePref); } };
$('lang-seg').onclick = e => { const b = e.target.closest('[data-lang]'); if (b && b.dataset.lang !== getLang()) setLang(b.dataset.lang).then(() => toast(t('toast.langChanged'), { kind: 'ok', ms: 2000 })); };
document.addEventListener('langchange', () => { fillCategorySelect(); setupSelects(); render(); renderStatus(); showBanner(); $('footer-note').textContent = t('footer.note'); markLang(); });
function markLang() { document.querySelectorAll('#lang-seg [data-lang]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.lang === getLang()))); }
$('display-name').value = getName();
$('display-name').oninput = e => { prefSet('rb-name', e.target.value); renderHome(store.liveExpenses()); };

// ---------- Toast & dialog ----------
function toast(msg, { action, kind = 'info', ms = 4500 } = {}) {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.innerHTML = `<span>${esc(msg)}</span>`;
  const close = () => el.remove();
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = action.label;
    b.onclick = () => { close(); action.fn(); };
    el.appendChild(b);
  }
  $('toasts').appendChild(el);
  setTimeout(close, action ? 7000 : ms);
}
const fail = e => toast(t('err.saveFail', { msg: e?.message || t('err.unknown') }), { kind: 'error', ms: 7000 });
const guard = p => p.catch(fail);

let dialogResolve = null;
function ask({ title, body = '', eyebrow = t('dlg.confirm'), actions }) {
  $('dialog-title').textContent = title;
  $('dialog-eyebrow').textContent = eyebrow;
  $('dialog-body').innerHTML = body;
  $('dialog-actions').innerHTML = actions.map((a, i) => `<button type="button" class="${a.kind || 'secondary-btn'}" data-i="${i}">${esc(a.label)}</button>`).join('');
  $('dialog').classList.add('open');
  $('dialog-actions').querySelector('button:last-child').focus();
  return new Promise(res => {
    dialogResolve = v => { $('dialog').classList.remove('open'); dialogResolve = null; res(v); };
    $('dialog-actions').onclick = e => { const b = e.target.closest('button'); if (b) dialogResolve(actions[+b.dataset.i].value); };
  });
}
$('dialog').onclick = e => { if (e.target.id === 'dialog' && dialogResolve) dialogResolve(null); };
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (dialogResolve) dialogResolve(null); else closeModal();
});

// ---------- Status simpan ----------
function computeStatus() {
  const L = store.state.local, S = sync.status, pending = store.state.pending.size;
  if (!store.state.ready) return ['load', t('status.loading')];
  if (!store.state.storageOk) return ['err', t('status.noStorage')];
  if (L.state === 'saving') return ['busy', t('status.saving')];
  if (L.state === 'error') return ['err', t('status.saveFailed'), L.retry];
  if (!navigator.onLine) return ['warn', t('status.offline')];
  if (S.phase === 'syncing') return ['busy', t('status.syncing')];
  if (S.phase === 'error') return ['err', t('status.syncFailed'), sync.syncNow];
  if (pending) return ['warn', t('status.pending')];
  if (S.phase === 'idle') return ['ok', t('status.saved')];
  return ['ok', t('status.savedLocal')];
}
let retryFn = null;
function renderStatus() {
  const [kind, text, retry] = computeStatus();
  $('status-chip').dataset.kind = kind;
  $('saved-status').textContent = text;
  retryFn = retry || null;
  $('status-retry').hidden = !retryFn;
}
$('status-retry').onclick = () => retryFn && Promise.resolve(retryFn()).catch(fail);

// ---------- Aktiviti (daripada rekod sebenar) ----------
function activity() {
  const out = [];
  for (const e of store.state.expenses.values()) {
    const created = Date.parse(e.createdAt), upd = Date.parse(e.updatedAt);
    const kind = e.deleted ? 'deleted' : Math.abs(upd - created) <= 1500 ? 'added' : 'updated';
    out.push({ id: e.id, name: e.name, category: e.category, amountSen: e.amountSen, kind, at: e.updatedAt });
  }
  return out;
}

// ---------- Render ----------
function render() {
  if (!store.state.ready) return;
  const list = store.liveExpenses();
  renderHome(list);
  renderRoutine(list);
  renderExpenses(list);
  renderTimeline(list);
  renderHistory();
  renderStatus();
  renderSettings();
}

function renderHome(list) {
  const income = store.getSetting('incomeSen'), target = store.getSetting('targetSen');
  const total = sum(list), bal = income - total;
  const unpaid = list.filter(e => !e.paid);
  const pct = income > 0 ? bal / income * 100 : 0;
  const now = new Date();
  $('hero-eyebrow').textContent = t('home.eyebrow', { month: monthYear(now) });
  $('greeting').innerHTML = t('home.greeting', { name: esc(getName()) });

  tween($('balance'), bal);
  tween($('income-display'), income);
  tween($('expenses-display'), total);
  tween($('target-display'), target);
  tween($('unpaid-display'), sum(unpaid));
  $('balance-note').textContent = t('home.pctIncome', { pct: pct.toFixed(1) });
  setP($('balance-bar'), pct / 100);
  $('balance-progress').setAttribute('aria-valuenow', String(Math.round(clamp01(pct / 100) * 100)));
  $('target-note').textContent = t('home.afterSavings', { amt: fmt(bal - target) });
  $('expense-count').textContent = t('home.activeItems', { n: list.length });
  $('unpaid-count').textContent = t('home.unpaidItems', { n: unpaid.length });

  renderHealth(list, income, total, bal);
  renderBreakdown(list, total);
  renderUpcoming(list, now);
  renderSavings(target, bal);
  renderRecent();
}

function renderHealth(list, income, total, bal) {
  const savingsRatio = income > 0 ? Math.max(0, bal / income) : 0;
  const burdenRatio = income > 0 ? Math.min(1, total / income) : 0;
  const unpaidN = list.filter(e => !e.paid).length;
  const paidRatio = list.length ? (list.length - unpaidN) / list.length : 0;
  const score = Math.min(100, Math.round(savingsRatio * 40) + Math.round((1 - burdenRatio) * 40) + Math.round(paidRatio * 20));
  const hasData = income > 0 || list.length > 0;
  const grade = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';
  const arc = $('health-arc');
  arc.style.strokeDashoffset = 251.2 - (hasData ? score : 0) / 100 * 251.2;
  arc.style.stroke = `var(--${score >= 80 ? 'positive' : score >= 60 ? 'warn' : score >= 40 ? 'accent' : 'danger'})`;
  if (hasData) tween($('health-score'), score, v => String(Math.round(v))); else { $('health-score')._v = 0; $('health-score').textContent = '–'; }
  const badge = $('health-grade-badge');
  badge.textContent = hasData ? grade : '–';
  badge.className = `health-grade ${hasData ? grade : 'none'}`;
  const bar = (id, ratio) => { setP($(id), ratio); $(`${id}-val`).textContent = `${Math.round(ratio * 100)}%`; };
  bar('hb-savings', savingsRatio); bar('hb-burden', burdenRatio); bar('hb-paid', paidRatio);

  const tips = [], p = r => Math.round(r * 100);
  if (!hasData) tips.push(['○', 'noData', {}]);
  else {
    if (savingsRatio < 0.1) tips.push(['💸', 'low', { pct: p(savingsRatio) }]);
    else if (savingsRatio >= 0.2) tips.push(['✦', 'good', { pct: p(savingsRatio) }]);
    if (burdenRatio > 0.7) tips.push(['⚠', 'high', { pct: p(burdenRatio) }]);
    if (paidRatio < 0.5 && list.length) tips.push(['○', 'unsettled', { n: unpaidN }]);
    else if (paidRatio === 1) tips.push(['✓', 'allSettled', { n: list.length }]);
    if (!tips.length) tips.push(['◆', 'solid', { score }]);
  }
  $('health-tips').innerHTML = tips.slice(0, 3).map(([icon, k, prm]) => `<div class="health-tip"><span aria-hidden="true">${icon}</span><p><b>${esc(t(`health.${k}.t`))}</b> — ${t(`health.${k}.m`, prm)}</p></div>`).join('');
}

function renderBreakdown(list, total) {
  const el = $('breakdown');
  if (!list.length || total <= 0) { el.innerHTML = `<p class="muted">${esc(t('breakdown.empty'))}</p>`; return; }
  const by = {};
  list.forEach(e => { by[e.category] = (by[e.category] || 0) + e.amountSen; });
  const rows = Object.entries(by).sort((a, b) => b[1] - a[1]);
  const col = i => `var(--c${(i % 6) + 1})`;
  el.innerHTML = `<div class="stack" role="img" aria-label="${esc(t('breakdown.title'))}">${rows.map(([c, v], i) => `<i style="flex:${v};background:${col(i)};animation-delay:${i * 60}ms" title="${esc(catLabel(c))}"></i>`).join('')}</div>
    <ul class="legend">${rows.map(([c, v], i) => `<li><span class="dot" style="background:${col(i)}"></span><span class="nm">${esc(catLabel(c))}</span><b>${fmt(v)}</b><span class="pct">${Math.round(v / total * 100)}%</span></li>`).join('')}</ul>`;
}

const dueDateIn = (y, m, day) => new Date(y, m, Math.min(day, daysIn(y, m)));
function renderUpcoming(list, now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const items = list.filter(e => e.dueDay && !e.paid).map(e => ({ e, d: dueDateIn(today.getFullYear(), today.getMonth(), e.dueDay) }))
    .map(x => ({ ...x, diff: Math.round((x.d - today) / 864e5) })).sort((a, b) => a.diff - b.diff).slice(0, 5);
  $('upcoming-list').innerHTML = items.length ? items.map(({ e, d, diff }) => {
    const rel = diff < 0 ? t('sched.late', { n: -diff }) : diff === 0 ? t('sched.today') : diff === 1 ? t('sched.tomorrow') : t('sched.inDays', { n: diff });
    return `<li class="${diff < 0 ? 'od' : ''}"><span class="t">${esc(e.name)}</span><span class="s">${esc(fmtDate(d))} · ${esc(rel)}</span><span class="v">${fmt(e.amountSen)}</span></li>`;
  }).join('') : `<li><span class="empty">${esc(t('upcoming.empty'))}</span></li>`;
}

function renderSavings(target, bal) {
  const el = $('savings-body');
  if (target <= 0) { el.innerHTML = `<p class="muted">${esc(t('savings.set'))}</p>`; return; }
  const covered = clamp01(Math.max(0, bal) / target), remain = Math.max(0, target - Math.max(0, bal));
  el.innerHTML = `<div class="sv-fig">${Math.round(covered * 100)}%</div><div class="sv-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(covered * 100)}"><i style="--p:${covered}"></i></div>
    <div class="sv-rows"><div><span>${esc(t('savings.target'))}</span><b>${fmt(target)}</b></div><div><span>${esc(t('savings.balance'))}</span><b>${fmt(bal)}</b></div><div><span>${esc(remain ? t('savings.remaining') : t('savings.reached'))}</span><b>${remain ? fmt(remain) : '✓'}</b></div></div>`;
}

function renderRecent() {
  const rows = activity().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5);
  $('recent-list').innerHTML = rows.length ? rows.map(a => `<li><span class="t">${esc(a.name)}</span><span class="s">${esc(t(`act.${a.kind}`))} · ${esc(fmtDateTimeL(a.at))}</span><span class="v">${fmt(a.amountSen)}</span></li>`).join('')
    : `<li><span class="empty">${esc(t('recent.empty'))}</span></li>`;
}

// ---------- Rutin ----------
function renderRoutine(list) {
  const income = store.getSetting('incomeSen'), target = store.getSetting('targetSen'), bal = income - sum(list);
  const c = commute();
  setVal($('income-input'), senToInput(income)); setVal($('savings-target'), senToInput(target));
  setVal($('distance'), c.distance || ''); setVal($('days'), c.days || '');
  setVal($('efficiency'), c.efficiency || ''); setVal($('fuel-price'), senToInput(c.fuelPriceSen));
  $('round-trip').checked = !!c.roundTrip;
  const km = c.distance * (c.roundTrip ? 2 : 1);
  const daily = c.efficiency > 0 ? km / c.efficiency * c.fuelPriceSen : 0;
  $('commute-daily').textContent = fmt(Math.round(daily));
  $('commute-total').textContent = fmt(Math.round(daily * c.days));
  $('commute-roundel').innerHTML = `AXIA<br>${esc(c.distance || 0)}KM`;
  $('target-percent').textContent = `${bal > 0 ? Math.round(target / bal * 100) : 0}%`;

  const today = new Date(), t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const nextOf = day => { let d = dueDateIn(t0.getFullYear(), t0.getMonth(), day); if (d < t0) d = dueDateIn(t0.getFullYear(), t0.getMonth() + 1, day); return d; };
  const rows = [...list].sort((a, b) => (a.dueDay ?? 99) - (b.dueDay ?? 99));
  $('recurring-list').innerHTML = rows.length ? rows.map(e => `<li><span class="t">${esc(e.name)}</span>
    <span class="s">${esc(catLabel(e.category))} · ${esc(t('routine.freq'))} · ${e.dueDay ? esc(t('routine.next', { date: fmtDate(nextOf(e.dueDay)) })) : esc(t('routine.noDay'))}</span>
    <span class="v">${fmt(e.amountSen)}</span>
    <span class="ac"><span class="pill ${e.paid ? 'ok' : 'warn'}">${esc(e.paid ? t('commit.paid') : t('commit.unpaid'))}</span><button type="button" data-act="edit" data-id="${e.id}">${esc(t('common.edit'))}</button><button type="button" data-act="delete" data-id="${e.id}">${esc(t('common.delete'))}</button></span></li>`).join('')
    : `<li><span class="empty muted">${esc(t('routine.noRec'))}</span></li>`;
}

// ---------- Komitmen ----------
function renderExpenses(list) {
  const total = sum(list), unpaid = list.filter(e => !e.paid), bal = store.getSetting('incomeSen') - total;
  $('paid-count').textContent = list.length ? t('commit.paidCount', { paid: list.length - unpaid.length, total: list.length }) : ' ';
  const cats = [ALL, ...new Set(list.map(e => e.category))];
  if (!cats.includes(ui.filter)) ui.filter = ALL;
  $('category-summary').innerHTML = cats.map(cat =>
    `<button type="button" class="category-pill ${cat === ui.filter ? 'active' : ''}" aria-pressed="${cat === ui.filter}" data-cat="${esc(cat)}">${esc(cat === ALL ? t('cat.all') : catLabel(cat) + ' ' + fmt(sum(list.filter(e => e.category === cat))))}</button>`).join('');

  const q = ui.query.trim().toLowerCase();
  let rows = list.filter(e => (ui.filter === ALL || e.category === ui.filter) && (!q || e.name.toLowerCase().includes(q) || catLabel(e.category).toLowerCase().includes(q)));
  const sorters = {
    due: (a, b) => (a.dueDay ?? 99) - (b.dueDay ?? 99), amount: (a, b) => b.amountSen - a.amountSen,
    name: (a, b) => a.name.localeCompare(b.name, getLang()), unpaid: (a, b) => a.paid - b.paid || (a.dueDay ?? 99) - (b.dueDay ?? 99),
  };
  if (sorters[ui.sort]) rows = [...rows].sort(sorters[ui.sort]);

  const seen = ui.seen;
  $('expense-list').innerHTML = rows.map((e, i) => `<div class="expense-row${e.paid ? ' paid' : ''}${seen && !seen.has(e.id) ? ' row-new' : ''}${ui.pulse === e.id ? ' pulse' : ''}" style="--i:${Math.min(i, 12)}">
    <button type="button" class="tick-btn" data-act="tick" data-id="${e.id}" aria-pressed="${e.paid}" aria-label="${esc(e.paid ? t('commit.markUnpaid') : t('commit.markPaid'))}: ${esc(e.name)}">${e.paid ? '✓' : ''}</button>
    <span class="expense-name">${esc(e.name)}</span><span class="expense-category">${esc(catLabel(e.category))}</span><span class="expense-amount">${fmt(e.amountSen)}</span>
    <span class="row-actions"><button type="button" data-act="edit" data-id="${e.id}" aria-label="${esc(t('commit.editAria', { name: e.name }))}">✎</button><button type="button" data-act="delete" data-id="${e.id}" aria-label="${esc(t('commit.deleteAria', { name: e.name }))}">×</button></span></div>`).join('');
  ui.seen = new Set(list.map(e => e.id));

  const empty = $('expense-empty');
  empty.hidden = rows.length > 0;
  document.querySelector('.expense-table').hidden = rows.length === 0;
  if (!list.length) {
    empty.innerHTML = `<p class="empty-title">${esc(t('commit.emptyTitle'))}</p><p>${esc(t('commit.emptyBody'))}</p>
      <div class="btn-row"><button type="button" class="add-btn" data-act="add">${esc(t('commit.add'))}</button><button type="button" class="secondary-btn" data-act="seed">${esc(t('commit.seed'))}</button></div>`;
  } else if (!rows.length) {
    empty.innerHTML = `<p class="empty-title">${esc(t('commit.noMatchTitle'))}</p><p>${esc(t('commit.noMatchBody'))}</p><div class="btn-row"><button type="button" class="secondary-btn" data-act="clear">${esc(t('commit.clearFilters'))}</button></div>`;
  }
  const rt = $('receipt-total');
  rt.hidden = !list.length;
  rt.innerHTML = `<div><dt>${esc(t('commit.totalLine', { n: list.length }))}</dt><dd>${fmt(total)}</dd></div>
    <div><dt>${esc(t('commit.paid'))}</dt><dd>${fmt(total - sum(unpaid))}</dd></div>
    <div><dt>${esc(t('commit.unpaid'))}</dt><dd>${fmt(sum(unpaid))}</dd></div>
    <div class="grand"><dt>${esc(t('commit.after'))}</dt><dd>${fmt(bal)}</dd></div>`;
}

// ---------- Jadual (navigasi bulan) ----------
function renderTimeline(list) {
  const today = new Date(), base = new Date(today.getFullYear(), today.getMonth() + ui.month, 1);
  const y = base.getFullYear(), m = base.getMonth(), dim = daysIn(y, m), cur = ui.month === 0;
  $('tl-month-label').textContent = monthYear(base);
  $('tl-desc').textContent = t(cur ? 'sched.desc' : 'sched.otherMonth');
  const mon = monthName(base, 'short');
  const dated = list.filter(e => e.dueDay).sort((a, b) => Math.min(a.dueDay, dim) - Math.min(b.dueDay, dim) || a.name.localeCompare(b.name));
  const rows = dated.map((e, idx) => {
    const day = Math.min(e.dueDay, dim), diff = day - today.getDate();
    const status = !cur ? 'later' : e.paid ? 'paid' : diff < 0 ? 'overdue' : diff <= 3 ? 'soon' : diff <= 7 ? 'week' : 'later';
    const badge = !cur ? '' : e.paid ? t('sched.paid') : diff < 0 ? t('sched.late', { n: -diff }) : diff === 0 ? t('sched.today') : diff === 1 ? t('sched.tomorrow') : t('sched.inDays', { n: diff });
    return `<div class="tl-item tl-${status}" style="--i:${Math.min(idx, 12)}"><div class="tl-day"><span class="tl-day-num">${day}</span><span class="tl-month">${esc(mon)}</span></div><div class="tl-connector"><div class="tl-dot"></div><div class="tl-line"></div></div><div class="tl-content"><span class="tl-name">${esc(e.name)}</span><span class="tl-cat">${esc(catLabel(e.category))}${e.dueDay > dim ? ` · ${esc(t('sched.clamped'))}` : ''}</span><span class="tl-amt">${fmt(e.amountSen)}</span></div>${badge ? `<span class="tl-badge tl-badge-${status}">${esc(badge)}</span>` : ''}</div>`;
  }).join('');
  const undated = list.filter(e => !e.dueDay);
  const rest = undated.length ? `<div class="tl-nodate"><span class="tl-nodate-label">${esc(t('sched.noDate'))}</span>${undated.map(e => `<div class="tl-nodate-item"><span>${esc(e.name)}</span><span class="tl-amt">${fmt(e.amountSen)}</span></div>`).join('')}</div>` : '';
  $('timeline-list').innerHTML = rows + rest || `<div class="empty-state"><p class="empty-title">${esc(t('sched.emptyTitle'))}</p><p>${esc(t('sched.emptyBody'))}</p></div>`;
}
$('tl-prev').onclick = () => { ui.month--; renderTimeline(store.liveExpenses()); };
$('tl-next').onclick = () => { ui.month++; renderTimeline(store.liveExpenses()); };
$('tl-now').onclick = () => { ui.month = 0; renderTimeline(store.liveExpenses()); };

// ---------- Sejarah (Data) ----------
function renderHistory() {
  const h = ui.h, q = h.q.trim().toLowerCase();
  let rows = activity().filter(a => (h.kind === 'all' || a.kind === h.kind) && (!q || a.name.toLowerCase().includes(q) || catLabel(a.category).toLowerCase().includes(q)));
  rows.sort(h.sort === 'old' ? (a, b) => a.at.localeCompare(b.at) : h.sort === 'amount' ? (a, b) => b.amountSen - a.amountSen : (a, b) => b.at.localeCompare(a.at));
  $('hist-count').textContent = t('data.count', { n: rows.length });
  $('hist-list').innerHTML = rows.length ? rows.map(a => `<li><span class="t">${esc(a.name)}</span><span class="s"><span class="pill ${a.kind === 'deleted' ? 'err' : a.kind === 'added' ? 'ok' : 'warn'}">${esc(t(`act.${a.kind}`))}</span>${esc(catLabel(a.category))} · ${esc(fmtDateTimeL(a.at))}</span><span class="v">${fmt(a.amountSen)}</span></li>`).join('')
    : `<li><span class="muted">${esc(t('data.empty'))}</span></li>`;
}
$('hist-search').oninput = e => { ui.h.q = e.target.value; renderHistory(); };
$('hist-filter').onchange = e => { ui.h.kind = e.target.value; renderHistory(); };
$('hist-sort').onchange = e => { ui.h.sort = e.target.value; renderHistory(); };

// ---------- Tetapan ----------
const SYNC_KEY = { off: 'off', connecting: 'connecting', idle: 'idle', syncing: 'syncing', error: 'error', unavailable: 'unavailable' };
const renderSettings = debounce(async () => {
  const st = store.state;
  markLang(); applyTheme();
  const income = store.getSetting('incomeSen'), bal = income - sum(store.liveExpenses());
  $('preview-fig').textContent = fmt(bal);
  $('preview-note').textContent = `${monthYear(new Date())} · ${t('home.pctIncome', { pct: (income > 0 ? bal / income * 100 : 0).toFixed(1) })}`;
  $('record-count').textContent = t('common.items', { n: store.liveExpenses().length });
  $('last-backup').textContent = fmtDateTimeL(st.settings.get('_lastBackupAt')?.value);
  const stamps = [...st.expenses.values(), ...[...st.settings.values()].filter(s => !s.key.startsWith('_'))].map(r => r.updatedAt).filter(Boolean).sort();
  $('last-save').textContent = fmtDateTimeL(stamps[stamps.length - 1]);
  $('sync-state').textContent = t(`sync.${SYNC_KEY[sync.status.phase] || 'off'}`);
  $('last-sync').textContent = fmtDateTimeL(st.settings.get('_lastSyncedAt')?.value);
  $('pending-count').textContent = t('set.pendingN', { n: st.pending.size });
  $('sync-error').textContent = sync.status.error ? String(sync.status.error.message || sync.status.error) : t('sync.noError');
  $('app-version').textContent = APP_VERSION;
  if (!st.storageOk) { $('storage-state').textContent = t('set.unavailable'); return; }
  const info = await store.storageInfo();
  $('storage-state').textContent = info.persisted === true ? t('set.persisted') : info.persisted === false ? t('set.notPersisted') : t('set.available');
  $('storage-usage').textContent = info.usage != null ? `${(info.usage / 1024).toFixed(0)} KB` : '—';
  const snaps = await store.listSnapshots();
  $('snapshot-list').innerHTML = snaps.length ? snaps.map(s => `<li><div><b>${esc(s.reason && t(`reason.${s.reason}`) !== `reason.${s.reason}` ? t(`reason.${s.reason}`) : s.reason)}</b><span>${esc(fmtDateTimeL(s.createdAt))}${s.count != null ? ` · ${esc(t('set.snapCount', { n: s.count }))}` : ''}</span></div>
    <button type="button" class="secondary-btn" data-snap="${s.id}" data-act="${s.reason === 'data-lama-tak-terbaca' ? 'download' : 'restore'}">${esc(s.reason === 'data-lama-tak-terbaca' ? t('common.download') : t('common.restore'))}</button></li>`).join('')
    : `<li><span class="muted">${esc(t('set.snapEmpty'))}</span></li>`;
}, 120);

$('snapshot-list').onclick = async e => {
  const b = e.target.closest('button[data-snap]'); if (!b) return;
  const id = +b.dataset.snap;
  if (b.dataset.act === 'download') {
    const snap = await store.getSnapshot(id);
    if (snap) downloadText(snap.raw, 'ruang-bajet-data-lama.txt', 'text/plain');
    return;
  }
  const ok = await ask({ title: t('snap.restoreTitle'), body: t('snap.restoreBody'), actions: [{ label: t('common.cancel'), value: false }, { label: t('common.restore'), kind: 'add-btn', value: true }] });
  if (ok) store.restoreSnapshot(id).then(() => toast(t('snap.restored'), { kind: 'ok' })).catch(fail);
};
const doExport = () => exportBackup().then(r => toast(t('toast.exported', { n: r.count }), { kind: 'ok' })).catch(e => toast(t('err.exportFail', { msg: e.message }), { kind: 'error' }));
$('export-btn').onclick = doExport; $('set-export').onclick = doExport;
$('import-btn').onclick = $('set-import').onclick = () => $('import-file').click();
$('set-snapshot').onclick = () => store.createSnapshot().then(() => toast(t('snap.created'), { kind: 'ok' })).catch(fail);
$('import-file').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try { data = parseBackup(await file.text()); } catch (err) {
    return ask({ title: t('imp.cannot'), eyebrow: t('imp.eyebrow'), body: `<p>${esc(err.message)}</p><p>${esc(t('imp.nothing'))}</p>`, actions: [{ label: t('common.close'), kind: 'add-btn', value: null }] });
  }
  const { stats } = store.planMerge(data);
  const current = store.liveExpenses().length;
  const choice = await ask({
    title: t('imp.title'), eyebrow: t('imp.eyebrow'),
    body: `<dl class="kv"><div><dt>${esc(t('imp.file'))}</dt><dd>${esc(file.name)}</dd></div><div><dt>${esc(t('imp.exported'))}</dt><dd>${esc(fmtDateTimeL(data.meta.exportedAt))}</dd></div><div><dt>${esc(t('imp.schema'))}</dt><dd>v${data.meta.schemaVersion}${data.meta.legacy ? ' ' + esc(t('imp.legacy')) : ''}</dd></div><div><dt>${esc(t('imp.inFile'))}</dt><dd>${stats.total}</dd></div><div><dt>${esc(t('imp.current'))}</dt><dd>${current}</dd></div></dl>
      <p>${t('imp.mergePlan', { added: stats.added, updated: stats.updated, restored: stats.restored, dups: stats.duplicates, same: stats.unchanged })}</p>
      <p>${t('imp.replacePlan', { current, total: stats.total })}</p>`,
    actions: [{ label: t('common.cancel'), value: null }, { label: t('imp.replace'), kind: 'danger-btn', value: 'replace' }, { label: t('imp.merge'), kind: 'add-btn', value: 'merge' }],
  });
  if (choice === 'merge') {
    store.mergeImport(data).then(s => toast(t('imp.done', { added: s.added, updated: s.updated + s.restored, dups: s.duplicates }), { kind: 'ok', ms: 7000 })).catch(fail);
  } else if (choice === 'replace') {
    const sure = await ask({ title: t('imp.replaceTitle'), body: `<p>${esc(t('imp.replaceBody', { current, total: stats.total }))}</p>`, actions: [{ label: t('common.cancel'), value: false }, { label: t('imp.replaceYes'), kind: 'danger-btn', value: true }] });
    if (sure) store.replaceAll(data, 'pra-import-ganti').then(() => toast(t('imp.replaced', { n: stats.total }), { kind: 'ok' })).catch(fail);
  }
};
$('reset-btn').onclick = async () => {
  const ok = await ask({ title: t('reset.title'), body: t('reset.body'), actions: [{ label: t('common.cancel'), value: false }, { label: t('reset.yes'), kind: 'danger-btn', value: true }] });
  if (ok) store.replaceAll(fromLegacy({ income: 0, target: 0, expenses: [], commute: {} }), 'pra-set-semula').then(() => { ui.filter = ALL; toast(t('reset.done'), { kind: 'ok' }); }).catch(fail);
};
// Kosongkan cache: hanya Cache Storage + service worker. IndexedDB (rekod kewangan) tidak disentuh.
$('clear-cache').onclick = async () => {
  const ok = await ask({ title: t('cache.title'), body: t('cache.body'), actions: [{ label: t('common.cancel'), value: false }, { label: t('cache.yes'), kind: 'add-btn', value: true }] });
  if (!ok) return;
  try {
    if ('caches' in window) await Promise.all((await caches.keys()).map(k => caches.delete(k)));
    if (navigator.serviceWorker) await Promise.all((await navigator.serviceWorker.getRegistrations()).map(r => r.unregister()));
  } catch (e) { console.warn('[cache]', e); }
  location.reload();
};
const loadSeed = msg => store.replaceAll(fromLegacy(store.SEED), 'pra-set-semula').then(() => { ui.filter = ALL; toast(msg, { kind: 'ok' }); }).catch(fail);
$('sync-btn').onclick = () => sync.syncNow().then(() => toast(sync.status.phase === 'idle' ? t('toast.syncOk') : t('toast.syncFail'), { kind: sync.status.phase === 'idle' ? 'ok' : 'error' }));

// ---------- Senarai komitmen ----------
$('category-summary').onclick = e => { const b = e.target.closest('[data-cat]'); if (b) { ui.filter = b.dataset.cat; renderExpenses(store.liveExpenses()); } };
$('expense-search').oninput = e => { ui.query = e.target.value; renderExpenses(store.liveExpenses()); };
$('expense-sort').onchange = e => { ui.sort = e.target.value; renderExpenses(store.liveExpenses()); };
$('expense-empty').onclick = e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'add') openModal();
  if (act === 'seed') loadSeed(t('commit.seeded'));
  if (act === 'clear') { ui.filter = ALL; ui.query = ''; $('expense-search').value = ''; renderExpenses(store.liveExpenses()); }
};
function rowAction(b) {
  const id = b.dataset.id, rec = store.state.expenses.get(id);
  if (!rec) return;
  if (b.dataset.act === 'tick') { ui.pulse = id; setTimeout(() => { if (ui.pulse === id) ui.pulse = null; }, 900); guard(store.updateExpense(id, { paid: !rec.paid })); }
  if (b.dataset.act === 'edit') openModal(id);
  if (b.dataset.act === 'delete') store.deleteExpense(id).then(() => toast(t('commit.deleted', { name: rec.name }), { action: { label: t('common.undo'), fn: () => guard(store.restoreExpense(id)) } })).catch(fail);
}
$('expense-list').onclick = e => { const b = e.target.closest('button[data-act]'); if (b) rowAction(b); };
$('recurring-list').onclick = e => { const b = e.target.closest('button[data-act]'); if (b) rowAction(b); };
document.querySelector('[data-act=add-rec]').onclick = () => openModal();

// ---------- Borang item ----------
function fillCategorySelect() {
  const sel = $('expense-category'), cur = sel.value;
  sel.innerHTML = CATEGORIES.map(c => `<option value="${esc(c)}">${esc(catLabel(c))}</option>`).join('');
  if (cur && ![...sel.options].some(o => o.value === cur)) sel.add(new Option(catLabel(cur), cur));
  if (cur) sel.value = cur;
}
function setupSelects() { /* <option data-i18n> sudah diterjemah oleh applyI18n */ }
function openModal(id = null) {
  const rec = id ? store.state.expenses.get(id) : null;
  ui.editing = rec ? id : null;
  $('modal-title').textContent = t(rec ? 'form.titleEdit' : 'form.titleNew');
  $('expense-name').value = rec?.name ?? '';
  fillCategorySelect();
  const sel = $('expense-category'), cat = rec?.category ?? 'Lain-lain';
  if (![...sel.options].some(o => o.value === cat)) sel.add(new Option(catLabel(cat), cat));
  sel.value = cat;
  $('expense-amount').value = rec ? rec.amountSen / 100 : '';
  $('expense-dueday').value = rec?.dueDay ?? '';
  $('expense-error').hidden = true;
  $('expense-submit').disabled = false;
  $('modal').classList.add('open');
  $('expense-name').focus();
}
function closeModal() { $('modal').classList.remove('open'); }
$('expense-form').onsubmit = async e => {
  e.preventDefault();
  const btn = $('expense-submit');
  if (btn.disabled) return; // elak hantar berganda
  const err = msg => { $('expense-error').textContent = msg; $('expense-error').hidden = false; };
  const name = $('expense-name').value.trim();
  const amountRaw = $('expense-amount').value.trim(), dueRaw = $('expense-dueday').value.trim();
  const amount = Number(amountRaw), due = dueRaw === '' ? null : Number(dueRaw);
  if (!name) return err(t('form.errName'));
  if (amountRaw === '' || !Number.isFinite(amount) || amount < 0) return err(t('form.errAmount'));
  if (due !== null && !(Number.isInteger(due) && due >= 1 && due <= 31)) return err(t('form.errDay'));
  const fields = { name, category: $('expense-category').value, amountSen: toSen(amount), dueDay: due };
  // Elak pendua (nama + kategori + jumlah sama) — termasuk bayaran berulang.
  const key = f => `${f.name.toLowerCase()}|${f.category}|${f.amountSen}`;
  if (store.liveExpenses().some(x => x.id !== ui.editing && key(x) === key(fields))) return err(t('form.errDup'));
  btn.disabled = true; btn.textContent = t('form.saving');
  try {
    await (ui.editing ? store.updateExpense(ui.editing, fields) : store.addExpense(fields));
    closeModal();
    toast(t(ui.editing ? 'commit.itemUpdated' : 'commit.itemAdded'), { kind: 'ok', ms: 2500 });
  } catch (ex) { err(t('form.errSave', { msg: ex.message })); }
  finally { btn.disabled = false; btn.textContent = t('form.submit'); }
};
$('add-expense').onclick = () => openModal();
$('close-modal').onclick = closeModal;
$('cancel-modal').onclick = closeModal;
$('modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };

// ---------- Tetapan rutin (auto-simpan dengan debounce) ----------
const savers = {};
const saveSetting = (key, read) => {
  savers[key] ||= debounce(() => { savers[key].dirty = false; guard(store.setSetting(key, read())); }, 450);
  savers[key].dirty = true;
  return savers[key];
};
const num = id => Math.max(0, Number($(id).value) || 0);
const readCommute = () => ({ distance: num('distance'), days: Math.min(31, Math.round(num('days'))), efficiency: num('efficiency'), fuelPriceSen: toSen(num('fuel-price')), roundTrip: $('round-trip').checked });
const bind = (id, key, read) => {
  $(id).addEventListener('input', () => saveSetting(key, read)());
  $(id).addEventListener('change', () => saveSetting(key, read).flush());
};
bind('income-input', 'incomeSen', () => toSen(num('income-input')));
bind('savings-target', 'targetSen', () => toSen(num('savings-target')));
['distance', 'days', 'efficiency', 'fuel-price', 'round-trip'].forEach(id => bind(id, 'commute', readCommute));
const flushAll = () => Object.values(savers).forEach(s => { if (s.dirty) s.flush(); });
addEventListener('pagehide', flushAll);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });

// ---------- Navigasi (AppShell) ----------
const TABS = ['utama', 'komitmen', 'jadual', 'rutin', 'data', 'tetapan'];
const nav = $('app-nav'), navInd = nav.querySelector('.nav-ind');
const navLinks = [...nav.querySelectorAll('a[data-tab]')];
const views = [...document.querySelectorAll('.view')];
let curTab = null;
function moveIndicator() {
  const a = navLinks.find(l => l.dataset.tab === curTab && l.offsetParent !== null);
  if (!a) { navInd.style.opacity = '0'; return; }
  navInd.style.opacity = '';
  navInd.style.setProperty('--x', `${a.offsetLeft}px`);
  navInd.style.setProperty('--w', `${a.offsetWidth}px`);
  if (!navInd.classList.contains('ready')) requestAnimationFrame(() => navInd.classList.add('ready'));
}
function replayHome() {
  const bars = ['balance-bar', 'hb-savings', 'hb-burden', 'hb-paid'].map($);
  const arc = $('health-arc'), all = [...bars, arc];
  all.forEach(el => { el.style.transition = 'none'; });
  arc.style.strokeDashoffset = 251.2;
  bars.forEach(el => el.style.setProperty('--p', 0));
  void arc.getBoundingClientRect();
  requestAnimationFrame(() => {
    all.forEach(el => { el.style.transition = ''; });
    if (curTab !== 'utama') return;
    ui.replay = true; renderHome(store.liveExpenses()); ui.replay = false;
  });
}
function showTab(tab) {
  if (!TABS.includes(tab)) tab = 'utama';
  if (tab === curTab) return;
  const first = !curTab;
  curTab = tab;
  views.forEach(v => {
    const on = v.dataset.tab === tab;
    v.hidden = !on;
    v.classList.remove('entering');
    clearTimeout(v._t);
    if (on) { void v.offsetWidth; v.classList.add('entering'); v._t = setTimeout(() => v.classList.remove('entering'), 900); }
  });
  navLinks.forEach(a => (a.dataset.tab === tab ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  $('settings-link').toggleAttribute('aria-current', tab === 'tetapan');
  moveIndicator();
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (tab === 'utama' && !first && store.state.ready) replayHome();
}
document.querySelectorAll('[data-go]').forEach(b => { b.onclick = () => { location.hash = b.dataset.go; }; });
addEventListener('hashchange', () => showTab(location.hash.slice(1)));
addEventListener('resize', moveIndicator);
if (document.fonts?.ready) document.fonts.ready.then(moveIndicator);
// Papan kekunci mobile: sorok nav supaya tidak menutup medan (tidak mengubah susun atur).
if (window.visualViewport) {
  const kb = () => {
    const open = visualViewport.height < innerHeight * 0.75 && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
    document.body.classList.toggle('kb-open', open);
  };
  visualViewport.addEventListener('resize', kb);
  document.addEventListener('focusout', () => setTimeout(kb, 80));
}

// ---------- Tarik untuk segar semula ----------
(() => {
  let startY = 0, pulling = false;
  const ind = $('ptr-indicator'), THRESHOLD = 72;
  document.addEventListener('touchstart', e => { startY = scrollY === 0 && !document.querySelector('.modal-backdrop.open') ? e.touches[0].clientY : 0; }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (!startY) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 0 && scrollY === 0) {
      pulling = true;
      const p = Math.min(dy / THRESHOLD, 1);
      ind.style.transform = `translateX(-50%) translateY(${Math.min(dy * 0.45, 42)}px)`;
      ind.style.opacity = p;
      ind.querySelector('.ptr-arrow').style.transform = `rotate(${p * 180}deg)`;
    }
  }, { passive: true });
  document.addEventListener('touchend', async () => {
    if (!pulling) { startY = 0; return; }
    pulling = false; startY = 0;
    if (parseFloat(ind.style.opacity || 0) >= 0.9) {
      ind.classList.add('loading');
      await sync.syncNow();
      toast(sync.status.phase === 'idle' ? t('toast.ptrOk') : t('toast.ptrFail'), { kind: sync.status.phase === 'idle' ? 'ok' : 'info', ms: 2500 });
    }
    ind.style.transform = ''; ind.style.opacity = '0'; ind.classList.remove('loading');
  });
})();

// ---------- Permulaan ----------
store.subscribe(type => (type === 'status' ? renderStatus() : render()));
sync.subscribe((type, detail) => {
  if (type === 'conflict') toast(t('toast.conflict', { n: detail }), { ms: 9000 });
  renderStatus(); renderSettings();
});
addEventListener('online', renderStatus);
addEventListener('offline', renderStatus);

let bc = null;
try { bc = new BroadcastChannel('ruang-bajet'); bc.onmessage = () => store.reload(); } catch { /* tak disokong */ }
store.subscribe(type => { if (type === 'written' && bc) bc.postMessage('written'); });

function showBanner() {
  const st = store.state, b = $('banner');
  const msgs = [];
  if (!st.storageOk) msgs.push(t('banner.noStorage', { msg: esc(st.fatal?.message || 'storage') }));
  if (st.legacyCorrupt) msgs.push(t('banner.legacyCorrupt'));
  b.hidden = !msgs.length;
  b.innerHTML = msgs.join('<br>');
}

applyTheme();
loadLang().catch(e => console.warn('[i18n]', e)).then(() => {
  applyI18n(); fillCategorySelect(); markLang();
  $('footer-note').textContent = t('footer.note');
  $('app-version').textContent = APP_VERSION;
  $('app-build').textContent = fmtDate(document.lastModified);
  return store.init();
}).then(() => {
  document.body.classList.remove('is-loading');
  showBanner();
  showTab(location.hash.slice(1));
  render();
  setTimeout(() => $('splash')?.classList.add('hide'), 250);
  setTimeout(() => $('splash')?.remove(), 700);
  if (store.state.storageOk) sync.start();
});

if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(e => console.warn('[sw]', e)));

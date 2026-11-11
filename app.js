// Lapisan UI. Semua data melalui js/store.js — fail ini tidak menyentuh storan secara langsung.
import * as store from './js/store.js';
import * as sync from './js/sync.js';
import { exportBackup, parseBackup, downloadText } from './js/backup.js';
import { fmt, toSen, senToInput, esc, fmtDateTime, debounce, fromLegacy, APP_VERSION } from './js/utils.js';

const $ = id => document.getElementById(id);
const ui = { filter: 'Semua', query: '', sort: 'added', editing: null, seen: null, pulse: null, replay: false };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// Nombor "naik" ke nilai baharu (kosong -> terus set pada render pertama).
function tween(el, to, f = fmt) {
  cancelAnimationFrame(el._raf);
  const from = ui.replay ? 0 : (el._v ?? to);
  el._v = to;
  if (from === to || reduceMotion.matches) { el.textContent = f(to); return; }
  const t0 = performance.now(), dur = 650;
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
const fail = e => toast(`Gagal simpan: ${e?.message || 'ralat tidak diketahui'}`, { kind: 'error', ms: 7000 });
const guard = p => p.catch(fail);

let dialogResolve = null;
function ask({ title, body = '', eyebrow = 'Pengesahan', actions }) {
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
  if (!store.state.ready) return ['load', 'Memuatkan…'];
  if (!store.state.storageOk) return ['err', 'Storan tidak tersedia'];
  if (L.state === 'saving') return ['busy', 'Menyimpan…'];
  if (L.state === 'error') return ['err', 'Gagal simpan', L.retry];
  if (!navigator.onLine) return ['warn', 'Luar talian — disimpan pada peranti ini'];
  if (S.phase === 'syncing') return ['busy', 'Menyegerak…'];
  if (S.phase === 'error') return ['err', 'Sync gagal — selamat pada peranti', sync.syncNow];
  if (pending) return ['warn', 'Menunggu sync'];
  if (S.phase === 'idle') return ['ok', 'Disimpan'];
  return ['ok', 'Disimpan pada peranti ini'];
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

// ---------- Render utama ----------
function render() {
  if (!store.state.ready) return;
  const list = store.liveExpenses();
  const income = store.getSetting('incomeSen'), target = store.getSetting('targetSen');
  const total = sum(list), bal = income - total;
  const unpaid = list.filter(e => !e.paid), paidCount = list.length - unpaid.length;
  const pct = income > 0 ? bal / income * 100 : 0;

  tween($('balance'), bal);
  tween($('income-display'), income);
  tween($('expenses-display'), total);
  tween($('target-display'), target);
  $('balance-note').textContent = `${pct.toFixed(1)}% daripada pendapatan`;
  $('balance-bar').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  $('target-note').textContent = `${fmt(bal - target)} selepas simpanan`;
  $('expense-count').textContent = `${list.length} item aktif`;
  $('target-percent').textContent = `${bal > 0 ? Math.round(target / bal * 100) : 0}%`;
  $('paid-count').textContent = list.length ? `${paidCount}/${list.length} dah bayar` : ' ';
  tween($('unpaid-display'), sum(unpaid));
  $('unpaid-count').textContent = `${unpaid.length} item belum bayar`;

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

  renderExpenses(list, { total, bal, unpaid });
  renderHealth(list, income, total, bal);
  renderTimeline(list);
  renderStatus();
  renderDataPanel();
}

function renderExpenses(list, { total, bal, unpaid }) {
  const cats = ['Semua', ...new Set(list.map(e => e.category))];
  if (!cats.includes(ui.filter)) ui.filter = 'Semua';
  $('category-summary').innerHTML = cats.map(cat =>
    `<button type="button" class="category-pill ${cat === ui.filter ? 'active' : ''}" aria-pressed="${cat === ui.filter}" data-cat="${esc(cat)}">${esc(cat)}${cat === 'Semua' ? '' : ' ' + fmt(sum(list.filter(e => e.category === cat)))}</button>`).join('');

  const q = ui.query.trim().toLowerCase();
  let rows = list.filter(e => (ui.filter === 'Semua' || e.category === ui.filter) && (!q || e.name.toLowerCase().includes(q) || e.category.toLowerCase().includes(q)));
  const sorters = {
    due: (a, b) => (a.dueDay ?? 99) - (b.dueDay ?? 99),
    amount: (a, b) => b.amountSen - a.amountSen,
    name: (a, b) => a.name.localeCompare(b.name, 'ms'),
    unpaid: (a, b) => a.paid - b.paid || (a.dueDay ?? 99) - (b.dueDay ?? 99),
  };
  if (sorters[ui.sort]) rows = [...rows].sort(sorters[ui.sort]);

  const seen = ui.seen;
  $('expense-list').innerHTML = rows.map((e, i) => `<div class="expense-row${e.paid ? ' paid' : ''}${seen && !seen.has(e.id) ? ' row-new' : ''}${ui.pulse === e.id ? ' pulse' : ''}" style="--i:${Math.min(i, 12)}">
    <button type="button" class="tick-btn" data-act="tick" data-id="${e.id}" aria-pressed="${e.paid}" aria-label="${e.paid ? 'Tandakan belum bayar' : 'Tandakan dah bayar'}: ${esc(e.name)}">${e.paid ? '✓' : ''}</button>
    <span class="expense-name">${esc(e.name)}</span><span class="expense-category">${esc(e.category)}</span><span class="expense-amount">${fmt(e.amountSen)}</span>
    <span class="row-actions"><button type="button" data-act="edit" data-id="${e.id}" aria-label="Edit ${esc(e.name)}">✎</button><button type="button" data-act="delete" data-id="${e.id}" aria-label="Padam ${esc(e.name)}">×</button></span></div>`).join('');

  ui.seen = new Set(list.map(e => e.id));
  const empty = $('expense-empty');
  empty.hidden = rows.length > 0;
  document.querySelector('.expense-table').hidden = rows.length === 0;
  if (!list.length) {
    empty.innerHTML = `<p class="empty-title">Belum ada komitmen</p><p>Tambah item pertama anda, import sandaran, atau mula dengan angka asal.</p>
      <div class="btn-row"><button type="button" class="add-btn" data-act="add">+ Tambah item</button><button type="button" class="secondary-btn" data-act="seed">Muat angka asal</button></div>`;
  } else if (!rows.length) {
    empty.innerHTML = `<p class="empty-title">Tiada item sepadan</p><p>Cuba kata carian lain atau kosongkan tapisan.</p><div class="btn-row"><button type="button" class="secondary-btn" data-act="clear">Kosongkan tapisan</button></div>`;
  }

  const rt = $('receipt-total');
  rt.hidden = !list.length;
  rt.innerHTML = `<div><dt>Jumlah · ${list.length} item</dt><dd>${fmt(total)}</dd></div>
    <div><dt>Dah bayar</dt><dd>${fmt(total - sum(unpaid))}</dd></div>
    <div><dt>Belum bayar</dt><dd>${fmt(sum(unpaid))}</dd></div>
    <div class="grand"><dt>Baki selepas komitmen</dt><dd>${fmt(bal)}</dd></div>`;
}

function renderHealth(list, income, total, bal) {
  const savingsRatio = income > 0 ? Math.max(0, bal / income) : 0;
  const burdenRatio = income > 0 ? Math.min(1, total / income) : 0;
  const unpaidN = list.filter(e => !e.paid).length;
  const paidRatio = list.length ? (list.length - unpaidN) / list.length : 0;
  const score = Math.min(100, Math.round(savingsRatio * 40) + Math.round((1 - burdenRatio) * 40) + Math.round(paidRatio * 20));
  const hasData = income > 0 || list.length > 0;
  const grade = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';
  const color = score >= 80 ? '#9baa8a' : score >= 60 ? '#c8b86e' : score >= 40 ? '#bd7357' : '#884433';
  const arc = $('health-arc');
  arc.style.strokeDashoffset = 251.2 - (hasData ? score : 0) / 100 * 251.2;
  arc.style.stroke = color;
  if (hasData) tween($('health-score'), score, v => String(Math.round(v))); else { $('health-score')._v = 0; $('health-score').textContent = '–'; }
  const badge = $('health-grade-badge');
  badge.textContent = hasData ? grade : '–';
  badge.className = `health-grade ${hasData ? grade : 'none'}`;
  const bar = (id, ratio) => { $(id).style.width = `${Math.min(100, ratio * 100)}%`; $(`${id}-val`).textContent = `${Math.round(ratio * 100)}%`; };
  bar('hb-savings', savingsRatio); bar('hb-burden', burdenRatio); bar('hb-paid', paidRatio);

  const tips = [];
  if (!hasData) tips.push({ icon: '○', title: 'Belum ada data', msg: 'Masukkan pendapatan dan komitmen untuk melihat skor.' });
  else {
    if (savingsRatio < 0.1) tips.push({ icon: '💸', title: 'Simpanan rendah', msg: `Baki <b>${Math.round(savingsRatio * 100)}%</b> daripada pendapatan. Cuba kurang satu komitmen.` });
    else if (savingsRatio >= 0.2) tips.push({ icon: '✦', title: 'Simpanan sihat', msg: `<b>${Math.round(savingsRatio * 100)}%</b> baki tersedia — anda dalam landasan yang baik.` });
    if (burdenRatio > 0.7) tips.push({ icon: '⚠', title: 'Komitmen tinggi', msg: `<b>${Math.round(burdenRatio * 100)}%</b> pendapatan terikat. Cadangan: di bawah 60%.` });
    if (paidRatio < 0.5 && list.length) tips.push({ icon: '○', title: 'Bayaran belum settle', msg: `<b>${unpaidN}</b> item belum ditanda bayar bulan ini.` });
    else if (paidRatio === 1) tips.push({ icon: '✓', title: 'Semua settle', msg: `Semua <b>${list.length}</b> komitmen bulan ini dah diselesaikan.` });
    if (!tips.length) tips.push({ icon: '◆', title: 'Status kukuh', msg: `Skor <b>${score}/100</b> — kewangan dalam keadaan terkawal.` });
  }
  $('health-tips').innerHTML = tips.slice(0, 3).map(t => `<div class="health-tip"><span class="tip-icon" aria-hidden="true">${t.icon}</span><p><b>${t.title}</b> — ${t.msg}</p></div>`).join('');
}

function renderTimeline(list) {
  const today = new Date(), day = today.getDate();
  const mon = today.toLocaleString('ms-MY', { month: 'long' }).slice(0, 3);
  const dated = list.filter(e => e.dueDay).sort((a, b) => a.dueDay - b.dueDay);
  const undated = list.filter(e => !e.dueDay);
  const rows = dated.map((e, idx) => {
    const diff = e.dueDay - day;
    const status = e.paid ? 'paid' : diff < 0 ? 'overdue' : diff <= 3 ? 'soon' : diff <= 7 ? 'week' : 'later';
    const badge = e.paid ? '✓ Dah bayar' : diff < 0 ? `${-diff}h lps` : diff === 0 ? 'Hari ini' : diff === 1 ? 'Esok' : `${diff}h lagi`;
    return `<div class="tl-item tl-${status}" style="--i:${Math.min(idx, 12)}"><div class="tl-day"><span class="tl-day-num">${e.dueDay}</span><span class="tl-month">${esc(mon)}</span></div><div class="tl-connector"><div class="tl-dot"></div><div class="tl-line"></div></div><div class="tl-content"><span class="tl-name">${esc(e.name)}</span><span class="tl-cat">${esc(e.category)}</span><span class="tl-amt">${fmt(e.amountSen)}</span></div><span class="tl-badge tl-badge-${status}">${badge}</span></div>`;
  }).join('');
  const rest = undated.length ? `<div class="tl-nodate"><span class="tl-nodate-label">Tiada tarikh</span>${undated.map(e => `<div class="tl-nodate-item"><span>${esc(e.name)}</span><span class="tl-cat">${esc(e.category)}</span><span class="tl-amt">${fmt(e.amountSen)}</span></div>`).join('')}</div>` : '';
  $('timeline-list').innerHTML = rows + rest || `<div class="empty-state"><p class="empty-title">Tiada jadual lagi</p><p>Tambah komitmen dengan hari bayar untuk melihatnya di sini.</p></div>`;
}

// ---------- Panel data ----------
const REASONS = {
  'pra-migrasi': 'Data asal sebelum naik taraf', 'auto-harian': 'Automatik harian', 'pra-import-ganti': 'Sebelum import (ganti)',
  'pra-import-gabung': 'Sebelum import (gabung)', 'pra-pulih': 'Sebelum pemulihan', 'pra-set-semula': 'Sebelum set semula',
  'konflik-sync': 'Versi peranti ini (konflik sync)', 'data-lama-tak-terbaca': 'Data lama tak terbaca',
};
const SYNC_LABEL = { off: 'Belum bermula', connecting: 'Menyambung…', idle: 'Aktif', syncing: 'Menyegerak…', error: 'Gagal — akan cuba lagi', unavailable: 'Tidak tersedia (luar talian)' };
const renderDataPanel = debounce(async () => {
  const st = store.state;
  $('last-backup').textContent = fmtDateTime(st.settings.get('_lastBackupAt')?.value);
  $('record-count').textContent = `${store.liveExpenses().length} item`;
  $('sync-state').textContent = SYNC_LABEL[sync.status.phase] || '—';
  $('last-sync').textContent = fmtDateTime(st.settings.get('_lastSyncedAt')?.value);
  $('pending-count').textContent = `${st.pending.size} perubahan`;
  if (!st.storageOk) { $('storage-state').textContent = 'Tidak tersedia'; return; }
  const info = await store.storageInfo();
  $('storage-state').textContent = info.persisted === true ? 'Kekal (dilindungi)' : info.persisted === false ? 'Biasa (boleh dikosongkan pelayar)' : 'Aktif';
  $('storage-usage').textContent = info.usage != null ? `${(info.usage / 1024).toFixed(0)} KB` : '—';
  const snaps = await store.listSnapshots();
  $('snapshot-list').innerHTML = snaps.length ? snaps.map(s => `<li><div><b>${esc(REASONS[s.reason] || s.reason)}</b><span>${esc(fmtDateTime(s.createdAt))}${s.count != null ? ` · ${s.count} rekod` : ''}</span></div>
    ${s.reason === 'data-lama-tak-terbaca' ? `<button type="button" class="secondary-btn" data-snap="${s.id}" data-act="download">Muat turun</button>` : `<button type="button" class="secondary-btn" data-snap="${s.id}" data-act="restore">Pulihkan</button>`}</li>`).join('')
    : '<li class="snap-empty">Belum ada salinan. Ia akan dibuat secara automatik.</li>';
}, 120);

$('snapshot-list').onclick = async e => {
  const b = e.target.closest('button[data-snap]'); if (!b) return;
  const id = +b.dataset.snap;
  if (b.dataset.act === 'download') {
    const snap = await store.getSnapshot(id);
    if (snap) downloadText(snap.raw, 'ruang-bajet-data-lama.txt', 'text/plain');
    return;
  }
  const ok = await ask({ title: 'Pulihkan salinan ini?', body: '<p>Data semasa akan digantikan dengan salinan ini. Data semasa disimpan dahulu sebagai salinan pemulihan, jadi ia boleh diundur.</p>',
    actions: [{ label: 'Batal', value: false }, { label: 'Pulihkan', kind: 'add-btn', value: true }] });
  if (ok) store.restoreSnapshot(id).then(() => toast('Salinan dipulihkan', { kind: 'ok' })).catch(fail);
};

$('export-btn').onclick = () => exportBackup().then(r => toast(`Sandaran dieksport: ${r.count} rekod`, { kind: 'ok' })).catch(e => toast(`Eksport gagal: ${e.message}`, { kind: 'error' }));
$('import-btn').onclick = () => $('import-file').click();
$('import-file').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try { data = parseBackup(await file.text()); } catch (err) {
    return ask({ title: 'Fail tidak boleh diimport', eyebrow: 'Import', body: `<p>${esc(err.message)}</p><p>Tiada apa-apa diubah.</p>`, actions: [{ label: 'Tutup', kind: 'add-btn', value: null }] });
  }
  const { stats } = store.planMerge(data);
  const current = store.liveExpenses().length;
  const choice = await ask({
    title: 'Pratonton import', eyebrow: 'Import',
    body: `<dl class="kv"><div><dt>Fail</dt><dd>${esc(file.name)}</dd></div><div><dt>Dieksport</dt><dd>${esc(fmtDateTime(data.meta.exportedAt))}</dd></div><div><dt>Skema</dt><dd>v${data.meta.schemaVersion}${data.meta.legacy ? ' (format lama)' : ''}</dd></div><div><dt>Rekod dalam fail</dt><dd>${stats.total}</dd></div><div><dt>Rekod semasa</dt><dd>${current}</dd></div></dl>
      <p><b>Gabung</b> akan: tambah ${stats.added} baharu, kemas kini ${stats.updated}, pulihkan ${stats.restored}; langkau ${stats.duplicates} pendua dan ${stats.unchanged} yang sama.</p>
      <p><b>Ganti semua</b> akan membuang ${current} rekod semasa dan guna ${stats.total} rekod dari fail.</p>`,
    actions: [{ label: 'Batal', value: null }, { label: 'Ganti semua…', kind: 'danger-btn', value: 'replace' }, { label: 'Gabung', kind: 'add-btn', value: 'merge' }],
  });
  if (choice === 'merge') {
    store.mergeImport(data).then(s => toast(`Import siap: ${s.added} ditambah, ${s.updated + s.restored} dikemas kini, ${s.duplicates} pendua dilangkau`, { kind: 'ok', ms: 7000 })).catch(fail);
  } else if (choice === 'replace') {
    const sure = await ask({ title: 'Ganti semua data?', body: `<p>${current} rekod semasa akan digantikan dengan ${stats.total} rekod dari fail. Salinan data semasa disimpan dahulu dalam "Salinan pemulihan".</p>`,
      actions: [{ label: 'Batal', value: false }, { label: 'Ya, ganti semua', kind: 'danger-btn', value: true }] });
    if (sure) store.replaceAll(data, 'pra-import-ganti').then(() => toast(`Data diganti: ${stats.total} rekod`, { kind: 'ok' })).catch(fail);
  }
};
$('reset-btn').onclick = async () => {
  const ok = await ask({ title: 'Set semula ke angka asal?', body: '<p>Semua komitmen dan tetapan semasa akan digantikan dengan angka asal. Salinan data semasa disimpan dahulu dalam "Salinan pemulihan".</p>',
    actions: [{ label: 'Batal', value: false }, { label: 'Ya, set semula', kind: 'danger-btn', value: true }] });
  if (ok) loadSeed('Angka asal dimuatkan');
};
const loadSeed = msg => store.replaceAll(fromLegacy(store.SEED), 'pra-set-semula').then(() => { ui.filter = 'Semua'; toast(msg, { kind: 'ok' }); }).catch(fail);
$('sync-btn').onclick = () => sync.syncNow().then(() => toast(sync.status.phase === 'idle' ? 'Segerak selesai' : 'Segerak belum berjaya — data selamat pada peranti', { kind: sync.status.phase === 'idle' ? 'ok' : 'error' }));

// ---------- Senarai komitmen ----------
$('category-summary').onclick = e => { const b = e.target.closest('[data-cat]'); if (b) { ui.filter = b.dataset.cat; render(); } };
$('expense-search').oninput = e => { ui.query = e.target.value; render(); };
$('expense-sort').onchange = e => { ui.sort = e.target.value; render(); };
$('expense-empty').onclick = e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'add') openModal();
  if (act === 'seed') loadSeed('Angka asal dimuatkan — ubah ikut keperluan anda');
  if (act === 'clear') { ui.filter = 'Semua'; ui.query = ''; $('expense-search').value = ''; render(); }
};
$('expense-list').onclick = e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const id = b.dataset.id, rec = store.state.expenses.get(id);
  if (!rec) return;
  if (b.dataset.act === 'tick') { ui.pulse = id; setTimeout(() => { if (ui.pulse === id) ui.pulse = null; }, 900); guard(store.updateExpense(id, { paid: !rec.paid })); }
  if (b.dataset.act === 'edit') openModal(id);
  if (b.dataset.act === 'delete') {
    store.deleteExpense(id).then(() => toast(`"${rec.name}" dipadam`, { action: { label: 'Undur', fn: () => guard(store.restoreExpense(id)) } })).catch(fail);
  }
};

// ---------- Borang item ----------
function openModal(id = null) {
  const rec = id ? store.state.expenses.get(id) : null;
  ui.editing = rec ? id : null;
  $('modal-title').textContent = rec ? 'Edit item' : 'Item baru';
  $('expense-name').value = rec?.name ?? '';
  const sel = $('expense-category'), cat = rec?.category ?? 'Lain-lain';
  if (![...sel.options].some(o => o.value === cat)) sel.add(new Option(cat, cat));
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
  if (!name) return err('Sila isi nama item.');
  if (amountRaw === '' || !Number.isFinite(amount) || amount < 0) return err('Sila isi jumlah yang sah (0 atau lebih).');
  if (due !== null && !(Number.isInteger(due) && due >= 1 && due <= 31)) return err('Hari bayar mesti antara 1 hingga 31.');
  const fields = { name, category: $('expense-category').value, amountSen: toSen(amount), dueDay: due };
  btn.disabled = true; btn.textContent = 'Menyimpan…';
  try {
    await (ui.editing ? store.updateExpense(ui.editing, fields) : store.addExpense(fields));
    closeModal();
    toast(ui.editing ? 'Item dikemas kini' : 'Item ditambah', { kind: 'ok', ms: 2500 });
  } catch (ex) { err(`Gagal simpan: ${ex.message}. Cuba lagi.`); }
  finally { btn.disabled = false; btn.textContent = 'Simpan item'; }
};
$('add-expense').onclick = () => openModal();
$('close-modal').onclick = closeModal;
$('cancel-modal').onclick = closeModal;
$('modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };

// ---------- Tetapan (auto-simpan dengan debounce) ----------
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
// Jangan hilang taipan terakhir bila app ditutup/disorok.
const flushAll = () => Object.values(savers).forEach(s => { if (s.dirty) s.flush(); });
addEventListener('pagehide', flushAll);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });

// ---------- Navigasi tab (setiap bahagian satu halaman) ----------
const TABS = ['utama', 'komitmen', 'jadual', 'rutin', 'data'];
const nav = $('section-nav'), navInd = nav.querySelector('.nav-ind');
const navLinks = [...nav.querySelectorAll('a[data-tab]')];
const views = [...document.querySelectorAll('.view')];
let curTab = null;
function moveIndicator() {
  const a = navLinks.find(l => l.dataset.tab === curTab);
  if (!a) return;
  navInd.style.setProperty('--x', `${a.offsetLeft}px`);
  navInd.style.setProperty('--w', `${a.offsetWidth}px`);
  if (!navInd.classList.contains('ready')) requestAnimationFrame(() => navInd.classList.add('ready'));
}
// Ulang animasi skor/baki bila kembali ke halaman Utama.
function replayHome() {
  const bars = ['health-arc', 'hb-savings', 'hb-burden', 'hb-paid', 'balance-bar'].map($);
  bars.forEach(el => { el.style.transition = 'none'; });
  $('health-arc').style.strokeDashoffset = 251.2;
  bars.slice(1).forEach(el => { el.style.width = '0%'; });
  void $('health-arc').getBoundingClientRect();
  requestAnimationFrame(() => {
    bars.forEach(el => { el.style.transition = ''; });
    if (curTab !== 'utama') return;
    ui.replay = true; render(); ui.replay = false;
  });
}
function showTab(tab) {
  if (!TABS.includes(tab)) tab = 'utama';
  if (tab === curTab) return;
  const dir = curTab ? (TABS.indexOf(tab) > TABS.indexOf(curTab) ? 'fwd' : 'back') : '';
  curTab = tab;
  views.forEach(v => {
    const on = v.dataset.tab === tab;
    v.hidden = !on;
    v.classList.remove('entering', 'dir-fwd', 'dir-back');
    clearTimeout(v._t);
    if (on) {
      void v.offsetWidth;
      v.classList.add('entering');
      if (dir) v.classList.add(`dir-${dir}`);
      v._t = setTimeout(() => v.classList.remove('entering'), 1500);
    }
  });
  navLinks.forEach(a => (a.dataset.tab === tab ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  moveIndicator();
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (tab === 'utama' && dir && store.state.ready) replayHome();
}
document.querySelectorAll('[data-go]').forEach(b => { b.onclick = () => { location.hash = b.dataset.go; }; });
addEventListener('hashchange', () => showTab(location.hash.slice(1)));
addEventListener('resize', moveIndicator);
if (document.fonts?.ready) document.fonts.ready.then(moveIndicator);

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
      toast(sync.status.phase === 'idle' ? 'Dikemas kini dari awan' : 'Tak dapat hubungi awan — data peranti dipaparkan', { kind: sync.status.phase === 'idle' ? 'ok' : 'info', ms: 2500 });
    }
    ind.style.transform = ''; ind.style.opacity = '0'; ind.classList.remove('loading');
  });
})();

// ---------- Permulaan ----------
const monthLabel = new Date().toLocaleString('ms-MY', { month: 'long', year: 'numeric' });
$('hero-month').textContent = monthLabel;
$('tl-month-label').textContent = monthLabel;
$('app-version').textContent = APP_VERSION;

store.subscribe(type => (type === 'status' ? renderStatus() : render()));
sync.subscribe((type, detail) => {
  if (type === 'conflict') toast(`${detail} perubahan dari peranti lain lebih baharu. Versi peranti ini disimpan dalam "Salinan pemulihan".`, { ms: 9000 });
  renderStatus(); renderDataPanel();
});
addEventListener('online', renderStatus);
addEventListener('offline', renderStatus);

// Tab lain menulis? Baca semula supaya tab ini tak memaparkan data lapuk.
let bc = null;
try { bc = new BroadcastChannel('ruang-bajet'); bc.onmessage = () => store.reload(); } catch { /* tak disokong */ }
store.subscribe(type => { if (type === 'written' && bc) bc.postMessage('written'); });

function showBanner() {
  const st = store.state, b = $('banner');
  const msgs = [];
  if (!st.storageOk) msgs.push(`<b>Storan peranti tidak tersedia.</b> Perubahan TIDAK akan disimpan (${esc(st.fatal?.message || 'ralat storan')}). Tutup mod Private/Incognito atau guna pelayar lain.`);
  if (st.legacyCorrupt) msgs.push('<b>Data lama tidak dapat dibaca.</b> Ia tidak dipadam — salinan asal ada di bahagian <a href="#data">Data</a> untuk dimuat turun.');
  b.hidden = !msgs.length;
  b.innerHTML = msgs.join('<br>');
}

store.init().then(() => {
  document.body.classList.remove('is-loading');
  showBanner();
  showTab(location.hash.slice(1));
  render();
  setTimeout(() => $('splash')?.classList.add('hide'), 250);
  setTimeout(() => $('splash')?.remove(), 900);
  if (store.state.storageOk) sync.start();
});

if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(e => console.warn('[sw]', e)));

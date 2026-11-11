import { t } from './i18n.js';
// Perkhidmatan data: satu-satunya tempat yang membaca/menulis rekod.
// UI -> store (memori) -> IndexedDB (utama) -> outbox -> sync.js (Firebase, pilihan).
import { tx, all, openDb } from './db.js';
import { now, uid, normalizeExpense, fromLegacy, APP_VERSION, SCHEMA_VERSION } from './utils.js';

const LEGACY_KEY = 'ruang-bajet'; // localStorage versi lama — dibaca sahaja, TIDAK dipadam
const STORES = ['expenses', 'settings', 'outbox', 'snapshots'];
const SYNCED_KEYS = ['incomeSen', 'targetSen', 'commute'];
const MAX_SNAPSHOTS = 15;

export const DEFAULTS = {
  incomeSen: 0, targetSen: 0,
  commute: { distance: 0, days: 0, efficiency: 15, fuelPriceSen: 0, roundTrip: true },
};
// Angka asal (titik mula). Hanya dimuatkan bila pengguna sendiri memilihnya.
export const SEED = {
  income: 1100, target: 200,
  commute: { distance: 13, days: 22, efficiency: 15, fuelPrice: 2.05, roundTrip: true },
  expenses: [['Rumah sewa Cheras', 'Rumah', 83, false, 1], ['Rumah Sewa Pasir Gudang', 'Rumah', 210, false, 1],
    ['Atome', 'BNPL', 6.6, false, 5], ['Shopee BNPL', 'BNPL', 44, false, 10], ['Hotlink', 'Internet', 73, false, 15],
    ['U Mobile', 'Internet', 28, false, 18], ['YouTube Premium', 'Internet', 13, false, 20],
    ['iCloud', 'Internet', 12, false, 22], ['Claude AI', 'AI', 100, false, 25]],
};

export const state = {
  ready: false, storageOk: true, fatal: null, legacyCorrupt: false,
  expenses: new Map(), settings: new Map(), pending: new Set(),
  local: { state: 'idle', error: null, retry: null },
};

const listeners = new Set();
export const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (type, detail) => listeners.forEach(fn => { try { fn(type, detail); } catch (e) { console.error(e); } });
const setLocal = (s, error = null, retry = null) => { state.local = { state: s, error, retry }; emit('status'); };

// ---------- Bacaan ----------
export const liveExpenses = () =>
  [...state.expenses.values()].filter(e => !e.deleted).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
export const getSetting = key => (state.settings.has(key) ? state.settings.get(key).value : DEFAULTS[key]);
export const hasAnyData = () => liveExpenses().length > 0 || SYNCED_KEYS.some(k => state.settings.has(k));

export function exportData() {
  return {
    app: 'ruang-bajet', kind: 'backup', appVersion: APP_VERSION, schemaVersion: SCHEMA_VERSION,
    exportedAt: now(), expenses: liveExpenses(),
    settings: SYNCED_KEYS.filter(k => state.settings.has(k)).map(k => state.settings.get(k)),
  };
}

// ---------- Permulaan & migrasi ----------
export async function init() {
  try {
    await openDb();
    const [ex, st, ob] = await Promise.all([all('expenses'), all('settings'), all('outbox')]);
    ex.forEach(r => state.expenses.set(r.id, r));
    st.forEach(r => state.settings.set(r.key, r));
    ob.forEach(o => state.pending.add(o.key));
    await migrateLocalLegacy();
  } catch (e) {
    // Storan gagal: JANGAN ganti apa-apa. Papar data lama (jika ada) dalam memori supaya pengguna masih nampak rekodnya.
    console.error('[store] init gagal', e);
    state.storageOk = false; state.fatal = e;
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (raw && !state.expenses.size) {
        const conv = fromLegacy(JSON.parse(raw));
        conv.expenses.forEach(r => state.expenses.set(r.id, r));
        conv.settings.forEach(r => state.settings.set(r.key, r));
      }
    } catch { /* tiada apa boleh dipapar */ }
  }
  state.ready = true;
  emit('ready');
}

async function migrateLocalLegacy() {
  if (state.settings.has('_migratedV1')) return;
  let raw = null;
  try { raw = localStorage.getItem(LEGACY_KEY); } catch { /* localStorage disekat */ }
  if (raw == null) return;
  let conv;
  try { conv = fromLegacy(JSON.parse(raw)); } catch (e) {
    // Data lama rosak: simpan salinan asal untuk pemulihan, jangan ganti dengan data kosong/contoh.
    console.error('[store] data lama tak terbaca', e);
    state.legacyCorrupt = true;
    if (!state.settings.has('_legacyCorruptSaved')) {
      const flag = { key: '_legacyCorruptSaved', value: true, updatedAt: now() };
      await tx(['snapshots', 'settings'], 'readwrite', s => {
        s.snapshots.add({ createdAt: now(), reason: 'data-lama-tak-terbaca', raw });
        s.settings.put(flag);
      });
      state.settings.set(flag.key, flag);
    }
    return;
  }
  await adopt(conv, 'localStorage', raw);
}

// Terima data format lama (dari localStorage atau Firebase lama) ke dalam IndexedDB — sekali sahaja, atomik.
async function adopt(conv, source, raw) {
  if (state.settings.has('_migratedV1') || hasAnyData()) return false;
  const flag = { key: '_migratedV1', updatedAt: now(), value: { at: now(), source, count: conv.expenses.length } };
  await tx(STORES, 'readwrite', s => {
    s.snapshots.add({ createdAt: now(), reason: 'pra-migrasi', raw });
    conv.expenses.forEach(r => putExp(s, r));
    conv.settings.forEach(r => putSet(s, r));
    s.settings.put(flag);
  });
  conv.expenses.forEach(memExp);
  conv.settings.forEach(memSet);
  state.settings.set(flag.key, flag);
  emit('change');
  return true;
}
export const adoptRemoteLegacy = obj => adopt(fromLegacy(obj), 'firebase', JSON.stringify(obj));

// ---------- Penulisan ----------
const obKey = (type, id) => `${type}:${id}`;
const putExp = (s, r) => { s.expenses.put(r); s.outbox.put({ key: obKey('expense', r.id), type: 'expense', id: r.id, queuedAt: now() }); };
const putSet = (s, r) => {
  s.settings.put(r);
  if (SYNCED_KEYS.includes(r.key)) s.outbox.put({ key: obKey('setting', r.key), type: 'setting', id: r.key, queuedAt: now() });
};
const memExp = r => { state.expenses.set(r.id, r); state.pending.add(obKey('expense', r.id)); };
const memSet = r => { state.settings.set(r.key, r); if (SYNCED_KEYS.includes(r.key)) state.pending.add(obKey('setting', r.key)); };
// Cap masa sentiasa meningkat walaupun jam peranti berundur.
const after = prev => { const t = now(); return !prev || t > prev ? t : new Date(Date.parse(prev) + 1).toISOString(); };

let chain = Promise.resolve();
let persistAsked = false;
// Susun operasi supaya gabungan sync tak bertembung dengan tulisan pengguna.
const serial = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
// Semua tulisan bersiri melalui sini. Memori hanya dikemas kini SELEPAS transaksi commit.
function commit(build) {
  const run = async () => {
    setLocal('saving');
    try {
      const today = new Date().toDateString();
      const snapDue = state.settings.get('_lastAutoSnap')?.value !== today && liveExpenses().length > 0;
      const snapFlag = { key: '_lastAutoSnap', value: today, updatedAt: now() };
      let apply, result;
      await tx(STORES, 'readwrite', s => {
        if (snapDue) { s.snapshots.add({ createdAt: now(), reason: 'auto-harian', auto: true, data: exportData() }); s.settings.put(snapFlag); }
        apply = build(s);
      });
      if (snapDue) state.settings.set(snapFlag.key, snapFlag);
      if (apply) result = apply();
      setLocal('idle');
      emit('change'); emit('written');
      if (!persistAsked) { persistAsked = true; askPersist(); }
      pruneSnapshots();
      return result;
    } catch (e) {
      console.error('[store] simpan gagal', e);
      setLocal('error', e, () => commit(build));
      throw e;
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

export function addExpense(fields) {
  const ts = now();
  const rec = normalizeExpense({ ...fields, id: uid(), paid: false, createdAt: ts, updatedAt: ts });
  if (!rec) return Promise.reject(new Error(t('err.invalidItem')));
  return commit(s => { putExp(s, rec); return () => { memExp(rec); return rec; }; });
}
export function updateExpense(id, patch) {
  return commit(s => {
    const cur = state.expenses.get(id);
    if (!cur) throw new Error(t('err.notFound'));
    const rec = normalizeExpense({ ...cur, ...patch, id, updatedAt: after(cur.updatedAt) });
    if (!rec) throw new Error(t('err.invalidItem'));
    putExp(s, rec);
    return () => { memExp(rec); return rec; };
  });
}
export const deleteExpense = id => updateExpense(id, { deleted: true }); // "tombstone" — boleh diundur & disegerak
export const restoreExpense = id => updateExpense(id, { deleted: false });

export function setSetting(key, value) {
  return commit(s => {
    const rec = { key, value, updatedAt: after(state.settings.get(key)?.updatedAt) };
    putSet(s, rec);
    return () => memSet(rec);
  });
}
async function setLocalMeta(key, value) {
  const rec = { key, value, updatedAt: now() };
  await tx('settings', 'readwrite', s => s.settings.put(rec));
  state.settings.set(key, rec);
  emit('change');
}
// Salinan pemulihan manual (data semasa disimpan sebagai snapshot tanpa mengubah rekod).
export const createSnapshot = () => commit(s => { s.snapshots.add({ createdAt: now(), reason: 'manual', data: exportData() }); return () => {}; });
export const markBackup = () => setLocalMeta('_lastBackupAt', now());

// Ganti SEMUA data (import-ganti / pulih salinan / set semula). Salinan semasa disimpan dahulu.
export function replaceAll(data, reason) {
  return commit(s => {
    s.snapshots.add({ createdAt: now(), reason, data: exportData() });
    const keep = new Set(data.expenses.map(e => e.id));
    const exp = [];
    for (const cur of liveExpenses()) if (!keep.has(cur.id)) exp.push({ ...cur, deleted: true, updatedAt: after(cur.updatedAt) });
    for (const e of data.expenses) { const r = { ...e, updatedAt: after(state.expenses.get(e.id)?.updatedAt) }; delete r.deleted; exp.push(r); }
    const incoming = new Map((data.settings || []).map(r => [r.key, r.value]));
    const sets = SYNCED_KEYS.map(k => ({ key: k, value: incoming.has(k) ? incoming.get(k) : DEFAULTS[k], updatedAt: after(state.settings.get(k)?.updatedAt) }));
    exp.forEach(r => putExp(s, r)); sets.forEach(r => putSet(s, r));
    return () => { exp.forEach(memExp); sets.forEach(memSet); };
  });
}

const contentKey = e => [e.name.toLowerCase(), e.category.toLowerCase(), e.amountSen, e.dueDay ?? ''].join('|');
// Rancang gabungan import tanpa menulis apa-apa — dipakai untuk pratonton DAN pelaksanaan.
export function planMerge(data) {
  const stats = { total: data.expenses.length, added: 0, updated: 0, restored: 0, duplicates: 0, unchanged: 0, settings: 0 };
  const puts = [], sets = [];
  const seen = new Set(liveExpenses().map(contentKey));
  for (const e of data.expenses) {
    const cur = state.expenses.get(e.id);
    if (!cur) {
      if (seen.has(contentKey(e))) { stats.duplicates++; continue; }
      seen.add(contentKey(e)); puts.push(e); stats.added++;
    } else if (cur.deleted) { puts.push({ ...e, updatedAt: after(cur.updatedAt) }); stats.restored++; }
    else if (e.updatedAt > cur.updatedAt) { puts.push(e); stats.updated++; }
    else stats.unchanged++;
  }
  for (const r of data.settings || []) {
    const cur = state.settings.get(r.key);
    if (SYNCED_KEYS.includes(r.key) && (!cur || r.updatedAt > cur.updatedAt)) { sets.push(r); stats.settings++; }
  }
  return { stats, puts, sets };
}
export function mergeImport(data) {
  return commit(s => {
    const { stats, puts, sets } = planMerge(data);
    s.snapshots.add({ createdAt: now(), reason: 'pra-import-gabung', data: exportData() });
    puts.forEach(r => putExp(s, r)); sets.forEach(r => putSet(s, r));
    return () => { puts.forEach(memExp); sets.forEach(memSet); return stats; };
  });
}

// ---------- Salinan pemulihan ----------
export async function listSnapshots() {
  const rows = await all('snapshots');
  return rows.sort((a, b) => b.id - a.id).map(r => ({
    id: r.id, createdAt: r.createdAt, reason: r.reason, raw: r.raw != null, partial: !!r.partial,
    count: r.data ? r.data.expenses.length : null,
  }));
}
export async function getSnapshot(id) { return (await all('snapshots')).find(r => r.id === id) || null; }
export async function restoreSnapshot(id) {
  const snap = await getSnapshot(id);
  if (!snap) throw new Error(t('err.snapNotFound'));
  if (snap.partial) { // salinan konflik: pulihkan rekod terlibat sahaja
    return commit(s => {
      const recs = snap.data.expenses.map(e => ({ ...e, updatedAt: after(state.expenses.get(e.id)?.updatedAt) }));
      recs.forEach(r => putExp(s, r));
      return () => recs.forEach(memExp);
    });
  }
  const data = snap.raw != null ? fromLegacy(JSON.parse(snap.raw)) : snap.data;
  return replaceAll(data, 'pra-pulih');
}
async function pruneSnapshots() {
  try {
    const rows = (await all('snapshots')).filter(r => r.raw == null).sort((a, b) => a.id - b.id);
    const extra = rows.slice(0, Math.max(0, rows.length - MAX_SNAPSHOTS));
    if (extra.length) await tx('snapshots', 'readwrite', s => extra.forEach(r => s.snapshots.delete(r.id)));
  } catch (e) { console.warn('[store] prune', e); }
}

// ---------- Sokongan sync ----------
export function pendingItems() {
  const items = [];
  for (const key of state.pending) {
    const i = key.indexOf(':'), type = key.slice(0, i), id = key.slice(i + 1);
    const r = type === 'expense' ? state.expenses.get(id) : state.settings.get(id);
    if (!r) continue;
    items.push(type === 'expense'
      ? { key, path: `expenses/${id}`, value: r, updatedAt: r.updatedAt }
      : { key, path: `settings/${id}`, value: { value: r.value, updatedAt: r.updatedAt }, updatedAt: r.updatedAt });
  }
  return items;
}
// Buang dari baris gilir hanya jika rekod tak berubah sejak dihantar.
export const markSynced = items => serial(() => doMarkSynced(items));
async function doMarkSynced(items) {
  const done = items.filter(i => {
    const idx = i.key.indexOf(':'), id = i.key.slice(idx + 1);
    const r = i.key.startsWith('expense:') ? state.expenses.get(id) : state.settings.get(id);
    return r && r.updatedAt === i.updatedAt;
  });
  if (done.length) {
    await tx('outbox', 'readwrite', s => done.forEach(i => s.outbox.delete(i.key)));
    done.forEach(i => state.pending.delete(i.key));
  }
  await setLocalMeta('_lastSyncedAt', now());
}

// Gabung data jauh ke tempatan. Rekod lebih baharu menang; versi tempatan yang kalah disimpan sebagai salinan konflik.
export const mergeRemote = (rex, rset) => serial(() => doMergeRemote(rex || {}, rset || {}));
async function doMergeRemote(rex, rset) {
  const puts = [], sets = [], drop = [], queue = [], conflicts = [];
  for (const [id, raw] of Object.entries(rex)) {
    const r = normalizeExpense({ ...raw, id });
    if (!r) continue;
    const l = state.expenses.get(id), key = obKey('expense', id), pend = state.pending.has(key);
    if (!l) puts.push(r);
    else if (r.updatedAt > l.updatedAt) { if (pend) { conflicts.push(l); drop.push(key); } puts.push(r); }
    else if (r.updatedAt < l.updatedAt && !pend) queue.push({ key, type: 'expense', id });
  }
  for (const l of state.expenses.values()) {
    const key = obKey('expense', l.id);
    if (!(l.id in rex) && !state.pending.has(key)) queue.push({ key, type: 'expense', id: l.id });
  }
  for (const k of SYNCED_KEYS) {
    const r = rset[k], l = state.settings.get(k), key = obKey('setting', k), pend = state.pending.has(key);
    if (r && typeof r.updatedAt === 'string' && r.value !== undefined) {
      if (!l || r.updatedAt > l.updatedAt) { if (l && pend) drop.push(key); sets.push({ key: k, value: r.value, updatedAt: r.updatedAt }); }
      else if (r.updatedAt < l.updatedAt && !pend) queue.push({ key, type: 'setting', id: k });
    } else if (l && !pend) queue.push({ key, type: 'setting', id: k });
  }
  if (!(puts.length || sets.length || drop.length || queue.length)) return { changed: 0, conflicts: 0 };
  await tx(STORES, 'readwrite', s => {
    if (conflicts.length) s.snapshots.add({ createdAt: now(), reason: 'konflik-sync', partial: true, data: { expenses: conflicts, settings: [] } });
    puts.forEach(r => s.expenses.put(r));
    sets.forEach(r => s.settings.put(r));
    drop.forEach(k => s.outbox.delete(k));
    queue.forEach(q => s.outbox.put({ ...q, queuedAt: now() }));
  });
  puts.forEach(r => state.expenses.set(r.id, r));
  sets.forEach(r => state.settings.set(r.key, r));
  drop.forEach(k => state.pending.delete(k));
  queue.forEach(q => state.pending.add(q.key));
  emit('change');
  return { changed: puts.length + sets.length, conflicts: conflicts.length };
}

// ---------- Perlindungan storan pelayar ----------
async function askPersist() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* tak disokong */ }
  emit('change');
}
export async function storageInfo() {
  const out = { persisted: null, usage: null, quota: null };
  try {
    if (navigator.storage?.persisted) out.persisted = await navigator.storage.persisted();
    if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); out.usage = e.usage; out.quota = e.quota; }
  } catch { /* tak disokong */ }
  return out;
}

// Baca semula dari IndexedDB (dipanggil bila tab lain menulis).
export const reload = () => serial(async () => {
  const [ex, st, ob] = await Promise.all([all('expenses'), all('settings'), all('outbox')]);
  state.expenses = new Map(ex.map(r => [r.id, r]));
  state.settings = new Map(st.map(r => [r.key, r]));
  state.pending = new Set(ob.map(o => o.key));
  emit('change');
});

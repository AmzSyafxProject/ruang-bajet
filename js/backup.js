// Eksport / import sandaran JSON.
import { SCHEMA_VERSION, normalizeExpense, fromLegacy } from './utils.js';
import { exportData, markBackup } from './store.js';

const pad = n => String(n).padStart(2, '0');

export async function exportBackup() {
  const data = exportData();
  const d = new Date();
  const name = `ruang-bajet-sandaran-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  downloadText(JSON.stringify(data, null, 2), name);
  await markBackup();
  return { name, count: data.expenses.length };
}

export function downloadText(text, name, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Sahkan fail sandaran. Lontar Error dengan mesej mesra pengguna jika tak sah. Tidak menulis apa-apa.
export function parseBackup(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('Fail bukan JSON yang sah.'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Struktur fail tidak dikenali.');

  // Format lama (v1) — tukar dahulu.
  if (obj.schemaVersion == null && obj.expenses && ('income' in obj || 'target' in obj)) {
    const conv = fromLegacy(obj);
    return { ...conv, meta: { schemaVersion: 1, exportedAt: null, appVersion: null, legacy: true } };
  }
  if (obj.app !== 'ruang-bajet') throw new Error('Fail ini bukan sandaran Ruang Bajet.');
  if (!Number.isInteger(obj.schemaVersion)) throw new Error('Versi skema tiada dalam fail.');
  if (obj.schemaVersion > SCHEMA_VERSION) throw new Error(`Sandaran dari versi lebih baharu (skema ${obj.schemaVersion}). Kemas kini aplikasi dahulu.`);
  if (!Array.isArray(obj.expenses)) throw new Error('Senarai rekod tiada dalam fail.');

  const expenses = obj.expenses.map(normalizeExpense);
  const bad = expenses.filter(e => !e).length;
  if (bad) throw new Error(`${bad} rekod dalam fail tidak sah — import dibatalkan supaya tiada data rosak masuk.`);
  const ids = new Set(expenses.map(e => e.id));
  if (ids.size !== expenses.length) throw new Error('Fail mengandungi ID rekod berulang.');

  const settings = (Array.isArray(obj.settings) ? obj.settings : [])
    .filter(r => r && typeof r.key === 'string' && typeof r.updatedAt === 'string' && r.value !== undefined);
  return {
    expenses: expenses.filter(e => !e.deleted), settings,
    meta: { schemaVersion: obj.schemaVersion, exportedAt: obj.exportedAt || null, appVersion: obj.appVersion || null, legacy: false },
  };
}

// Utiliti kecil yang dikongsi semua modul.
import { t, moneyFmt, fmtDateTimeL } from './i18n.js';
export const APP_VERSION = '3.0.0';
export const SCHEMA_VERSION = 2;

// Wang disimpan sebagai integer sen supaya tiada ralat titik apung.
export const toSen = v => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
let rm = null, rmLang = '';
export const fmt = sen => { const l = document.documentElement.lang; if (!rm || rmLang !== l) { rm = moneyFmt(); rmLang = l; } return rm.format((Number(sen) || 0) / 100); };
export const senToInput = sen => (sen ? String(sen / 100) : '');

export const now = () => new Date().toISOString();
export const uid = () =>
  crypto.randomUUID
    ? crypto.randomUUID()
    : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
        (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

export const fmtDateTime = fmtDateTimeL;

export const debounce = (fn, ms) => {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); return fn(...a); };
  return d;
};

export const withTimeout = (p, ms, label = 'Operation') =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(t('err.timeout', { op: label }))), ms))]);

// Sahkan & normalkan satu rekod komitmen. Pulangkan null jika tak sah.
export function normalizeExpense(r) {
  if (!r || typeof r !== 'object') return null;
  const name = String(r.name ?? '').trim().slice(0, 80);
  const amountSen = Math.round(Number(r.amountSen));
  const due = r.dueDay == null || r.dueDay === '' ? null : Math.round(Number(r.dueDay));
  if (typeof r.id !== 'string' || !r.id || !name) return null;
  if (!Number.isFinite(amountSen) || amountSen < 0) return null;
  if (due !== null && !(due >= 1 && due <= 31)) return null;
  const out = {
    id: r.id, name,
    category: String(r.category ?? 'Lain-lain').trim().slice(0, 40) || 'Lain-lain',
    amountSen, paid: !!r.paid, dueDay: due,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : now(),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : now(),
  };
  if (r.deleted) out.deleted = true;
  return out;
}

// Tukar format lama (v1: {income, expenses:[[nama,kategori,jumlah,paid,hari]], commute, target}) ke skema v2.
export function fromLegacy(obj) {
  if (!obj || typeof obj !== 'object') throw new Error(t('err.legacyFormat'));
  const rows = Array.isArray(obj.expenses) ? obj.expenses : Object.values(obj.expenses || {});
  const base = Date.now();
  const expenses = rows.filter(Boolean).map((e, i) => {
    const ts = new Date(base + i).toISOString();
    return normalizeExpense({
      id: uid(), name: String(e[0] ?? '').trim() || 'Tanpa nama', category: e[1],
      amountSen: Math.max(0, toSen(e[2])), paid: !!e[3],
      dueDay: e[4] >= 1 && e[4] <= 31 ? e[4] : null, createdAt: ts, updatedAt: ts,
    });
  });
  if (expenses.some(e => !e)) throw new Error(t('err.legacyRecord'));
  const c = obj.commute || {};
  const ts = now();
  const settings = [
    { key: 'incomeSen', value: Math.max(0, toSen(obj.income)), updatedAt: ts },
    { key: 'targetSen', value: Math.max(0, toSen(obj.target)), updatedAt: ts },
    { key: 'commute', updatedAt: ts, value: {
        distance: Number(c.distance) || 0, days: Number(c.days) || 0,
        efficiency: Number(c.efficiency) || 15, fuelPriceSen: Math.max(0, toSen(c.fuelPrice)),
        roundTrip: c.roundTrip !== false } },
  ];
  return { expenses, settings };
}

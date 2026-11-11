// i18n: satu bahasa aktif pada satu masa. Kunci berpusat dalam locales/{ms,en}.json.
// Tiada import — supaya semua modul lain boleh guna t() tanpa kitaran.
export const LANGS = ['ms', 'en'];
const LOCALE = { ms: 'ms-MY', en: 'en-MY' };
const dict = {};
let lang = 'ms';

const read = k => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storan tak tersedia */ } };

export const getLang = () => lang;
export const locale = () => LOCALE[lang];
export function savedLang() { const v = read('rb-lang'); return LANGS.includes(v) ? v : 'ms'; }

async function fetchDict(l) {
  if (dict[l]) return dict[l];
  const res = await fetch(new URL(`../locales/${l}.json`, import.meta.url), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`locale ${l}: ${res.status}`);
  return (dict[l] = await res.json());
}

// Muat bahasa (kamus BM sentiasa dimuat sebagai sandaran kunci hilang).
export async function loadLang(l = savedLang()) {
  if (!LANGS.includes(l)) l = 'ms';
  await Promise.all([fetchDict('ms'), l === 'ms' ? null : fetchDict(l)]);
  lang = l;
  document.documentElement.lang = l;
  return l;
}
export async function setLang(l) { await loadLang(l); write('rb-lang', lang); applyI18n(); document.dispatchEvent(new CustomEvent('langchange')); }

const lookup = (d, key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), d);
export function t(key, params) {
  let s = lookup(dict[lang] || {}, key);
  if (typeof s !== 'string') s = lookup(dict.ms || {}, key);
  if (typeof s !== 'string') return key;
  return params ? s.replace(/\{(\w+)\}/g, (m, k) => (params[k] ?? m)) : s;
}

// data-i18n="kunci" (teks) · data-i18n-html="kunci" (HTML dipercayai dari kamus) · data-i18n-attr="aria-label:kunci;placeholder:kunci"
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll('[data-i18n-attr]').forEach(el => {
    el.dataset.i18nAttr.split(';').forEach(p => { const [a, k] = p.split(':'); if (a && k) el.setAttribute(a.trim(), t(k.trim())); });
  });
  document.title = t('meta.title');
}

// Format tarikh/nombor ikut bahasa aktif. ms: DD/MM/YYYY · en: DD MMM YYYY.
export function fmtDate(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return '—';
  return lang === 'ms'
    ? x.toLocaleDateString('ms-MY', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : x.toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' });
}
export function fmtDateTimeL(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${fmtDate(d)}, ${d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}`;
}
export const monthName = (d, style = 'long') => d.toLocaleString(locale(), { month: style });
export const monthYear = d => d.toLocaleString(locale(), { month: 'long', year: 'numeric' });
export const moneyFmt = () => new Intl.NumberFormat(locale(), { style: 'currency', currency: 'MYR' });

// Kategori disimpan sebagai nilai BM dalam data (tak diubah); paparan sahaja diterjemah.
const CAT = { Rumah: 'rumah', BNPL: 'bnpl', Internet: 'internet', AI: 'ai', Pengangkutan: 'transport', 'Lain-lain': 'other' };
export const catLabel = c => (CAT[c] ? t(`cat.${CAT[c]}`) : c);
export const CATEGORIES = Object.keys(CAT);

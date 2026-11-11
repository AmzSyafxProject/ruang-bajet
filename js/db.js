// Lapisan IndexedDB. Setiap tulisan hanya dianggap berjaya selepas transaksi `oncomplete`.
const NAME = 'ruang-bajet';
const VERSION = 1; // naikkan nombor ini + tambah blok `if (old < n)` untuk perubahan skema akan datang

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('IndexedDB tidak disokong pelayar ini'));
    let req;
    try { req = indexedDB.open(NAME, VERSION); } catch (e) { return reject(e); }
    req.onupgradeneeded = e => {
      const db = req.result;
      // Naik taraf bertingkat: hanya TAMBAH stor/indeks, jangan sekali-kali padam stor sedia ada.
      if (e.oldVersion < 1) {
        db.createObjectStore('expenses', { keyPath: 'id' });
        db.createObjectStore('settings', { keyPath: 'key' });
        db.createObjectStore('outbox', { keyPath: 'key' });     // baris gilir sync
        db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true }); // salinan pemulihan
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('Gagal membuka pangkalan data'));
    req.onblocked = () => reject(new Error('Pangkalan data disekat oleh tab lain'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

// Jalankan fn(stores) dalam satu transaksi atomik. Resolve hanya selepas commit.
export async function tx(stores, mode, fn) {
  const db = await openDb();
  const names = [].concat(stores);
  return new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(names, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
    } catch (e) { return reject(e); }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error || new Error('Ralat transaksi'));
    t.onabort = () => reject(t.error || new Error('Transaksi dibatalkan'));
    try {
      fn(Object.fromEntries(names.map(n => [n, t.objectStore(n)])));
    } catch (e) {
      try { t.abort(); } catch { /* sudah dibatalkan */ }
      reject(e);
    }
  });
}

export async function all(store) {
  let req;
  await tx(store, 'readonly', s => { req = s[store].getAll(); });
  return req.result;
}

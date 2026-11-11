// Sync awan PILIHAN (Firebase Realtime Database). Aplikasi berfungsi penuh tanpanya.
// Firebase dimuat secara dinamik: jika CDN gagal/luar talian, data tempatan tetap berjalan.
import * as store from './store.js';
import { withTimeout, now } from './utils.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';
const config = {
  apiKey: 'AIzaSyD5lPwyOJKy08uqNF0udYVDKqnGuj9xnzY', authDomain: 'ruang-bajet.firebaseapp.com',
  databaseURL: 'https://ruang-bajet-default-rtdb.asia-southeast1.firebasedatabase.app', projectId: 'ruang-bajet',
  storageBucket: 'ruang-bajet.firebasestorage.app', messagingSenderId: '372842407002',
  appId: '1:372842407002:web:b0302b4f0c97e4b0f46463', measurementId: 'G-E2G6FRVTEN',
};
const TIMEOUT = 15000;
const BACKOFF = [5000, 15000, 60000];

// phase: 'off' | 'connecting' | 'idle' | 'syncing' | 'error' | 'unavailable'
export const status = { phase: 'off', error: null, uid: null, lastPullAt: 0 };
const listeners = new Set();
export const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const set = (phase, error = null) => { status.phase = phase; status.error = error; listeners.forEach(fn => fn('status')); };
const notify = (type, detail) => listeners.forEach(fn => fn(type, detail));

let fb = null, userRef = null, starting = null, running = null, again = false, fails = 0, timer = null;

async function connect() {
  if (userRef) return;
  if (!starting) {
    starting = (async () => {
      set('connecting');
      const [app, auth, db] = await withTimeout(Promise.all([
        import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-database.js`),
      ]), TIMEOUT, 'Muat Firebase');
      const fa = app.initializeApp(config);
      const cred = await withTimeout(auth.signInAnonymously(auth.getAuth(fa)), TIMEOUT, 'Log masuk');
      fb = db;
      const database = db.getDatabase(fa);
      status.uid = cred.user.uid;
      userRef = db.ref(database, `users/${cred.user.uid}`);
      // Bila sambungan pulih, cuba hantar apa yang tertunggak.
      db.onValue(db.ref(database, '.info/connected'), snap => { if (snap.val() === true) schedule(0); });
    })().finally(() => { starting = null; });
  }
  await starting;
}

// Tarik -> gabung -> tolak. Satu kitaran pada satu masa.
async function cycle() {
  await connect();
  set('syncing');
  const snap = await withTimeout(fb.get(userRef), TIMEOUT, 'Baca awan');
  const remote = snap.exists() ? snap.val() || {} : {};
  status.lastPullAt = Date.now();

  if (remote.v2) {
    const res = await store.mergeRemote(remote.v2.expenses, remote.v2.settings);
    if (res.conflicts) notify('conflict', res.conflicts);
  } else if (remote.expenses || remote.income != null) {
    // Data awan format lama: guna hanya jika peranti ini benar-benar kosong. Nod lama TIDAK dipadam.
    await store.adoptRemoteLegacy({ income: remote.income, target: remote.target, commute: remote.commute, expenses: remote.expenses });
  }

  const items = store.pendingItems();
  if (items.length) {
    const updates = { 'v2/meta': { schemaVersion: 2, updatedAt: now() } };
    for (const i of items) updates[`v2/${i.path}`] = i.value;
    // update() berbilang laluan: hanya menyentuh v2/*, medan lama kekal sebagai salinan pemulihan.
    await withTimeout(fb.update(userRef, updates), TIMEOUT, 'Tulis awan'); // resolve = pelayan sahkan
    await store.markSynced(items);
  } else if (!store.state.settings.has('_lastSyncedAt') || remote.v2) {
    await store.markSynced([]);
  }
}

export function syncNow() {
  if (!store.state.storageOk) return Promise.resolve();
  if (running) { again = true; return running; }
  clearTimeout(timer);
  running = (async () => {
    try {
      do { again = false; await cycle(); } while (again);
      fails = 0;
      set('idle');
    } catch (e) {
      console.warn('[sync]', e);
      // CDN / rangkaian tiada => "unavailable" (bukan ralat pengguna); selainnya ralat sync sebenar.
      const offline = !navigator.onLine || !userRef;
      set(offline ? 'unavailable' : 'error', e);
      timer = setTimeout(syncNow, BACKOFF[Math.min(fails++, BACKOFF.length - 1)]);
    } finally { running = null; }
  })();
  return running;
}

export function schedule(ms = 900) {
  clearTimeout(timer);
  timer = setTimeout(syncNow, ms);
}

export function start() {
  store.subscribe(type => { if (type === 'written') schedule(); });
  addEventListener('online', () => schedule(0));
  addEventListener('offline', () => set(status.phase === 'idle' ? 'idle' : status.phase));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - status.lastPullAt > 60000) schedule(0);
  });
  schedule(0);
}

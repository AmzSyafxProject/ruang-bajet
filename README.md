# Ruang Bajet

Dashboard kewangan peribadi (HTML/CSS/JS tulen, tiada build step). Dihoskan di GitHub Pages; data pengguna **tidak** disimpan dalam repo ini.

## Seni bina data (v2)

```
UI (app.js) → js/store.js (state + pengesahan) → IndexedDB (storan utama)
                                              ├→ outbox → js/sync.js → Firebase RTDB (pilihan)
                                              ├→ snapshots (salinan pemulihan automatik)
                                              └→ js/backup.js (eksport / import JSON)
```

- **IndexedDB `ruang-bajet`** — stor `expenses`, `settings`, `outbox` (baris gilir sync), `snapshots`.
- Wang disimpan sebagai **integer sen**; setiap rekod ada `id` (UUID), `createdAt`, `updatedAt` (ISO 8601).
- "Disimpan" hanya dipapar selepas transaksi IndexedDB selesai (`oncomplete`) **dan** awan mengesahkan tulisan.
- Padam = *tombstone* (`deleted: true`) supaya boleh diundur dan disegerak.
- Data lama `localStorage["ruang-bajet"]` dimigrasi sekali dan **tidak dipadam**; salinan asal juga disimpan sebagai snapshot `pra-migrasi`.
- Firebase: data baharu di `users/{uid}/v2/…`; nod lama (`income`, `expenses`, …) dikekalkan sebagai salinan.

## Jalankan secara lokal

Perlu pelayan HTTP (ES modules & service worker tak berfungsi melalui `file://`):

```bash
python3 -m http.server 8080   # kemudian buka http://localhost:8080
```

## Deploy ke GitHub Pages

Push ke `main`. Settings → Pages → *Deploy from a branch* → `main` / root. Semua laluan adalah relatif, jadi berfungsi di `/ruang-bajet/`. Jika menambah fail JS baharu, masukkan ke senarai `SHELL` dalam `sw.js` dan naikkan nama `CACHE`.

## Firebase (pilihan)

App berfungsi penuh tanpa Firebase. Untuk sync: Authentication → **Anonymous** dihidupkan, dan Realtime Database Rules mesti menghadkan setiap pengguna kepada datanya sendiri:

```json
{ "rules": { "users": { "$uid": { ".read": "auth != null && auth.uid === $uid", ".write": "auth != null && auth.uid === $uid" } } } }
```

Jangan guna `".read": true` / `".write": true`.

**Had penting:** log masuk tanpa nama terikat pada satu pelayar. Mengosongkan data pelayar, atau membuka app dari pelayar/peranti lain, menghasilkan akaun awan baharu — data awan lama tak boleh dicapai lagi. Untuk pindah peranti guna **Eksport → Import**. Sync berbilang peranti sebenar memerlukan log masuk kekal (cth. Google Sign-In) — belum dilaksanakan.

## Sandaran & pemulihan

- **Eksport**: bahagian *Data* → *Eksport sandaran* → fail `ruang-bajet-sandaran-TARIKH.json`.
- **Import**: *Import sandaran* → pratonton → *Gabung* (tambah/kemas kini, langkau pendua) atau *Ganti semua* (perlu pengesahan; data semasa disimpan dahulu).
- **Salinan automatik**: dibuat sekali sehari dan sebelum import/set semula; tekan *Pulihkan* untuk kembali.

## Penyelesaian masalah

| Simptom | Punca / tindakan |
|---|---|
| "Storan tidak tersedia" | Mod Private/Incognito atau storan disekat. Guna tetingkap biasa. |
| "Gagal simpan" | Tulisan IndexedDB gagal (cth. kuota). Tekan *Cuba lagi*; eksport sandaran. |
| "Sync gagal" | Awan menolak/tak dapat dihubungi. Data selamat pada peranti; semak Rules di atas. |
| "Menunggu sync" berpanjangan | Firebase/CDN disekat rangkaian. App tetap berfungsi secara tempatan. |
| Data "hilang" di telefon | App di skrin utama (PWA) dan Safari/Chrome guna storan berasingan. Buka dari tempat yang sama, atau import sandaran. |
| Paparan lama selepas deploy | Tutup & buka semula app (service worker ambil versi baharu bila dalam talian). |

Versi sebelum naik taraf ditanda dengan git tag `pre-v2-audit`.


## v3.0 — UI/UX redesign (AppShell, tema, bahasa)

- **AppShell**: `<header>` (sticky) + `<main>` + `<nav id="app-nav">` sebagai anak terus `<body>`. Nav `position:fixed` di bawah (<1024px) atau sidebar tetap (≥1024px); tidak berada dalam elemen sticky/bertransform. Padding bawah + `env(safe-area-inset-bottom)` dikhaskan; nav disorok semasa papan kekunci mobile terbuka (`visualViewport`).
- **Tema**: Cerah / Gelap / Ikut sistem (`localStorage rb-theme`, dikenakan sebelum cat pertama oleh skrip kecil di `<head>`).
- **Bahasa**: `locales/ms.json` + `locales/en.json`, `js/i18n.js` (`t()`, `data-i18n`). Lalai BM, disimpan dalam `rb-lang`. Data kewangan & nilai kategori tidak diubah — hanya paparan diterjemah.
- **Tetapan** (`#tetapan`): penampilan, bahasa, nama paparan, storan (eksport/import/salinan pemulihan/kosongkan cache/set semula), sync, mengenai. "Kosongkan cache" hanya memadam Cache Storage + service worker, **bukan** IndexedDB.
- **Gerakan**: token `--motion-*`/`--ease-*`; peralihan halaman 250ms (10px menegak); `prefers-reduced-motion` dihormati.
- Zum/saiz teks tidak lagi dikunci; teks boleh dipilih (hanya butang/nav tak boleh dipilih).
- Ujian: `qa/` (Playwright, 158 semakan: 11 lebar skrin × 6 halaman, kestabilan nav, kebocoran bahasa, tema, gerakan, ketekalan data).

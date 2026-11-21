# Catio: Arsitektur

> Notepad yang ngerti isinya. Satu file teks, satu hotkey, nyambung ke HP.
> Prinsip: **teks adalah sumber kebenaran. App nggak boleh mindahin atau nyembunyiin teks tanpa lo minta.**

---

## 0. Keputusan produk (hasil 2 putaran review)

| Topik | Keputusan |
|---|---|
| File | **Satu file** `catio.md` yang bisa dibuka di Notepad. Hari ditandai dengan pemisah di dalam file, bukan file per hari. |
| Fokus | Semua baris **di atas `---` pertama** adalah fokus. Nomor nggak disimpan dan nggak ditampilin. Baris fokus pertama yang belum dicentang dikasih bar oranye ("sekarang"). |
| Selesai | `[x]` tetap di tempat, dibuat redup. Baru dipindah ke `arsip.md` kalau lo jalanin **Bersihin** (`Ctrl+Shift+⌫`). Auto-bersihin jam 04:00 cuma opsi. |
| Tunda | `[>]`: baris tetap di tempat, redup, dengan label "besok". Jam 04:00 balik jadi `[ ]`. |
| Pengingat | Jam di baris (`15:00`, `jam 3`) memicu **notifikasi Windows dan HP**. Ini janji inti produk. |
| Full screen | Pad yang sama, cuma dimaksimalkan: font lebih besar, kolom maks 680px. **Nggak ada rail atau timeline.** Arsip dan pencarian lewat `Ctrl+K`. |
| Dibuang dari v0/v1 | Baris kalender, lipat bagian, garis bawah buat salin (diganti `Ctrl+C` tanpa seleksi), masking nomor, strip yang punya banyak varian, satuan "h". |
| Satuan | `12 mnt`, `2 hari`. Bahasa Indonesia, ditulis lengkap. `hr` atau `h` bisa kebaca "hour", jadi nggak dipakai. |
| Warna teks | Teks yang punya arti (status, jam, umur, placeholder) minimal kontras 4.5:1 (`p-2`). `p-3` cuma buat teks redup/nonaktif. Oranye kecil pakai `p-accent-text` (#B5441F terang / #F0693F gelap). Link aksi pakai warna tinta + garis bawah, bukan oranye. |
| Kebiasaan Notepad | `Ctrl+S` (muncul "tersimpan"), `Ctrl+F/H`, `Ctrl+A`, `Ctrl+Z/Y`, `Ctrl+±` dan Ctrl+scroll buat zoom, word wrap, paste 10k baris tanpa lag. **Wajib lolos test.** |

---

## 1. Format file (kontrak antar device)

```md
[ ] kelarin proposal Q1
[ ] call dokter 15:00
[x] transfer DP venue
---
pricing tetap 49rb/bln
rek Dina BCA 123 456 7890
[ ] beli kabel HDMI
[>] cek ongkir
[ ] balas pak Rudi

meeting klien:
	budget 40jt, termin 2x
```

- `[ ]` / `[x]` / `[>]`: buka, selesai, tunda. Ketik `[]` langsung dinormalisasi jadi `[ ]`.
- `---` pertama: batas zona fokus. Kalau nggak ada `---`, berarti nggak ada fokus.
- Jam: `HH:MM` atau `jam N` di dalam baris. Teksnya tetap ditulis, nggak dihapus.
- Umur tugas **nggak disimpan** di file. Dihitung dari riwayat, dan disembunyiin kalau riwayatnya nggak ada.
- Hal-hal yang cuma soal tampilan (posisi jendela, zoom) disimpan di `.catio/state.json`, nggak pernah di `.md`.
- `arsip.md`: append-only, dikelompokkan per tanggal `## 2026-11-21`.

Parser-nya **satu modul TypeScript murni** (`packages/core`): baris masuk, token keluar. Modul yang sama dipakai di desktop, HP, dan penjadwal pengingat, jadi perilakunya identik di semua tempat.

---

## 2. Stack

```
┌──────────────────────── Desktop (Windows) ────────────────────────┐
│ Tauri v2 (Rust + WebView2)                                         │
│  ├─ Frontend: Vite + TypeScript + CodeMirror 6 (tanpa framework UI)│
│  │    • ViewPlugin decorations: checkbox, jam (mono), bar fokus    │
│  │    • core parser (shared)                                       │
│  └─ Rust:                                                          │
│       • file IO atomic + watcher (crate notify)                    │
│       • snapshot riwayat                                           │
│       • scheduler pengingat → plugin notification                  │
│       • plugins: global-shortcut, window-state, autostart,         │
│         single-instance, notification, tray                        │
└────────────────────────────────────────────────────────────────────┘
            │ v0: folder OneDrive/Dropbox/Syncthing
            │ v1: Yjs update terenkripsi lewat relay
┌──────────────────────── HP ───────────────────────────────────────┐
│ v0: buka catio.md pakai app sync/markdown yang udah ada (nol build)│
│ v1: Tauri v2 mobile, editor CodeMirror + core yang sama,           │
│     notifikasi lokal, share-sheet "kirim ke Catio"                 │
└────────────────────────────────────────────────────────────────────┘
```

**Kenapa Tauri dan bukan Electron:** installer sekitar 5–10 MB, RAM jauh lebih kecil (pakai WebView2 bawaan Windows), API jendela yang dibutuhin semuanya ada (`always_on_top`, `skip_taskbar`, `set_content_protected`).
**Kenapa CodeMirror 6:** dokumennya teks polos dan dekorasinya cuma di level tampilan, jadi copy-paste tetap murni. Tetap ringan buat dokumen puluhan ribu baris, dan dekorasi cuma dirender untuk bagian yang kelihatan.
**Kenapa tanpa React:** isi UI-nya cuma satu editor. Framework UI cuma nambah waktu startup dan ukuran bundle tanpa manfaat.

---

## 3. Biar instan: jendela & hotkey

1. **Jendela dibuat sekali waktu boot** (autostart, tersembunyi), lalu **nggak pernah di-destroy**. Hotkey cuma `show()` + `set_focus()` → target **<50ms**.
2. Konfigurasi jendela: `decorations: false`, `alwaysOnTop: true`, `skipTaskbar: true`, `resizable: true`, sudut 8px (bawaan Windows 11), drag lewat strip 14px di atas.
3. Hotkey global `Ctrl+Alt+N` lewat plugin global-shortcut, **bisa diganti**. Kalau gagal didaftarin, muncul prompt satu baris buat milih kombinasi lain. Tekan sekali: tampil. Tekan lagi: sembunyi.
4. **Fokus balik ke aplikasi sebelumnya:** simpan HWND dari `GetForegroundWindow()` sebelum `show()`. Setelah `hide()`, panggil `SetForegroundWindow(prev)` sebagai cadangan, karena Windows kadang menolak.
5. `Esc` berlapis: tutup pencarian → buang saran → hapus seleksi → baru sembunyiin pad.
6. Plugin window-state ngingat posisi dan ukuran. Waktu tampil, posisi **di-clamp ke monitor yang masih ada** (kasus monitor eksternal dicabut). Tangani pindah monitor dengan DPI beda lewat event `ScaleFactorChanged`.
7. `set_content_protected(true)` sebagai toggle di tray (default nyala), jadi isi pad nggak ikut di share screen Zoom atau Meet.
8. Pad otomatis sembunyi kalau aplikasi di depan lagi full screen (video atau presentasi).

## 4. Biar aman: data

- **Simpan:** debounce 300ms, tulis `catio.md.tmp`, `fsync`, lalu `rename` (atomic). Jadi Windows Update yang reboot paksa atau crash nggak bakal ngerusak file.
- **Watcher:** perubahan dari luar (Notepad, OneDrive, HP) langsung dimuat ulang. Kalau editor lagi kotor (ada perubahan yang belum disimpan), lakukan merge 3-arah per baris. Kalau tetap bentrok, tandai di gutter, jangan pernah diam-diam.
- **Riwayat:** `.catio/history/YYYY-MM-DD/HHMM.md.gz` tiap 5 menit kalau ada perubahan, disimpan 30 hari. Menu tray punya "Pulihkan versi…".
- **Konflik di v0:** OneDrive atau Dropbox bikin `catio (conflict).md`. Watcher ngedeteksi file itu, lalu muncul tanda di pad: "ada versi dari HP · lihat".
- **Ekspor:** tinggal buka folder-nya, karena memang file biasa.

## 5. Pengingat

- Penjadwalnya jalan di **Rust** (bukan di webview), jadi tetap jalan walaupun pad tersembunyi.
- Waktu file berubah: parse token jam, lalu jadwal ulang timer (pakai `tokio::time`).
- Waktunya tiba: notifikasi Windows "call dokter · 15:00" dengan tombol **Tunda 5 mnt** dan **Buka**. Klik "Buka" langsung nampilin pad dengan kursor di baris itu.
- Di HP v1: notifikasi lokal dijadwalkan dari parse file yang sama.

## 6. Sinkron

| Versi | Cara | Biaya |
|---|---|---|
| **v0 (weekend)** | `catio.md` ditaruh di folder OneDrive, Dropbox, atau Syncthing. App cuma baca dan nulis file. | Nol backend |
| **v1** | Yjs (CRDT teks) + `y-codemirror.next`. Update dienkripsi end-to-end (kuncinya dipasangkan lewat QR), dikirim lewat relay kecil (Cloudflare Durable Object atau y-sweet). File `.md` tetap ditulis sebagai cerminan lokal. | Satu worker kecil |

Merge di level karakter lewat CRDT bikin edit di laptop dan HP hampir nggak pernah bentrok. Relay-nya cuma ngoper data terenkripsi, jadi nggak bisa baca nomor rekening lo.

## 7. Anggaran performa (wajib dipantau)

| Metrik | Target |
|---|---|
| Hotkey sampai bisa ngetik | < 50 ms |
| Ketik sampai tampil di layar | < 16 ms |
| Jeda simpan | ≤ 300 ms |
| RAM saat diam | < 80 MB |
| Ukuran installer | < 10 MB |
| Paste 10.000 baris | < 200 ms, tanpa freeze |
| Cold start (autostart) | < 400 ms, tersembunyi |

## 8. Struktur repo

```
catio/
  packages/core/        parser, token, normalisasi, merge per baris (TS murni + test)
  apps/desktop/         Tauri v2: src-tauri (Rust) + web (Vite, CM6)
  apps/mobile/          (v1) Tauri v2 mobile, pakai ulang web + core
  relay/                (v1) worker Yjs relay
```

## 9. Rencana rilis

**v0 (weekend)**
1. Jendela Tauri yang selalu di atas, hotkey yang bisa diganti, Esc berlapis, posisi diingat dan di-clamp.
2. CM6: `[ ]` jadi checkbox, `Ctrl+Enter` buat centang, `Alt+↑↓` buat geser baris, `Ctrl+C` tanpa seleksi nyalin baris, paste selalu polos.
3. Zona fokus dengan `---` dan bar oranye. Jam ditampilin mono di gutter kanan.
4. Simpan atomic ke folder yang bisa dipilih, watcher perubahan dari luar, kebiasaan Notepad (`Ctrl+S/F/H`, zoom, wrap).
5. Notifikasi pengingat untuk token jam.
6. Content protection, tray, autostart.

**v1:** riwayat dan pulihkan, Bersihin ke `arsip.md`, tunda `[>]`, `Ctrl+K` buat cari, strip, app HP (Tauri mobile) dengan notifikasi dan share sheet, sinkron Yjs + E2E.

**Nanti:** server MCP lokal (agent kayak Claude bisa baca, nambah, dan centang to-do lewat `packages/core`, nulis ke `catio.md` lewat jalur simpan atomic yang sama), Google Calendar (to-do dengan jam muncul di kalender, event hari ini bisa ditarik jadi baris fokus), widget HP (native), kirim teks dari aplikasi mana pun (`Alt+Shift+Space` diganti kombinasi aman), saran jam pakai Tab.

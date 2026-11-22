# Catio

Notepad yang ngerti isinya. Satu file teks, satu hotkey. Detail desain dan alasannya ada di [ARCHITECTURE.md](ARCHITECTURE.md).

## Jalanin

Butuh: Node 20+, pnpm 10, Rust stable (MSVC), WebView2 (bawaan Windows 11).

```sh
pnpm install
pnpm dev        # buka pad dalam mode dev
pnpm test       # test parser (packages/core)
pnpm build      # installer NSIS di apps/desktop/src-tauri/target/release/bundle
```

File-nya ada di `Documents\Catio\catio.md`. Bisa dibuka di Notepad kapan aja. Perubahan dari luar langsung kebaca.

## Keyboard

| Tombol | Fungsi |
|---|---|
| `Ctrl+Alt+N` | Munculin / sembunyiin pad (global) |
| `Esc` | Tutup pencarian → hapus seleksi → sembunyiin pad |
| `[]` | Jadi checkbox `[ ] ` |
| `Ctrl+Enter` | Centang / buka centang (teks biasa jadi to-do) |
| `Ctrl+Shift+Enter` | Tunda sampai besok (`[>]`), atau balikin. Kursor di ujung kanan baris → "nanti" (to-do yang udah beres: "hapus") |
| `Ctrl+Shift+Backspace` | Bersihin: yang selesai pindah ke `arsip.md` (ada "batal" 8 detik) |
| Tarik titik-titik di kiri / checkbox | Pindahin baris. Drop di atas `---` = masuk fokus |
| `F11` / double-click strip | Full screen |
| `Enter` | Di to-do: lanjut to-do baru. Di to-do kosong: selesai list |
| `Tab` / `Shift+Tab` | Indent / outdent |
| `Alt+↑ / ↓` | Geser baris |
| `Ctrl+C` tanpa seleksi | Salin satu baris |
| `Ctrl+S` | Simpan sekarang (otomatis juga tiap 300ms) |
| `Ctrl+F` / `Ctrl+H` | Cari / ganti |
| `Ctrl+=` `Ctrl+-` `Ctrl+0`, Ctrl+scroll | Zoom |

Semua baris di atas `---` pertama itu fokus. To-do dengan jam (`15:00`, `jam 3`) bakal muncul jadi notifikasi Windows.

## Struktur

```
packages/core/          parser murni (TS, tanpa dependency) + test node:test
apps/desktop/           Vite + CodeMirror 6 (src/), Tauri v2 (src-tauri/)
  src-tauri/src/doc.rs        simpan atomic, watcher, salinan konflik
  src-tauri/src/pad.rs        show/hide, balikin fokus, clamp ke monitor
  src-tauri/src/reminders.rs  timer pengingat → notifikasi
brand/                  konsep logo + icon sementara
```

## Status v0

Udah ada: jendela selalu di atas tanpa taskbar, hotkey global, tray (buka, share-screen protection, autostart, buka folder, keluar), checkbox/fokus/bar "sekarang"/jam mono, simpan atomic + watcher, pengingat notifikasi, zoom, Esc berlapis, single instance, posisi diingat.

Mode dock: tombol ▣ di strip atau tray → pad ngecil jadi icon di pojok kanan bawah (badge = to-do fokus yang belum beres). Hover buat buka, klik buat ngetik, kursor keluar = ngecil lagi.

Pindahin `catio.md` (misal ke OneDrive buat sinkron HP v0): tray → "Pindahin catio.md ke folder lain…".

Belum ada: ganti hotkey dari UI, umur tugas ("2 hari", butuh riwayat), penanda konflik di gutter + "pakai versi HP/laptop" (sekarang versi luar disimpan jadi `catio.conflict-*.md`), auto-sembunyi waktu ada app full screen, `Ctrl+K` cari arsip, riwayat & pulihkan, sinkron HP.

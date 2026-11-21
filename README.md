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

Belum ada (sesuai roadmap): pilih folder lain (misal OneDrive, buat sinkron HP v0; sekarang selalu `Documents\Catio`), ganti hotkey dari UI, merge per baris kalau laptop & file berubah barengan (sekarang versi luar disimpan jadi `catio.conflict-*.md`), tombol "Tunda 5 mnt / Buka" di notifikasi, auto-sembunyi waktu ada app full screen, jam di gutter kanan (sekarang masih inline), Bersihin ke `arsip.md`, riwayat, sinkron HP.

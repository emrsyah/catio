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

File-nya ada di `Documents\Catio\`. Pad pertama itu `catio.md`, pad lain jadi file sendiri (`kerjaan.md`, `ide.md`). Semua bisa dibuka di Notepad kapan aja, dan perubahan dari luar langsung kebaca.

## Pad

Klik nama pad di kiri atas buat lihat semua pad (dengan jumlah to-do yang belum beres), pindah, atau bikin pad baru. Hover satu pad buat ganti nama atau hapus. Pad yang dihapus masuk ke `Documents\Catio\.terhapus\` dan bisa dibalikin lewat "batal". Pengingat dan badge dock jalan di semua pad.

## Keyboard

| Tombol | Fungsi |
|---|---|
| `Ctrl+Alt+N` | Munculin / sembunyiin pad (global) |
| `Esc` | Tutup pencarian → hapus seleksi → sembunyiin pad |
| `Ctrl+N` | Pad baru |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Pad berikutnya / sebelumnya |
| `Ctrl+1`…`Ctrl+9` | Lompat ke pad ke-N |
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

Semua baris di atas `---` pertama itu fokus. To-do dengan jam atau tanggal bakal muncul jadi notifikasi Windows. Begitu kebaca, jam/tanggalnya jadi chip oranye, nggak perlu Enter:

- Jam: `15:00`, `jam 3`, `2 jam lagi`, `30 menit lagi`, `setengah jam lagi`
- Hari: `hari ini`, `besok`/`bsk`, `lusa`, `senin`…`sabtu`, `hari minggu`, `3 hari lagi`, `minggu depan`
- Tanggal: `25 nov`, `25 november 2027`, `25/11`, `tgl 25`
- Tanpa jam = diingetin jam 09:00 hari itu. Kata yang "geser" (`besok`, `senin`, `2 jam lagi`) dikunci jadi tanggal/jam pasti waktu kamu pindah baris, biar file-nya tetap benar besok.

## Struktur

```
packages/core/          parser murni (TS, tanpa dependency) + test node:test
apps/desktop/           Vite + CodeMirror 6 (src/), Tauri v2 (src-tauri/)
  src/pads.ts                 menu pad (pindah, bikin, ganti nama, hapus)
  src-tauri/src/doc.rs        pad = file .md, simpan atomic, watcher, salinan konflik, .terhapus
  src-tauri/src/pad.rs        show/hide, balikin fokus, clamp ke monitor
  src-tauri/src/reminders.rs  timer pengingat → notifikasi
brand/                  konsep logo + icon sementara
```

## Status v0

Udah ada: jendela selalu di atas tanpa taskbar, hotkey global, tray (buka, share-screen protection, autostart, buka folder, keluar), checkbox/fokus/bar "sekarang"/jam mono, simpan atomic + watcher, pengingat notifikasi, zoom, Esc berlapis, single instance, posisi diingat.

Mode dock: tombol ▣ di strip atau tray → pad ngecil jadi icon di pojok kanan bawah (badge = to-do fokus yang belum beres). Hover buat buka, klik buat ngetik, kursor keluar = ngecil lagi.

Pindahin semua pad (misal ke OneDrive buat sinkron HP v0): tray → "Pindahin folder Catio…".

Belum ada: ganti hotkey dari UI, umur tugas ("2 hari", butuh riwayat), penanda konflik di gutter + "pakai versi HP/laptop" (sekarang versi luar disimpan jadi `catio.conflict-*.md`), auto-sembunyi waktu ada app full screen, `Ctrl+K` cari arsip, riwayat & pulihkan, sinkron HP.

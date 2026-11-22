// Ctrl+K: search every pad and arsip.md at once. The index is built once when the palette
// opens (each line parsed once); typing only scans lowercase strings. Results are grouped
// (to-do, catatan, selesai, arsip) and capped, so rendering stays small on every keystroke.

import {
  buildIndex,
  describeWhen,
  parseLine,
  search,
  topTags,
  type IndexedLine,
  type SearchFilter,
  type SearchHit,
  type SearchSource,
} from "@catio/core";
import { createOverlay, h, hints } from "./overlay";

export interface SearchHooks {
  /** Pads in menu order (the active one with its live text). */
  pads(): SearchSource[];
  archive(): Promise<string>;
  open(item: IndexedLine): void;
  /** Ctrl+Enter on a to-do: check / uncheck it in place. Resolves to the pad's new text. */
  toggle(item: IndexedLine): Promise<string | null>;
}

const GROUPS: { title: string; test: (it: IndexedLine) => boolean }[] = [
  { title: "To-do", test: (it) => !it.archive && (it.kind === "todo" || it.kind === "snooze") },
  { title: "Catatan", test: (it) => !it.archive && it.kind === "text" },
  { title: "Selesai", test: (it) => !it.archive && it.kind === "done" },
  { title: "Arsip", test: (it) => it.archive },
];

export function setupSearch(hooks: SearchHooks) {
  const overlay = createOverlay("Cari di semua pad", "search-overlay");
  const { panel } = overlay;

  const field = h("div", "search-field");
  field.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const input = h("input", "search-input");
  input.type = "text";
  input.placeholder = "Cari di semua pad";
  input.spellcheck = false;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-controls", "search-results");
  input.setAttribute("aria-autocomplete", "list");
  field.appendChild(input);

  const chips = h("div", "search-chips");
  chips.setAttribute("role", "radiogroup");
  chips.setAttribute("aria-label", "Saring");
  const list = h("div", "search-results");
  list.id = "search-results";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Hasil");
  panel.append(field, chips, list, hints([["↑↓", "pilih"], ["↵", "buka"], ["Ctrl ↵", "centang"], ["Tab", "saring"]]));

  let index: IndexedLine[] = [];
  let filters: { label: string; filter: SearchFilter }[] = [];
  let filterAt = 0;
  let hits: SearchHit[] = [];
  let active = 0;
  /** Bumped on every open, so a late archive read never lands in a newer session. */
  let session = 0;

  function rebuild(archive = "") {
    const sources = hooks.pads();
    if (archive.trim()) sources.push({ source: "arsip", text: archive, archive: true });
    index = buildIndex(sources);
    const keep = filters[filterAt]?.label;
    filters = [
      { label: "Semua", filter: { kind: "all" } },
      { label: "To-do terbuka", filter: { kind: "open" } },
      { label: "Ada tanggal", filter: { kind: "dated" } },
      ...topTags(index, 4).map((tag) => ({ label: tag, filter: { kind: "tag", tag } as SearchFilter })),
    ];
    filterAt = Math.max(0, filters.findIndex((f) => f.label === keep));
    renderChips();
  }
  let archiveText = "";

  function renderChips() {
    chips.replaceChildren(
      ...filters.map((f, i) => {
        const b = h("button", "search-chip", f.label);
        b.type = "button";
        b.tabIndex = -1;
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(i === filterAt));
        b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the caret in the field
        b.addEventListener("click", () => setFilter(i));
        return b;
      }),
    );
  }

  function setFilter(i: number) {
    filterAt = (i + filters.length) % filters.length;
    chips.querySelectorAll("[role=radio]").forEach((b, k) => b.setAttribute("aria-checked", String(k === filterAt)));
    run();
  }

  function run(keepActive = false) {
    const query = input.value;
    const filter = filters[filterAt]?.filter ?? { kind: "all" };
    // Without words, show what the filter alone selects ("To-do terbuka" lists them all).
    hits = query.trim() || filter.kind !== "all" ? search(index, query, filter) : [];
    if (!keepActive) active = 0;
    active = Math.min(active, Math.max(0, hits.length - 1));
    render();
  }

  function highlight(text: string, from: number, ranges: [number, number][]): HTMLElement {
    const out = h("span", "search-text");
    let at = from;
    for (const [a, b] of ranges) {
      if (b <= from) continue;
      const s = Math.max(a, from);
      if (s > at) out.append(text.slice(at, s));
      out.appendChild(h("mark", "", text.slice(s, b)));
      at = b;
    }
    out.append(text.slice(at));
    return out;
  }

  function row(hit: SearchHit, i: number, multiPad: boolean): HTMLElement {
    const { item } = hit;
    const p = parseLine(item.text);
    const el = h("div", "search-row");
    el.id = `sr-${i}`;
    el.setAttribute("role", "option");
    el.setAttribute("aria-selected", String(i === active));
    el.dataset.i = String(i);
    if (p.markerFrom >= 0) el.appendChild(h("span", `search-box is-${item.kind}`));
    el.appendChild(highlight(item.text, p.bodyFrom, hit.ranges));
    const when = item.archive ? null : describeWhen(item.text, p, new Date());
    const metaText = [multiPad || item.archive ? item.source : "", when?.label ?? ""].filter(Boolean).join(" · ");
    if (metaText) el.appendChild(h("span", when?.overdue && item.kind === "todo" ? "search-meta is-overdue" : "search-meta", metaText));
    return el;
  }

  function render() {
    if (!hits.length) {
      const empty = h("div", "search-empty");
      if (input.value.trim()) {
        empty.append(h("p", "", `Nggak ada yang cocok sama “${input.value.trim()}”`));
        const clear = h("button", "search-clear", filterAt ? "hapus saringan" : "hapus pencarian");
        clear.type = "button";
        clear.addEventListener("click", () => {
          if (filterAt) setFilter(0);
          else {
            input.value = "";
            run();
          }
          input.focus();
        });
        empty.append(clear);
      } else {
        empty.append(h("p", "", "Ketik buat cari di semua pad dan arsip."));
      }
      list.replaceChildren(empty);
      input.removeAttribute("aria-activedescendant");
      return;
    }
    const multiPad = new Set(index.map((i) => i.source)).size > 1;
    const frag = document.createDocumentFragment();
    let n = 0;
    // Group order is fixed; inside a group the ranking from search() holds.
    const order: SearchHit[] = [];
    for (const g of GROUPS) {
      const inGroup = hits.filter((x) => g.test(x.item));
      if (!inGroup.length) continue;
      const group = h("div", "search-group");
      group.setAttribute("role", "group");
      const title = h("div", "search-group-title", g.title);
      title.id = `sg-${g.title}`;
      group.setAttribute("aria-labelledby", title.id);
      group.appendChild(title);
      for (const hit of inGroup) {
        group.appendChild(row(hit, n++, multiPad));
        order.push(hit);
      }
      frag.appendChild(group);
    }
    hits = order; // indices now follow what's on screen
    list.replaceChildren(frag);
    input.setAttribute("aria-activedescendant", `sr-${active}`);
    list.querySelector(`#sr-${active}`)?.scrollIntoView({ block: "nearest" });
  }

  function move(delta: number) {
    if (!hits.length) return;
    list.querySelector(`#sr-${active}`)?.setAttribute("aria-selected", "false");
    active = (active + delta + hits.length) % hits.length;
    const el = list.querySelector(`#sr-${active}`);
    el?.setAttribute("aria-selected", "true");
    el?.scrollIntoView({ block: "nearest" });
    input.setAttribute("aria-activedescendant", `sr-${active}`);
  }

  function choose(i = active) {
    const hit = hits[i];
    if (!hit) return;
    overlay.close();
    hooks.open(hit.item);
  }

  async function toggle() {
    const hit = hits[active];
    if (!hit || hit.item.archive || !["todo", "done", "snooze"].includes(hit.item.kind)) return;
    const text = await hooks.toggle(hit.item);
    if (text === null) return;
    // Re-index only what changed, then keep the selection on the same row.
    rebuild(archiveText);
    run(true);
  }

  input.addEventListener("input", () => run());
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) void toggle();
      else choose();
    } else if (e.key === "Tab") {
      e.preventDefault();
      setFilter(filterAt + (e.shiftKey ? -1 : 1));
    }
  });
  list.addEventListener("mousedown", (e) => e.preventDefault());
  list.addEventListener("click", (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>(".search-row");
    if (r) choose(Number(r.dataset.i));
  });

  return {
    isOpen: overlay.isOpen,
    /** Opens with the pads indexed now; arsip.md joins as soon as it's read. */
    open(filter?: SearchFilter) {
      if (overlay.isOpen()) return input.select();
      const mine = ++session;
      archiveText = "";
      rebuild();
      if (filter) filterAt = Math.max(0, filters.findIndex((f) => JSON.stringify(f.filter) === JSON.stringify(filter)));
      renderChips();
      overlay.open();
      input.focus();
      input.select();
      run();
      hooks
        .archive()
        .then((text) => {
          if (mine !== session || !overlay.isOpen() || !text.trim()) return;
          archiveText = text;
          rebuild(text);
          run(true);
        })
        .catch(console.error);
    },
    close: overlay.close,
  };
}

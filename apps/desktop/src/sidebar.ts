// Full screen only: a quiet left column with every pad and a few ready-made views over the
// same text (open to-dos, dated, stuck, tags). Nothing new is stored; each view opens Ctrl+K
// pre-filtered or the weekly review. Rendered only while maximized.

import type { SearchFilter } from "@catio/core";
import { h } from "./overlay";

export interface SidebarModel {
  pads: { name: string; open: number; current: boolean }[];
  open: number;
  dated: number;
  stuck: number;
  tags: string[];
}

export interface SidebarHooks {
  model(): SidebarModel;
  select(pad: string): void;
  search(filter?: SearchFilter): void;
  review(): void;
}

export function setupSidebar(hooks: SidebarHooks) {
  const aside = document.getElementById("sidebar")!;
  let visible = false;

  function item(label: string, count: number | string, onClick: () => void, current = false) {
    const b = h("button", "side-item");
    b.type = "button";
    if (current) b.setAttribute("aria-current", "page");
    b.append(h("span", "side-label", label));
    if (count) b.append(h("span", "side-count", String(count)));
    b.addEventListener("click", onClick);
    return b;
  }

  function section(title: string, items: HTMLElement[]) {
    const s = h("nav", "side-section");
    s.setAttribute("aria-label", title);
    s.append(h("p", "side-title", title), ...items);
    return s;
  }

  function render() {
    if (!visible) return;
    const m = hooks.model();
    const find = h("button", "side-search");
    find.type = "button";
    find.append(h("span", "", "Cari di semua pad"), h("kbd", "", "Ctrl K"));
    find.addEventListener("click", () => hooks.search());
    const views = [
      item("To-do terbuka", m.open, () => hooks.search({ kind: "open" })),
      item("Ada tanggal", m.dated, () => hooks.search({ kind: "dated" })),
    ];
    if (m.stuck) views.push(item("Nyangkut > 7 hari", m.stuck, hooks.review));
    const parts = [
      find,
      section("Pad", m.pads.map((p) => item(p.name, p.open, () => hooks.select(p.name), p.current))),
      section("Lihat", views),
    ];
    if (m.tags.length) parts.push(section("Tag", m.tags.map((t) => item(t, "", () => hooks.search({ kind: "tag", tag: t })))));
    aside.replaceChildren(...parts);
  }

  return {
    render,
    setVisible(on: boolean) {
      visible = on;
      aside.hidden = !on;
      if (on) render();
      else aside.replaceChildren();
    },
  };
}

// Weekly review: open to-dos waiting 7+ days, one at a time. Kerjain hari ini (→), tunda ke
// minggu depan (↓) or buang (←). Never pops up by itself: the strip offers it, you open it.

import { parseLine } from "@catio/core";
import { createOverlay, h, hints } from "./overlay";

export interface StuckTask {
  pad: string;
  /** 0-based line in that pad */
  line: number;
  text: string;
  days: number;
}

export type ReviewChoice = "drop" | "later" | "today";

export interface ReviewHooks {
  /** Resolves false when the line changed meanwhile (then it's skipped). */
  act(task: StuckTask, choice: ReviewChoice): Promise<boolean>;
}

const CHOICES: { choice: ReviewChoice; label: string; key: string; cls: string }[] = [
  { choice: "drop", label: "Buang", key: "←", cls: "btn btn-danger" },
  { choice: "later", label: "Minggu depan", key: "↓", cls: "btn" },
  { choice: "today", label: "Kerjain hari ini", key: "→", cls: "btn btn-primary" },
];
const KEYS: Record<string, ReviewChoice> = { ArrowLeft: "drop", ArrowDown: "later", ArrowRight: "today" };

export function setupReview(hooks: ReviewHooks) {
  const overlay = createOverlay("Review yang nyangkut", "review-overlay");
  const { panel } = overlay;
  let tasks: StuckTask[] = [];
  let at = 0;
  let busy = false;

  function render() {
    panel.replaceChildren();
    if (at >= tasks.length) {
      const done = h("div", "review-done");
      done.append(h("p", "review-title", "Beres semua"), h("p", "review-sub", "Yang nyangkut udah diputusin. Sampai minggu depan."));
      const close = h("button", "btn btn-primary", "Tutup");
      close.type = "button";
      close.addEventListener("click", overlay.close);
      done.append(close);
      panel.append(done);
      close.focus();
      return;
    }
    const t = tasks[at];
    const head = h("div", "review-head");
    head.append(h("p", "review-count", `${at + 1} dari ${tasks.length}`), h("p", "review-title", "Yang nyangkut"));
    head.append(h("p", "review-sub", "Satu-satu aja. Kerjain, tunda, atau buang, nggak ada yang salah."));
    const card = h("div", "review-card");
    card.append(
      h("p", "review-age", `Ditulis ${t.days} hari lalu · pad ${t.pad}`),
      h("p", "review-text", t.text.slice(parseLine(t.text).bodyFrom).trim()),
    );
    const actions = h("div", "review-actions");
    for (const c of CHOICES) {
      const b = h("button", c.cls);
      b.type = "button";
      b.append(c.label, h("kbd", "", c.key));
      b.addEventListener("click", () => void pick(c.choice));
      actions.appendChild(b);
    }
    panel.append(head, card, actions, hints([["←", "buang"], ["↓", "minggu depan"], ["→", "hari ini"], ["Esc", "nanti aja"]]));
    (actions.lastElementChild as HTMLElement).focus();
  }

  async function pick(choice: ReviewChoice) {
    if (busy || at >= tasks.length) return;
    busy = true;
    try {
      await hooks.act(tasks[at], choice);
    } finally {
      busy = false;
    }
    at++;
    render();
  }

  panel.addEventListener("keydown", (e) => {
    const choice = KEYS[e.key];
    if (!choice || at >= tasks.length) return;
    e.preventDefault();
    void pick(choice);
  });

  return {
    open(list: StuckTask[]) {
      tasks = list;
      at = 0;
      overlay.open();
      render();
    },
    isOpen: overlay.isOpen,
  };
}

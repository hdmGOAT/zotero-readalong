/**
 * The Read-Along section in the reader's item pane, laid out like a chat:
 * the conversation about this paper on top, the composer pinned at the
 * bottom.
 *
 * - Selecting text ("Ask … about this") or drawing a box adds a region chip
 *   to the composer. The question refers to regions as [1], [2]…
 * - "My guess" holds what the reader thinks before asking; the agent responds
 *   to it first.
 * - "Respond" on a reply makes the next question a follow-up in that thread.
 *
 * It lives in Zotero's native item pane, so it is resizable (drag the pane
 * splitter), collapsible, and outside the PDF view, where typing can't trigger
 * reader shortcuts.
 */
import { config } from "../../package.json";
import { toggleBoxMode } from "./interact";
import type { Ask, Mark } from "./marks";
import { promoteMark } from "./promote";
import { removeImage } from "./render";
import {
  activeReader,
  agentName,
  AGENT_COLOR,
  COLOR,
  state,
  views,
} from "./view";

// Module scope runs before the addon instance exists; read config directly.
const ICON = `chrome://${config.addonRef}/content/icons/readalong.svg`;
const ROOT_CLASS = "readalong-sidebar";

let paneID: string | false = false;
/** Rendered section bodies and their store subscriptions. */
const mounted = new Map<HTMLElement, () => void>();

export function registerSidebar() {
  const ref = addon.data.config.addonRef;
  paneID = Zotero.ItemPaneManager.registerSection({
    paneID: "readalong",
    pluginID: addon.data.config.addonID,
    header: { l10nID: `${ref}-sidebar-header`, icon: ICON },
    sidenav: { l10nID: `${ref}-sidebar-sidenav`, icon: ICON },
    onItemChange: ({ tabType, setEnabled }: any) => {
      setEnabled(tabType === "reader");
      return true;
    },
    onRender: ({ body, setSectionSummary }: any) => {
      mount(body);
      const reader = activeReader();
      const waiting = reader
        ? state.store
            .allAsks()
            .filter((a) => a.attachmentID === reader.itemID && !a.reply).length
        : 0;
      setSectionSummary(waiting ? `${waiting} waiting` : "");
    },
    onDestroy: ({ body }: any) => unmount(body),
  } as any);
}

export function unregisterSidebar() {
  for (const body of [...mounted.keys()]) unmount(body);
  if (paneID) Zotero.ItemPaneManager.unregisterSection(paneID);
  paneID = false;
}

function mainDoc(): Document {
  return Zotero.getMainWindow().document;
}

function questionBox(): HTMLTextAreaElement | null {
  return mainDoc().querySelector(`.${ROOT_CLASS} .ra-question`);
}

/** Expand the item pane, bring the composer into view, focus the question. */
export function revealComposer() {
  const win = Zotero.getMainWindow() as any;
  if (win.ZoteroContextPane?.collapsed) win.ZoteroContextPane.collapsed = false;
  const question = questionBox();
  question?.scrollIntoView({ block: "end" });
  question?.focus();
}

/** Insert "[n]" at the caret in the question box. */
export function insertRef(n: number) {
  const prompt = questionBox();
  if (!prompt) return;
  const ref = `[${n}]`;
  const start = prompt.selectionStart ?? prompt.value.length;
  const end = prompt.selectionEnd ?? start;
  const before = prompt.value.slice(0, start);
  const pad = before && !/\s$/.test(before) ? " " : "";
  prompt.value = before + pad + ref + prompt.value.slice(end);
  const caret = start + pad.length + ref.length;
  prompt.focus();
  prompt.setSelectionRange(caret, caret);
  prompt.dispatchEvent(new (prompt.ownerGlobal as any).Event("input"));
}

// ---------------------------------------------------------------------------
// Mounting

function mount(body: HTMLElement) {
  const reader = activeReader();
  const attachmentID: number | undefined = reader?.itemID;
  const root = body.querySelector(`.${ROOT_CLASS}`) as HTMLElement | null;
  if (root && Number(root.dataset.attachmentId) === attachmentID) {
    update(body);
    return;
  }
  unmount(body);
  body.replaceChildren();
  if (!reader) return;
  body.append(build(body.ownerDocument!, reader));
  body.ownerGlobal?.requestAnimationFrame(() => {
    for (const t of body.querySelectorAll("textarea")) {
      autogrow(t as HTMLTextAreaElement);
    }
  });
  mounted.set(
    body,
    state.store.onChange(() => update(body)),
  );
  update(body);
}

function unmount(body: HTMLElement) {
  mounted.get(body)?.();
  mounted.delete(body);
}

function readerFor(root: HTMLElement): any {
  const id = Number(root.dataset.attachmentId);
  return Zotero.Reader._readers.find((r: any) => r.itemID === id);
}

// ---------------------------------------------------------------------------
// Building

const css = {
  // The item pane sizes sections by their content's intrinsic width, so one
  // unwrapped label would widen everything. inline-size containment makes the
  // section ignore its contents and take the pane's width.
  root: "display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.45;width:100%;box-sizing:border-box;contain:inline-size;overflow-wrap:anywhere;",
  muted: "color:var(--fill-secondary, #777);font-size:12px;",
  who: "font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;",
  bubbleUser:
    "align-self:flex-end;max-width:92%;padding:6px 10px;border-radius:10px 10px 2px 10px;background:var(--fill-quinary, #eee);",
  bubbleAgent: `padding:6px 10px;border-left:3px solid ${COLOR};`,
  chip: `display:inline-flex;align-items:center;gap:3px;max-width:100%;margin:0 4px 3px 0;padding:0 7px;border-radius:9px;border:1px solid ${COLOR};color:${COLOR};font:inherit;font-size:12px;cursor:pointer;background:none;`,
  link: "background:none;border:none;padding:0;font:inherit;font-size:12px;cursor:pointer;color:var(--fill-secondary, #777);",
  textarea:
    "width:100%;box-sizing:border-box;font:inherit;line-height:1.45;padding:6px 8px;resize:none;min-height:52px;border:1px solid var(--fill-quinary, #ccc);border-radius:8px;background:var(--material-background, #fff);color:inherit;",
  tool: "font:inherit;font-size:12px;padding:2px 8px;border-radius:6px;cursor:pointer;background:none;border:1px solid var(--fill-quinary, #ccc);color:inherit;",
  send: `font:inherit;font-size:12px;padding:3px 12px;border-radius:6px;cursor:pointer;background:${COLOR};color:#fff;border:none;`,
};

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  style = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (style) e.setAttribute("style", style);
  if (text) e.textContent = text;
  return e;
}

function build(doc: Document, reader: any): HTMLElement {
  const root = el(doc, "div", css.root);
  root.className = ROOT_CLASS;
  root.dataset.attachmentId = String(reader.itemID);

  const thread = el(doc, "div", "display:flex;flex-direction:column;gap:10px;");
  thread.className = "ra-thread";
  root.append(thread, buildComposer(doc, reader));
  return root;
}

function autogrow(t: HTMLTextAreaElement, max = 220) {
  // Detached or hidden boxes measure 0; leave them at their CSS min-height.
  if (!t.isConnected || !t.offsetParent) return;
  t.style.height = "auto";
  t.style.height = `${Math.min(Math.max(t.scrollHeight + 2, 52), max)}px`;
}

function buildComposer(doc: Document, reader: any): HTMLElement {
  const attachmentID: number = reader.itemID;
  const { store } = state;
  const name = agentName();

  // Pinned to the bottom of the item pane while the thread scrolls.
  const composer = el(
    doc,
    "div",
    "position:sticky;bottom:0;z-index:1;display:flex;flex-direction:column;gap:6px;padding:8px 0 6px;background:var(--material-sidepane, var(--material-background, #fff));border-top:1px solid var(--fill-quinary, #ddd);",
  );
  composer.className = "ra-composer";

  const replying = el(
    doc,
    "div",
    `${css.muted}display:none;align-items:center;gap:6px;`,
  );
  replying.className = "ra-replying";

  const chips = el(doc, "div", "display:flex;flex-wrap:wrap;min-width:0;");
  chips.className = "ra-chips";

  const question = el(doc, "textarea", css.textarea);
  question.className = "ra-question";
  question.rows = 2;
  question.placeholder = `Ask ${name}… Select text or ⬚ box a region in the PDF to attach it.`;

  const guess = el(
    doc,
    "textarea",
    `${css.textarea}display:none;font-style:italic;`,
  );
  guess.className = "ra-guess";
  guess.rows = 2;
  guess.placeholder = `My guess: what I think it means, or exactly where I get lost. ${name} responds to this first.`;

  const tools = el(doc, "div", "display:flex;align-items:center;gap:6px;");
  const guessToggle = el(doc, "button", css.tool, "✎ My guess");
  guessToggle.title = "Say what you think before asking";
  const box = el(doc, "button", css.tool, "⬚ Box");
  box.title = "Box a figure, equation or table to attach it";
  const status = el(doc, "span", `${css.muted}flex:1;text-align:right;`);
  status.className = "ra-status";
  const send = el(doc, "button", css.send, "Send ▸");
  send.title = "Send (Enter). Shift+Enter for a new line";
  tools.append(guessToggle, box, status, send);

  composer.append(replying, chips, question, guess, tools);

  const showGuess = (show: boolean) => {
    guess.style.display = show ? "block" : "none";
    guessToggle.style.borderColor = show ? COLOR : "";
    guessToggle.style.color = show ? COLOR : "";
    if (show) autogrow(guess);
  };
  const save = () =>
    store.setDraftText(attachmentID, {
      prompt: question.value,
      take: guess.value,
    });

  const doSend = () => {
    save();
    views.get(reader)?.boxMode?.();
    if (!store.sendDraft(attachmentID)) {
      status.textContent = "Write a question or attach a region";
      return;
    }
    question.value = guess.value = "";
    autogrow(question);
    showGuess(false);
    status.textContent = "";
    scrollToEnd(composer);
  };

  for (const t of [question, guess]) {
    t.addEventListener("input", () => {
      autogrow(t);
      save();
      status.textContent = "";
    });
    t.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        doSend();
      }
    });
  }
  guessToggle.addEventListener("click", () => {
    const show = guess.style.display === "none";
    showGuess(show);
    (show ? guess : question).focus();
  });
  box.addEventListener("click", () => void toggleBoxMode(reader));
  send.addEventListener("click", doSend);

  // Restore an in-progress draft if the section was rebuilt.
  const draft = store.draftFor(attachmentID);
  if (draft) {
    question.value = draft.prompt;
    guess.value = draft.take;
    showGuess(!!draft.take);
  }
  autogrow(question);
  return composer;
}

function scrollToEnd(composer: HTMLElement) {
  composer.ownerGlobal?.requestAnimationFrame(() =>
    composer.scrollIntoView({ block: "end" }),
  );
}

// ---------------------------------------------------------------------------
// Updating: rebuild only what changed, never the text areas, so typing is
// never interrupted.

function update(body: HTMLElement) {
  const root = body.querySelector(`.${ROOT_CLASS}`) as HTMLElement | null;
  if (!root) return;
  const reader = readerFor(root);
  if (!reader) return;
  renderComposerState(root, reader);
  renderThread(root, reader);
}

function navigate(reader: any, mark: Mark) {
  reader.navigate({ position: mark.position });
}

function snippet(text: string, n = 60) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function regionChip(
  doc: Document,
  reader: any,
  mark: Mark,
  n: number,
  color = COLOR,
) {
  const chip = el(doc, "span", css.chip.replaceAll(COLOR, color));
  const ref = el(doc, "b", "", `[${n}]`);
  const label = el(
    doc,
    "span",
    "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;",
    mark.kind === "box"
      ? `p.${mark.pageLabel} box`
      : `p.${mark.pageLabel} “${snippet(mark.text, 40)}”`,
  );
  chip.title = mark.kind === "box" ? "Boxed region" : mark.text;
  chip.append(ref, label);
  label.addEventListener("click", () => navigate(reader, mark));
  return { chip, ref };
}

function renderComposerState(root: HTMLElement, reader: any) {
  const doc = root.ownerDocument!;
  const { store } = state;
  const draft = store.draftFor(reader.itemID);

  // Region chips
  const chips = root.querySelector(".ra-chips") as HTMLElement;
  const marks = (draft?.markIDs ?? [])
    .map((id) => store.getMark(id))
    .filter((m): m is Mark => !!m);
  const sig = marks.map((m) => m.id).join(",");
  if (chips.dataset.signature !== sig) {
    chips.dataset.signature = sig;
    chips.replaceChildren();
    marks.forEach((mark, i) => {
      const { chip, ref } = regionChip(doc, reader, mark, i + 1);
      ref.style.cursor = "pointer";
      ref.title = "Insert reference into your question";
      ref.addEventListener("click", () => insertRef(i + 1));
      const remove = el(doc, "button", `${css.link}color:inherit;`, "×");
      remove.title = "Remove region";
      remove.addEventListener("click", async () => {
        const removed = store.removeMark(mark.id);
        await removeImage(removed?.imagePath);
      });
      chip.append(remove);
      chips.append(chip);
    });
  }

  // "Responding to" banner
  const replying = root.querySelector(".ra-replying") as HTMLElement;
  const parent = draft?.parentID ? store.getAsk(draft.parentID) : undefined;
  const replySig = parent?.id ?? "";
  if (replying.dataset.signature !== replySig) {
    replying.dataset.signature = replySig;
    replying.replaceChildren();
    replying.style.display = parent ? "flex" : "none";
    if (parent) {
      const text = el(
        doc,
        "span",
        "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
        `↩ Responding to ${agentName()}: “${snippet(parent.reply ?? parent.prompt)}”`,
      );
      const cancel = el(doc, "button", css.link, "×");
      cancel.title = "Ask a new question instead";
      cancel.addEventListener("click", () =>
        store.setDraftParent(reader.itemID, undefined),
      );
      replying.append(text, cancel);
    }
  }

  // Clear the boxes if the draft went away elsewhere (e.g. cleared marks).
  if (!draft) {
    const q = root.querySelector(".ra-question") as HTMLTextAreaElement;
    const g = root.querySelector(".ra-guess") as HTMLTextAreaElement;
    if (
      doc.activeElement !== q &&
      doc.activeElement !== g &&
      (q.value || g.value)
    ) {
      q.value = g.value = "";
      autogrow(q);
    }
  }
}

function renderThread(root: HTMLElement, reader: any) {
  const doc = root.ownerDocument!;
  const thread = root.querySelector(".ra-thread") as HTMLElement;
  const { store } = state;
  const asks = store.allAsks().filter((a) => a.attachmentID === reader.itemID);
  const loose = store
    .marksFor(reader.itemID)
    .filter((m) => m.author === "agent" && !m.askID);
  const sig = JSON.stringify([
    asks.map((a) => [a.id, a.reply, a.seen, a.markIDs, a.parentID]),
    store
      .marksFor(reader.itemID)
      .filter((m) => m.author === "agent")
      .map((m) => [m.id, m.askID]),
  ]);
  if (thread.dataset.signature === sig) return;
  thread.dataset.signature = sig;
  thread.replaceChildren();

  const isRoot = (a: Ask) => !a.parentID || !store.getAsk(a.parentID);
  const items: Array<{ at: string; node: HTMLElement }> = [
    ...asks
      .filter(isRoot)
      .map((a) => ({ at: a.createdAt, node: conversation(doc, reader, a) })),
    ...loose.map((m) => ({
      at: m.createdAt,
      node: loosePointer(doc, reader, m),
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  if (!items.length) {
    thread.append(
      el(
        doc,
        "div",
        css.muted,
        `Select a passage and choose “Ask ${agentName()} about this”, or ⬚ box a figure. Your questions and ${agentName()}'s replies appear here.`,
      ),
    );
    return;
  }
  for (const item of items) thread.append(item.node);
}

/** A root ask and its follow-ups, as one conversation block. */
function conversation(doc: Document, reader: any, root: Ask) {
  const { store } = state;
  const block = el(
    doc,
    "div",
    "display:flex;flex-direction:column;gap:6px;padding-bottom:8px;border-bottom:1px solid var(--fill-quinary, #ddd);",
  );
  const chain: Ask[] = [];
  const walk = (a: Ask) => {
    chain.push(a);
    for (const child of store.childrenOf(a.id)) walk(child);
  };
  walk(root);
  for (const ask of chain)
    block.append(userBubble(doc, reader, ask), agentBubble(doc, reader, ask));

  const last = chain[chain.length - 1];
  const footer = el(
    doc,
    "div",
    "display:flex;gap:12px;justify-content:flex-end;",
  );
  const respond = el(doc, "button", `${css.link}color:${COLOR};`, "↩ Respond");
  respond.title = "Follow up in this conversation";
  respond.addEventListener("click", () => {
    store.setDraftParent(reader.itemID, last.id);
    revealComposer();
  });
  const keep = el(doc, "button", css.link, "Keep");
  keep.title =
    "Save this conversation's regions and pointers as Zotero annotations";
  keep.addEventListener("click", async () => {
    keep.disabled = true;
    for (const a of chain) {
      for (const id of [
        ...a.markIDs,
        ...store.pointersFor(a.id).map((m) => m.id),
      ]) {
        await promoteMark(store, id);
      }
    }
  });
  const dismiss = el(doc, "button", css.link, "Dismiss");
  dismiss.title = "Remove this conversation and its marks";
  dismiss.addEventListener("click", async () => {
    for (const m of store.removeAsk(root.id)) await removeImage(m.imagePath);
  });
  footer.append(keep, dismiss);
  if (last.reply) footer.prepend(respond);
  block.append(footer);
  return block;
}

function userBubble(doc: Document, reader: any, ask: Ask) {
  const { store } = state;
  const bubble = el(
    doc,
    "div",
    `${css.bubbleUser}display:flex;flex-direction:column;gap:4px;`,
  );
  const marks = ask.markIDs
    .map((id) => store.getMark(id))
    .filter((m): m is Mark => !!m);
  if (marks.length) {
    const chips = el(doc, "div", "display:flex;flex-wrap:wrap;min-width:0;");
    marks.forEach((m, i) =>
      chips.append(regionChip(doc, reader, m, i + 1).chip),
    );
    bubble.append(chips);
  }
  if (ask.prompt)
    bubble.append(el(doc, "div", "white-space:pre-wrap;", ask.prompt));
  if (ask.take) {
    bubble.append(
      el(
        doc,
        "div",
        `${css.muted}white-space:pre-wrap;font-style:italic;`,
        `My guess: ${ask.take}`,
      ),
    );
  }
  return bubble;
}

function agentBubble(doc: Document, reader: any, ask: Ask) {
  const { store } = state;
  const bubble = el(
    doc,
    "div",
    `${css.bubbleAgent}display:flex;flex-direction:column;gap:4px;`,
  );
  bubble.append(el(doc, "div", `${css.who}color:${COLOR};`, agentName()));
  bubble.append(
    ask.reply
      ? el(doc, "div", "white-space:pre-wrap;", ask.reply)
      : el(
          doc,
          "div",
          `${css.muted}font-style:italic;`,
          ask.seen ? "Thinking…" : "Waiting…",
        ),
  );
  for (const p of store.pointersFor(ask.id))
    bubble.append(pointer(doc, reader, p));
  return bubble;
}

function pointer(doc: Document, reader: any, mark: Mark) {
  const row = el(doc, "div", "display:flex;flex-direction:column;gap:1px;");
  const chip = el(
    doc,
    "button",
    `${css.chip.replaceAll(COLOR, AGENT_COLOR)}align-self:flex-start;`,
  );
  chip.textContent =
    mark.kind === "box"
      ? `📍 p.${mark.pageLabel}`
      : `📍 p.${mark.pageLabel} “${snippet(mark.text, 40)}”`;
  chip.title = "Show on page";
  chip.addEventListener("click", () => navigate(reader, mark));
  row.append(chip);
  if (mark.note)
    row.append(el(doc, "div", `${css.muted}white-space:pre-wrap;`, mark.note));
  return row;
}

/** An agent pointer not tied to any question. */
function loosePointer(doc: Document, reader: any, mark: Mark) {
  const { store } = state;
  const block = el(
    doc,
    "div",
    `${css.bubbleAgent.replaceAll(COLOR, AGENT_COLOR)}display:flex;flex-direction:column;gap:4px;`,
  );
  block.append(el(doc, "div", `${css.who}color:${AGENT_COLOR};`, agentName()));
  block.append(pointer(doc, reader, mark));
  const footer = el(
    doc,
    "div",
    "display:flex;gap:12px;justify-content:flex-end;",
  );
  const keep = el(doc, "button", css.link, "Keep");
  keep.addEventListener("click", () => promoteMark(store, mark.id));
  const dismiss = el(doc, "button", css.link, "Dismiss");
  dismiss.addEventListener("click", async () => {
    const removed = store.removeMark(mark.id);
    await removeImage(removed?.imagePath);
  });
  footer.append(keep, dismiss);
  block.append(footer);
  return block;
}

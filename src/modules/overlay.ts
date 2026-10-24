/**
 * Drawing on the reader: mark rectangles inside pdf.js pages, and the
 * clickable bits (badges, popovers) in a fixed UI layer. The draft composer
 * and thread live in the item pane (sidebar.ts).
 *
 * Marks are plain DOM nodes, never Zotero's annotation layer, so they cannot
 * leak into the user's annotations.
 */
import type { Ask, Mark } from "./marks";
import { promoteMark } from "./promote";
import { boundingRect, normRect, removeImage } from "./render";
import { insertRef } from "./sidebar";
import {
  AGENT_COLOR,
  agentName,
  COLOR,
  Cu,
  DRAFT_COLOR,
  state,
  stopReaderEvents,
  uiLayer,
  views,
  type View,
} from "./view";

const MARK_CLASS = "readalong-mark";

export function redrawAll() {
  for (const [reader, view] of views) {
    if (reader._isClosed || view.winX.closed) {
      views.delete(reader);
      continue;
    }
    redraw(view);
  }
}

export function redraw(view: View) {
  for (const el of view.doc.querySelectorAll(`.${MARK_CLASS}`)) el.remove();
  const viewer = view.win.PDFViewerApplication.pdfViewer;
  for (const mark of state.store.marksFor(view.reader.itemID)) {
    try {
      drawMark(view, viewer, mark);
    } catch (e) {
      ztoolkit.log("readalong: draw failed", e);
    }
  }
}

// ---------------------------------------------------------------------------
// Marks

/** 1-based position of a mark within its draft or ask, for [n] references. */
function refNumber(mark: Mark): number | undefined {
  const { store } = state;
  const ids = mark.askID
    ? store.getAsk(mark.askID)?.markIDs
    : store.draftFor(mark.attachmentID)?.markIDs;
  const i = ids?.indexOf(mark.id) ?? -1;
  return i >= 0 ? i + 1 : undefined;
}

function drawMark(view: View, viewer: any, mark: Mark) {
  const pageView = viewer.getPageView(mark.pageIndex);
  const pageDiv =
    pageView?.div && (Cu().unwaiveXrays(pageView.div) as HTMLElement);
  const wrapper = pageDiv?.querySelector(
    ".canvasWrapper",
  ) as HTMLElement | null;
  if (!pageDiv || !wrapper) return; // page not rendered yet

  const { doc, win } = view;
  const ask = mark.askID ? state.store.getAsk(mark.askID) : undefined;
  const drafting = mark.author === "user" && !ask;
  const color =
    mark.author === "agent" ? AGENT_COLOR : drafting ? DRAFT_COLOR : COLOR;
  const tint =
    mark.author === "agent"
      ? "13,148,136"
      : drafting
        ? "167,139,250"
        : "139,92,246";
  const vp = pageView.viewport;
  const toView = (r: number[]) =>
    normRect(vp.convertToViewportRectangle(Cu().cloneInto(r, win)));

  for (const r of mark.position.rects) {
    const [x1, y1, x2, y2] = toView(r);
    const el = doc.createElement("div");
    el.className = MARK_CLASS;
    el.style.cssText =
      `position:absolute;z-index:5;pointer-events:none;` +
      `left:${wrapper.offsetLeft + x1}px;top:${wrapper.offsetTop + y1}px;` +
      `width:${x2 - x1}px;height:${y2 - y1}px;` +
      (mark.kind === "box"
        ? `border:2px dashed ${color};background:rgba(${tint},.06);border-radius:2px;`
        : `background:rgba(${tint},.16);border-bottom:2px dashed ${color};`);
    pageDiv.append(el);
  }

  const [bx, by] = toView(boundingRect(mark.position.rects));
  const origin = wrapper.getBoundingClientRect();
  const x = origin.left + bx;
  const y = origin.top + by;
  const bounds = doc.getElementById("viewerContainer")!.getBoundingClientRect();
  if (
    x < bounds.left ||
    x > bounds.right ||
    y < bounds.top ||
    y > bounds.bottom
  ) {
    return; // scrolled out of view
  }

  const n = refNumber(mark);
  const { label, title, filled } = badgeState(mark, ask, n);
  const badge = doc.createElement("div");
  badge.className = MARK_CLASS;
  badge.textContent = label;
  badge.title = title;
  badge.style.cssText = `position:fixed;z-index:20;left:${x - 10}px;top:${y - 10}px;min-width:18px;height:18px;padding:0 2px;border-radius:9px;background:${filled ? color : "#fff"};color:${filled ? "#fff" : color};border:2px solid ${color};font:bold 11px/18px system-ui;text-align:center;cursor:pointer;box-sizing:content-box;`;
  stopReaderEvents(badge);
  badge.addEventListener("click", () => {
    if (drafting && n) {
      insertRef(n);
      return;
    }
    view.openMarkID = view.openMarkID === mark.id ? undefined : mark.id;
    redraw(view);
  });
  uiLayer(view).append(badge);

  if (view.openMarkID === mark.id && !drafting) {
    uiLayer(view).append(popover(view, mark, ask, color, x, y + 14));
  }
}

function badgeState(mark: Mark, ask: Ask | undefined, n?: number) {
  const name = agentName();
  if (mark.author === "agent") {
    return {
      label: name[0],
      title: `${name} marked this. Click to read`,
      filled: true,
    };
  }
  if (!ask) {
    return {
      label: String(n ?? "·"),
      title: `Draft region [${n}]. Click to insert [${n}] in your question`,
      filled: true,
    };
  }
  const multi = ask.markIDs.length > 1 && n ? String(n) : "";
  if (ask.reply) {
    return {
      label: `✓${multi}`,
      title: `${name} answered. Click to read`,
      filled: true,
    };
  }
  if (ask.seen) {
    return {
      label: `…${multi}`,
      title: `${name} is looking at this`,
      filled: false,
    };
  }
  return { label: `?${multi}`, title: `Waiting for ${name}`, filled: false };
}

function popover(
  view: View,
  mark: Mark,
  ask: Ask | undefined,
  color: string,
  x: number,
  y: number,
) {
  const { doc, winX } = view;
  const box = doc.createElement("div");
  box.className = MARK_CLASS;
  const left = Math.max(8, Math.min(x, winX.innerWidth - 380));
  const vertical =
    y < winX.innerHeight * 0.55
      ? `top:${y}px;`
      : `bottom:${winX.innerHeight - y + 28}px;`;
  box.style.cssText = `position:fixed;z-index:30;left:${left}px;${vertical}width:360px;max-height:50vh;overflow:auto;background:#fff;color:#222;border:1px solid ${color};border-radius:8px;padding:8px 10px;font:13px/1.45 system-ui;box-shadow:0 4px 16px rgba(0,0,0,.18);`;
  stopReaderEvents(box);

  const para = (text: string, style = "") => {
    const p = doc.createElement("div");
    p.textContent = text;
    p.style.cssText = `white-space:pre-wrap;margin-bottom:6px;${style}`;
    box.append(p);
  };

  if (mark.author === "agent") {
    para(mark.note || "", "");
  } else if (ask) {
    if (ask.markIDs.length > 1) {
      para(
        `Region [${refNumber(mark)}] of ${ask.markIDs.length}`,
        "color:#888;font-size:12px;",
      );
    }
    if (ask.prompt) para(`You: ${ask.prompt}`, "color:#555;");
    if (ask.take)
      para(`Your take: ${ask.take}`, "color:#555;font-style:italic;");
    para(
      ask.reply ?? (ask.seen ? `${agentName()} is looking…` : "Not seen yet."),
      ask.reply ? "" : "color:#888;font-style:italic;",
    );
  }

  const actions = doc.createElement("div");
  actions.style.cssText =
    "display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;";
  const action = (label: string, run: () => unknown) => {
    const b = doc.createElement("button");
    b.textContent = label;
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await run();
      } catch (e) {
        ztoolkit.log("readalong: action failed", e);
        b.disabled = false;
      }
    });
    actions.append(b);
  };
  action("Save as annotation", () => promoteMark(state.store, mark.id));
  action("Dismiss", async () => {
    // Dismissing one region of a sent ask dismisses just that region.
    const removed = state.store.removeMark(mark.id);
    await removeImage(removed?.imagePath);
  });
  action("Close", () => {
    view.openMarkID = undefined;
    redraw(view);
  });
  box.append(actions);
  return box;
}

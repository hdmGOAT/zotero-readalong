/**
 * How the reader makes regions: the selection popup, the toolbar, the
 * context menu, and box mode.
 *
 * There is one way to ask: every selection or box becomes a region chip in
 * the composer (sidebar.ts), where the reader writes the question and sends.
 */
import type { Mark } from "./marks";
import {
  boundingRect,
  normRect,
  removeImage,
  renderRegion,
  saveImage,
} from "./render";
import { revealComposer } from "./sidebar";
import { agentName, attach, COLOR, pageAt, state, type View } from "./view";

// ---------------------------------------------------------------------------
// Reader hooks

export function onSelectionPopup(event: any) {
  const { reader, doc, params, append } = event;
  // Copy out of the reader's compartment before the popup goes away
  const annotation = JSON.parse(JSON.stringify(params.annotation));
  const n = (state.store.draftFor(reader.itemID)?.markIDs.length ?? 0) + 1;

  const button = doc.createElement("button");
  button.className = "toolbar-button wide-button";
  button.textContent = `Ask ${agentName()} about this  [${n}]`;
  button.title = `Add as region [${n}] to your question`;
  button.style.cssText = `color:${COLOR};`;
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = `Added as [${n}]`;
    const mark = await createTextMark(reader, annotation);
    state.store.addToDraft(reader.itemID, mark.id);
    revealComposer();
  });
  append(button);
}

const TOOLBAR_CLASS = "readalong-toolbar";

function toolbarButtons(reader: any, doc: Document): HTMLElement {
  const group = doc.createElement("span");
  group.className = TOOLBAR_CLASS;
  group.style.cssText = "display:flex;align-items:center;gap:2px;";
  const b = doc.createElement("button");
  b.className = "toolbar-button";
  b.title = `Box a figure, equation or table to ask ${agentName()} about`;
  b.textContent = "⬚";
  b.style.cssText = `font-size:16px;color:${COLOR};`;
  b.addEventListener("click", () => void toggleBoxMode(reader));
  group.append(b);
  return group;
}

export function onToolbar(event: any) {
  const { reader, doc, append } = event;
  append(toolbarButtons(reader, doc));
  void attach(reader);
}

/**
 * Zotero renders plugin toolbar sections once, when a tab opens. Tabs that
 * were already open when the plugin loaded get the buttons inserted here.
 */
export function ensureToolbar(reader: any) {
  const doc: Document | undefined = reader._iframeWindow?.document;
  const sections = doc?.querySelector(".toolbar .custom-sections");
  if (!doc || !sections) return;
  removeLegacyButtons(doc);
  if (sections.querySelector(`.${TOOLBAR_CLASS}`)) return;
  const section = doc.createElement("div");
  section.className = "section";
  section.append(toolbarButtons(reader, doc));
  sections.append(section);
}

/** Remove our buttons (on shutdown, so a reload doesn't leave stale ones). */
export function removeToolbar(reader: any) {
  const doc: Document | undefined = reader._iframeWindow?.document;
  if (!doc) return;
  for (const el of doc.querySelectorAll(`.${TOOLBAR_CLASS}`)) {
    // Drop the wrapping section we (or Zotero) created, not just the group.
    (el.closest(".section") ?? el).remove();
  }
  removeLegacyButtons(doc);
}

/** 0.1.0-dev added an untagged button; find it by its title. */
function removeLegacyButtons(doc: Document) {
  for (const b of doc.querySelectorAll(
    ".toolbar .custom-sections button[title^='Mark a region for']",
  )) {
    (b.closest(".section") ?? b).remove();
  }
}

export function onViewContextMenu(event: any) {
  const { reader, append } = event;
  const { store } = state;
  append({
    label: `Ask ${agentName()} about a region…`,
    onCommand: () => void toggleBoxMode(reader),
  });
  if (store.marksFor(reader.itemID).length) {
    append({
      label: "Clear Read-Along marks",
      onCommand: () => {
        for (const m of store.clear(reader.itemID)) {
          void removeImage(m.imagePath);
        }
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Creating regions

async function cropImage(
  view: View | undefined,
  id: string,
  pageIndex: number,
  rect: number[],
) {
  if (!view) return undefined;
  try {
    return await saveImage(id, await renderRegion(view.win, pageIndex, rect));
  } catch (e) {
    ztoolkit.log("readalong: render failed", e);
    return undefined;
  }
}

async function createTextMark(reader: any, annotation: any): Promise<Mark> {
  const view = await attach(reader);
  const id = Zotero.Utilities.generateObjectKey();
  const { position } = annotation;
  return state.store.addMark({
    id,
    kind: "text",
    author: "user",
    attachmentID: reader.itemID,
    pageIndex: position.pageIndex,
    pageLabel: annotation.pageLabel ?? String(position.pageIndex + 1),
    position,
    sortIndex: annotation.sortIndex,
    text: annotation.text ?? "",
    imagePath: await cropImage(
      view,
      id,
      position.pageIndex,
      boundingRect(position.rects),
    ),
  });
}

async function createBoxMark(
  view: View,
  pageIndex: number,
  rect: number[],
): Promise<Mark> {
  const id = Zotero.Utilities.generateObjectKey();
  const pageView =
    view.win.PDFViewerApplication.pdfViewer.getPageView(pageIndex);
  const pageTop = pageView.viewport.viewBox[3];
  return state.store.addMark({
    id,
    kind: "box",
    author: "user",
    attachmentID: view.reader.itemID,
    pageIndex,
    pageLabel: pageView.pageLabel || String(pageIndex + 1),
    position: { pageIndex, rects: [rect] },
    sortIndex: [
      String(pageIndex).padStart(5, "0"),
      "000000",
      String(Math.max(0, Math.round(pageTop - rect[3]))).padStart(5, "0"),
    ].join("|"),
    text: "",
    imagePath: await cropImage(view, id, pageIndex, rect),
  });
}

// ---------------------------------------------------------------------------
// Box mode: a transparent overlay captures one drag so the reader's own
// selection and annotation tools never see it. The box becomes a region chip
// in the composer.

export async function toggleBoxMode(reader: any) {
  const view = await attach(reader);
  if (!view) return;
  if (view.boxMode) {
    view.boxMode();
    return;
  }
  const { doc, winX } = view;
  const container = doc.getElementById("viewerContainer")!;
  const n = (state.store.draftFor(reader.itemID)?.markIDs.length ?? 0) + 1;

  const overlay = doc.createElement("div");
  overlay.style.cssText = `position:fixed;inset:0;z-index:35;cursor:crosshair;background:rgba(139,92,246,.04);`;
  const hint = doc.createElement("div");
  hint.textContent = `Drag a box around what you want to ask about [${n}] · Esc to cancel`;
  hint.style.cssText = `position:fixed;top:8px;left:50%;transform:translateX(-50%);background:${COLOR};color:#fff;padding:3px 10px;border-radius:10px;font:12px system-ui;pointer-events:none;`;
  overlay.append(hint);
  const band = doc.createElement("div");
  band.style.cssText = `position:fixed;border:2px dashed ${COLOR};background:rgba(139,92,246,.12);display:none;`;
  overlay.append(band);
  doc.body!.append(overlay);

  let start: { x: number; y: number } | null = null;
  const bandRect = (e: PointerEvent) => ({
    left: Math.min(start!.x, e.clientX),
    top: Math.min(start!.y, e.clientY),
    right: Math.max(start!.x, e.clientX),
    bottom: Math.max(start!.y, e.clientY),
  });

  const exit = () => {
    overlay.remove();
    doc.removeEventListener("keydown", onKey, true);
    view.boxMode = undefined;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      exit();
    }
  };

  overlay.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    start = { x: e.clientX, y: e.clientY };
    overlay.setPointerCapture(e.pointerId);
    band.style.display = "block";
  });
  overlay.addEventListener("pointermove", (e: PointerEvent) => {
    if (!start) return;
    const r = bandRect(e);
    Object.assign(band.style, {
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.right - r.left}px`,
      height: `${r.bottom - r.top}px`,
    });
  });
  overlay.addEventListener("pointerup", async (e: PointerEvent) => {
    if (!start) return;
    const r = bandRect(e);
    start = null;
    exit();
    if (r.right - r.left < 6 || r.bottom - r.top < 6) return;
    const hit = pageAt(view, (r.left + r.right) / 2, (r.top + r.bottom) / 2);
    if (!hit) return;
    const mark = await createBoxMark(
      view,
      hit.pageIndex,
      clientRectToPdf(view, hit, r),
    );
    state.store.addToDraft(reader.itemID, mark.id);
    revealComposer();
  });
  overlay.addEventListener("wheel", (e: WheelEvent) => {
    const k =
      e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? container.clientHeight : 1;
    container.scrollBy(e.deltaX * k, e.deltaY * k);
  });
  doc.addEventListener("keydown", onKey, true);
  view.boxMode = exit;
  winX.focus();
}

function clientRectToPdf(
  view: View,
  hit: { pageIndex: number; wrapper: HTMLElement },
  r: { left: number; top: number; right: number; bottom: number },
) {
  const origin = hit.wrapper.getBoundingClientRect();
  const vp = view.win.PDFViewerApplication.pdfViewer.getPageView(
    hit.pageIndex,
  ).viewport;
  const clampX = (x: number) =>
    Math.min(Math.max(x - origin.left, 0), origin.width);
  const clampY = (y: number) =>
    Math.min(Math.max(y - origin.top, 0), origin.height);
  const [ax, ay] = vp.convertToPdfPoint(clampX(r.left), clampY(r.top));
  const [bx, by] = vp.convertToPdfPoint(clampX(r.right), clampY(r.bottom));
  return normRect([ax, ay, bx, by]).map((n) => Math.round(n * 1000) / 1000);
}

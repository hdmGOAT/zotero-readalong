/**
 * Attaching to a reader tab's pdf.js view, plus shared state for the reader
 * modules (interact, overlay, agent).
 */
import { getPref } from "../utils/prefs";
import type { MarkStore } from "./marks";
import { redraw } from "./overlay";
import { httpError } from "./promote";

export const COLOR = "#8b5cf6"; // user marks
export const AGENT_COLOR = "#0d9488"; // agent marks
export const DRAFT_COLOR = "#a78bfa"; // marks collected in a draft

export interface View {
  reader: any;
  /** pdf.js viewer window, Xrays waived (for PDFViewerApplication) */
  win: any;
  /** same window through Xrays (for DOM work) */
  winX: Window;
  doc: Document;
  /** mark whose popover is open */
  openMarkID?: string;
  /** set while box mode is active; calling it exits box mode */
  boxMode?: () => void;
  detach: () => void;
}

export const state = {
  store: undefined as unknown as MarkStore,
};

export const views = new Map<any, View>();

export const agentName = () => (getPref("agentName") as string) || "Claude";
export const Cu = () => Components.utils;

export async function attach(reader: any): Promise<View | undefined> {
  const win = await waitForPdfWindow(reader);
  if (!win) return undefined;

  const existing = views.get(reader);
  if (existing?.win === win) return existing;
  existing?.detach();

  const winX = Cu().unwaiveXrays(win) as Window;
  const onRendered = Cu().exportFunction(() => redraw(view), win);
  const eventBus = win.PDFViewerApplication.eventBus;
  eventBus.on("pagerendered", onRendered);
  eventBus.on("pagesloaded", onRendered);
  // Badges and popovers are position:fixed (see uiLayer); follow the page.
  const container = winX.document.getElementById("viewerContainer");
  let frame = 0;
  const onScroll = () => {
    if (frame) return;
    frame = winX.requestAnimationFrame(() => {
      frame = 0;
      redraw(view);
    });
  };
  container?.addEventListener("scroll", onScroll, { passive: true });
  winX.addEventListener("resize", onScroll);

  const view: View = {
    reader,
    win,
    winX,
    doc: winX.document,
    detach() {
      try {
        eventBus.off("pagerendered", onRendered);
        eventBus.off("pagesloaded", onRendered);
        container?.removeEventListener("scroll", onScroll);
        winX.removeEventListener("resize", onScroll);
        view.boxMode?.();
        view.doc.getElementById("readalong-ui")?.remove();
        for (const el of view.doc.querySelectorAll(".readalong-mark")) {
          el.remove();
        }
      } catch {
        // window already gone
      }
    },
  };
  views.set(reader, view);
  redraw(view);
  return view;
}

async function waitForPdfWindow(reader: any): Promise<any> {
  for (let i = 0; i < 100; i++) {
    if (reader._isClosed) return undefined;
    const win = reader._internalReader?._primaryView?._iframeWindow;
    if (win?.PDFViewerApplication?.pdfDocument) return win;
    if (reader._type && reader._type !== "pdf") return undefined; // EPUB/snapshot: not yet
    await Zotero.Promise.delay(100);
  }
  return undefined;
}

/**
 * Fixed layer in <body> for clickable UI. It must stay outside
 * #viewerContainer: the reader's window-level capture handlers start text
 * selection for pointer events on anything inside it.
 */
export function uiLayer(view: View): HTMLElement {
  let layer = view.doc.getElementById("readalong-ui") as HTMLElement | null;
  if (!layer) {
    layer = view.doc.createElement("div");
    layer.id = "readalong-ui";
    view.doc.body!.append(layer);
  }
  return layer;
}

export function activeReader(): any {
  return Zotero.Reader.getByTabID(
    Zotero.getMainWindow().Zotero_Tabs.selectedID,
  );
}

export interface PageRef {
  /** attachment key; defaults to the active reader tab */
  attachmentKey?: string;
  /** page label as printed ("iv", "12"), or */
  page?: string | number;
  /** zero-based page index */
  pageIndex?: number;
}

export async function viewFor(attachmentKey?: string): Promise<View> {
  const reader: any = attachmentKey
    ? Zotero.Reader._readers.find(
        (r: any) =>
          (Zotero.Items.get(r.itemID) || undefined)?.key === attachmentKey,
      )
    : activeReader();
  if (!reader) throw httpError(409, "that PDF is not open in a reader tab");
  const view = await attach(reader);
  if (!view) throw httpError(409, "the reader tab is not showing a PDF");
  return view;
}

export function resolvePageIndex(view: View, ref: PageRef): number {
  const viewer = view.win.PDFViewerApplication.pdfViewer;
  if (typeof ref.pageIndex === "number") {
    return checkPage(viewer, ref.pageIndex);
  }
  if (ref.page !== undefined) {
    const label = String(ref.page);
    for (let i = 0; i < viewer.pagesCount; i++) {
      if (viewer.getPageView(i)?.pageLabel === label) return i;
    }
    if (/^\d+$/.test(label)) return checkPage(viewer, Number(label) - 1);
    throw httpError(404, `no page labelled ${label}`);
  }
  return viewer.currentPageNumber - 1;
}

function checkPage(viewer: any, index: number) {
  if (index < 0 || index >= viewer.pagesCount) {
    throw httpError(404, `page index ${index} out of range`);
  }
  return index;
}

/** The rendered page under a viewport point, if any. */
export function pageAt(view: View, x: number, y: number) {
  for (const el of view.doc.elementsFromPoint(x, y)) {
    const page = el.closest?.(".page") as HTMLElement | null;
    if (!page) continue;
    const wrapper = page.querySelector(".canvasWrapper") as HTMLElement | null;
    if (!wrapper) return null;
    return { pageIndex: Number(page.dataset.pageNumber) - 1, wrapper };
  }
  return null;
}

/** Keep pointer events on our UI from reaching the reader. */
export function stopReaderEvents(el: HTMLElement) {
  for (const type of [
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "dblclick",
  ]) {
    el.addEventListener(type, (e: Event) => e.stopPropagation());
  }
}

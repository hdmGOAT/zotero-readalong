/**
 * What the agent can do in the reader: see what's open, look at pages, and
 * point at things by drawing its own (teal) marks.
 */
import { findQuote, pageText } from "./geometry";
import type { Mark } from "./marks";
import { httpError } from "./promote";
import { boundingRect, normRect, renderRegion, saveImage } from "./render";
import {
  activeReader,
  resolvePageIndex,
  state,
  viewFor,
  views,
  type PageRef,
} from "./view";

export async function activeReaderContext() {
  const reader = activeReader();
  if (!reader) return null;
  const attachment = Zotero.Items.get(reader.itemID) as Zotero.Item;
  const parent = attachment.parentItem;
  const viewer = views.get(reader)?.win.PDFViewerApplication.pdfViewer;
  const draft = state.store.draftFor(reader.itemID);
  return {
    title: (parent ?? attachment).getField("title"),
    itemKey: parent?.key ?? null,
    attachmentKey: attachment.key,
    pdfPath: (await attachment.getFilePathAsync()) || null,
    page: viewer?.currentPageLabel || viewer?.currentPageNumber || null,
    pageIndex: viewer ? viewer.currentPageNumber - 1 : null,
    marks: state.store.marksFor(reader.itemID).length,
    drafting: draft ? { regions: draft.markIDs.length } : null,
  };
}

export interface DrawRequest extends PageRef {
  /** exact text to highlight (whitespace/case-insensitive) */
  quote?: string;
  /** box as fractions of the page, top-left origin: [x1, y1, x2, y2] */
  frac?: number[];
  /** box in PDF points, bottom-left origin */
  rect?: number[];
  /** what the agent wants to say about it */
  note?: string;
  /** the ask this pointer answers; it then shows inside that reply */
  askID?: string;
  /** scroll the reader to the mark (default true) */
  navigate?: boolean;
}

export async function drawAgentMark(req: DrawRequest): Promise<Mark> {
  const ask = req.askID ? state.store.resolveAsk(req.askID) : undefined;
  if (req.askID && !ask) throw httpError(404, `no ask ${req.askID}`);
  const view = await viewFor(req.attachmentKey);
  const pageIndex = resolvePageIndex(view, req);
  const pageView =
    view.win.PDFViewerApplication.pdfViewer.getPageView(pageIndex);
  const [px1, py1, px2, py2] = Array.from(
    pageView.viewport.viewBox as number[],
  );

  let kind: Mark["kind"] = "box";
  let rects: number[][];
  let text = "";
  let charIndex = 0;
  if (req.quote) {
    const match = await findQuote(view.win, pageIndex, req.quote);
    if (!match) {
      throw httpError(422, `quote not found on page index ${pageIndex}`);
    }
    kind = "text";
    rects = match.rects;
    text = req.quote;
    charIndex = match.charIndex;
  } else if (req.frac?.length === 4) {
    const [fx1, fy1, fx2, fy2] = req.frac;
    const w = px2 - px1;
    const h = py2 - py1;
    rects = [
      normRect([px1 + fx1 * w, py2 - fy1 * h, px1 + fx2 * w, py2 - fy2 * h]),
    ];
  } else if (req.rect?.length === 4) {
    rects = [normRect(req.rect)];
  } else {
    throw httpError(400, "give one of quote, frac, or rect");
  }

  const id = Zotero.Utilities.generateObjectKey();
  const bounds = boundingRect(rects);
  let imagePath: string | undefined;
  try {
    imagePath = await saveImage(
      id,
      await renderRegion(view.win, pageIndex, bounds),
    );
  } catch (e) {
    ztoolkit.log("readalong: render failed", e);
  }
  const mark = state.store.addMark({
    id,
    kind,
    author: "agent",
    attachmentID: view.reader.itemID,
    pageIndex,
    pageLabel: pageView.pageLabel || String(pageIndex + 1),
    position: { pageIndex, rects },
    sortIndex: [
      String(pageIndex).padStart(5, "0"),
      String(charIndex).padStart(6, "0"),
      String(Math.max(0, Math.round(py2 - bounds[3]))).padStart(5, "0"),
    ].join("|"),
    text,
    note: req.note ?? "",
    askID: ask?.id,
    imagePath,
  });
  if (req.navigate !== false) {
    view.reader.navigate({ position: { pageIndex, rects } });
  }
  return mark;
}

/** Render a whole page so the agent can see the layout before drawing. */
export async function snapshotPage(ref: PageRef) {
  const view = await viewFor(ref.attachmentKey);
  const pageIndex = resolvePageIndex(view, ref);
  const pageView =
    view.win.PDFViewerApplication.pdfViewer.getPageView(pageIndex);
  const box = Array.from(pageView.viewport.viewBox as number[]);
  const key = (Zotero.Items.get(view.reader.itemID) as Zotero.Item).key;
  const imagePath = await saveImage(
    `page-${key}-${pageIndex}`,
    await renderRegion(view.win, pageIndex, box, 0),
  );
  return {
    imagePath,
    attachmentKey: key,
    pageIndex,
    page: pageView.pageLabel || String(pageIndex + 1),
    sizePt: [box[2] - box[0], box[3] - box[1]],
    note: "frac coordinates for /draw are fractions of this image, top-left origin",
  };
}

export async function readPageText(ref: PageRef) {
  const view = await viewFor(ref.attachmentKey);
  const pageIndex = resolvePageIndex(view, ref);
  return { pageIndex, text: await pageText(view.win, pageIndex) };
}

/**
 * Rendering marked regions to PNG so agents can look at figures, equations,
 * and tables, not just extracted text.
 */

const PAD = 4; // PDF points of context around the region
const MAX_SIDE = 2000; // px cap for the longest side of a crop

/** Normalize [x1, y1, x2, y2] so x1 <= x2 and y1 <= y2. */
export function normRect(r: ArrayLike<number>): number[] {
  return [
    Math.min(r[0], r[2]),
    Math.min(r[1], r[3]),
    Math.max(r[0], r[2]),
    Math.max(r[1], r[3]),
  ];
}

export function boundingRect(rects: number[][]): number[] {
  return [
    Math.min(...rects.map((r) => r[0])),
    Math.min(...rects.map((r) => r[1])),
    Math.max(...rects.map((r) => r[2])),
    Math.max(...rects.map((r) => r[3])),
  ];
}

/**
 * Render a PDF-space rect of one page into a PNG data URL.
 * @param win the pdf.js viewer window, with Xrays waived
 */
/**
 * Fetch a pdf.js page proxy. Values resolved from content promises come back
 * behind Xrays, which hide pdf.js's methods, so waive them explicitly.
 */
export async function getPage(win: any, pageIndex: number): Promise<any> {
  return Components.utils.waiveXrays(
    await win.PDFViewerApplication.pdfDocument.getPage(pageIndex + 1),
  );
}

export async function renderRegion(
  win: any,
  pageIndex: number,
  pdfRect: number[],
  pad = PAD,
): Promise<string> {
  const page = await getPage(win, pageIndex);
  const [x1, y1, x2, y2] = normRect([
    pdfRect[0] - pad,
    pdfRect[1] - pad,
    pdfRect[2] + pad,
    pdfRect[3] + pad,
  ]);
  const scale = Math.min(3, MAX_SIDE / Math.max(x2 - x1, y2 - y1, 1));

  const vpArgs = new win.Object();
  vpArgs.scale = scale;
  const viewport = page.getViewport(vpArgs);
  const [vx1, vy1, vx2, vy2] = normRect(
    viewport.convertToViewportRectangle(
      Components.utils.cloneInto([x1, y1, x2, y2], win),
    ),
  );

  const canvas = win.document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(vx2 - vx1));
  canvas.height = Math.max(1, Math.ceil(vy2 - vy1));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const renderArgs = new win.Object();
  renderArgs.canvasContext = ctx;
  renderArgs.viewport = viewport;
  renderArgs.transform = Components.utils.cloneInto(
    [1, 0, 0, 1, -vx1, -vy1],
    win,
  );
  await page.render(renderArgs).promise;
  const url: string = canvas.toDataURL("image/png");
  canvas.width = canvas.height = 0;
  return url;
}

export function imageDir(): string {
  return PathUtils.join(PathUtils.tempDir, "zotero-readalong");
}

/** Write a PNG data URL to the temp image dir; returns the file path. */
export async function saveImage(id: string, dataURL: string): Promise<string> {
  const atob = ztoolkit.getGlobal("atob");
  const bin = atob(dataURL.slice(dataURL.indexOf(",") + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  await IOUtils.makeDirectory(imageDir(), { ignoreExisting: true });
  const path = PathUtils.join(imageDir(), `${id}.png`);
  await IOUtils.write(path, bytes);
  return path;
}

export async function removeImage(path?: string) {
  if (!path) return;
  try {
    await IOUtils.remove(path, { ignoreAbsent: true });
  } catch (e) {
    ztoolkit.log("readalong: failed to remove image", e);
  }
}

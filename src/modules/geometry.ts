import { getPage } from "./render";

/**
 * Locating text on a PDF page, so an agent can say "highlight this sentence"
 * instead of computing coordinates.
 */

interface CharRef {
  item: number;
  offset: number;
}

export interface TextMatch {
  rects: number[][];
  text: string;
  /** index of the first matched char in the page's text, for sortIndex */
  charIndex: number;
}

const normChar = (c: string) => (/\s/.test(c) ? " " : c.toLowerCase());

/**
 * Find `quote` on a page (case- and whitespace-insensitive, tolerant of
 * end-of-line hyphenation) and return one rect per text run it covers.
 * @param win the pdf.js viewer window, with Xrays waived
 */
export async function findQuote(
  win: any,
  pageIndex: number,
  quote: string,
): Promise<TextMatch | null> {
  const page = await getPage(win, pageIndex);
  const content = Components.utils.waiveXrays(await page.getTextContent());
  const items: any[] = Array.from(content.items).filter(
    (it: any) => typeof it.str === "string",
  );

  // Build a normalized page string with a map back to (item, offset).
  let text = "";
  const refs: CharRef[] = [];
  const push = (c: string, ref: CharRef) => {
    const n = normChar(c);
    if (n === " " && (text === "" || text.endsWith(" "))) return;
    text += n;
    refs.push(ref);
  };
  items.forEach((it, i) => {
    const str: string = it.str;
    const hyphenated = it.hasEOL && str.endsWith("-");
    const end = hyphenated ? str.length - 1 : str.length;
    for (let j = 0; j < end; j++) push(str[j], { item: i, offset: j });
    if (it.hasEOL && !hyphenated) push(" ", { item: i, offset: str.length });
  });

  const needle = quote
    .split("")
    .map(normChar)
    .join("")
    .replace(/ +/g, " ")
    .trim();
  if (!needle) return null;
  const at = text.indexOf(needle);
  if (at < 0) return null;

  // Collect the [start, end) char span per item, then turn spans into rects.
  const spans = new Map<number, [number, number]>();
  for (let k = at; k < at + needle.length; k++) {
    const { item, offset } = refs[k];
    if (offset >= items[item].str.length) continue; // synthetic space
    const span = spans.get(item);
    if (span) span[1] = offset + 1;
    else spans.set(item, [offset, offset + 1]);
  }

  const rects: number[][] = [];
  for (const [i, [s, e]] of spans) {
    const it = items[i];
    const len = it.str.length || 1;
    const [, , , , x, y] = it.transform;
    const h = it.height || Math.hypot(it.transform[2], it.transform[3]);
    rects.push([
      round(x + (it.width * s) / len),
      round(y - h * 0.25),
      round(x + (it.width * e) / len),
      round(y + h * 0.9),
    ]);
  }
  if (!rects.length) return null;
  return { rects, text: quote, charIndex: at };
}

/** Plain text of a page, for agents that want to look before drawing. */
export async function pageText(win: any, pageIndex: number): Promise<string> {
  const page = await getPage(win, pageIndex);
  const content = Components.utils.waiveXrays(await page.getTextContent());
  return Array.from(content.items)
    .map((it: any) => (it.str ?? "") + (it.hasEOL ? "\n" : ""))
    .join("");
}

const round = (n: number) => Math.round(n * 1000) / 1000;

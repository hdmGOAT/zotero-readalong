/**
 * Promote an ephemeral mark to a real Zotero annotation.
 */
import type { Ask, Mark, MarkStore } from "./marks";
import { removeImage } from "./render";

const DEFAULT_COLOR = "#a28ae5"; // Zotero's purple

export interface PromoteOptions {
  comment?: string;
  color?: string;
}

export async function promoteMark(
  store: MarkStore,
  id: string,
  opts: PromoteOptions = {},
): Promise<{ annotationKey: string }> {
  const mark = store.getMark(id);
  if (!mark) throw httpError(404, `no mark ${id}`);
  const attachment = Zotero.Items.get(mark.attachmentID);
  if (!attachment) throw httpError(404, "attachment no longer exists");

  const ask = mark.askID ? store.getAsk(mark.askID) : undefined;
  await Zotero.Annotations.saveFromJSON(
    attachment,
    // saveFromJSON only reads the fields we set; the type wants a full item
    toAnnotationJSON(mark, ask, opts) as any,
  );
  store.removeMark(id);
  await removeImage(mark.imagePath);
  return { annotationKey: mark.id };
}

/** Default comment: the agent's note, or the exchange the mark was part of. */
function defaultComment(mark: Mark, ask?: Ask) {
  if (mark.author === "agent") return mark.note ?? "";
  if (!ask) return "";
  return [
    ask.prompt && `Q: ${ask.prompt}`,
    ask.take && `My take: ${ask.take}`,
    ask.reply && `A: ${ask.reply}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function toAnnotationJSON(
  mark: Mark,
  ask: Ask | undefined,
  opts: PromoteOptions,
) {
  return {
    key: mark.id,
    type: mark.kind === "text" ? "highlight" : "image",
    text: mark.kind === "text" ? mark.text : undefined,
    comment: opts.comment ?? defaultComment(mark, ask),
    color: opts.color ?? DEFAULT_COLOR,
    pageLabel: mark.pageLabel,
    sortIndex: mark.sortIndex,
    position: mark.position,
    tags: [],
  };
}

export function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

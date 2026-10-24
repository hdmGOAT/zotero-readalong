/**
 * HTTP protocol for agents, mounted on Zotero's local server
 * (http://127.0.0.1:23119/readalong/...). See docs/protocol.md.
 *
 * Zotero refuses requests that look like they come from a web page, so only
 * local programs (curl, the `readalong` CLI, an agent) can reach these.
 */
import { version } from "../../package.json";
import {
  activeReaderContext,
  drawAgentMark,
  readPageText,
  snapshotPage,
} from "./agent";
import type { Ask, Mark, MarkStore } from "./marks";
import { httpError, promoteMark } from "./promote";
import { removeImage } from "./render";
import type { PageRef } from "./view";

const PREFIX = "/readalong";
const MAX_WAIT_S = 3600;

interface Request {
  method: string;
  searchParams: URLSearchParams;
  data: any;
}

type Handler = (req: Request) => Promise<unknown>;

const registered: string[] = [];

export function registerEndpoints(store: MarkStore) {
  const routes: Record<string, [string[], Handler]> = {
    "/ping": [
      ["GET"],
      async () => ({
        name: addon.data.config.addonName,
        version,
        epoch: store.epoch,
        seq: store.currentSeq,
      }),
    ],

    "/context": [["GET"], async () => (await activeReaderContext()) ?? {}],

    // Everything currently in the reader: asks (with their regions) and the
    // agent's own marks. Draft regions aren't included until sent.
    "/marks": [
      ["GET"],
      async () => ({
        epoch: store.epoch,
        seq: store.currentSeq,
        asks: await Promise.all(
          store.allAsks().map((a) => serializeAsk(store, a)),
        ),
        agentMarks: await Promise.all(
          store
            .allMarks()
            .filter((m) => m.author === "agent")
            .map(serialize),
        ),
      }),
    ],

    // Long-poll: returns as soon as there is an ask with seq > after.
    "/next": [
      ["GET"],
      async ({ searchParams }) => {
        // A position from an earlier plugin session means nothing now.
        const sameEpoch = searchParams.get("epoch") === store.epoch;
        const after = sameEpoch ? Number(searchParams.get("after") ?? 0) : 0;
        const timeout = Math.min(
          Number(searchParams.get("timeout") ?? 0),
          MAX_WAIT_S,
        );
        await store.waitForNewer(after, timeout * 1000);
        const asks = store.asksNewerThan(after);
        for (const a of asks) store.updateAsk(a.id, { seen: true });
        return {
          epoch: store.epoch,
          seq: store.currentSeq,
          asks: await Promise.all(asks.map((a) => serializeAsk(store, a))),
        };
      },
    ],

    // Agent draws on the page: a quote to highlight, or a box.
    "/draw": [
      ["POST"],
      async ({ data }) => serialize(await drawAgentMark(data ?? {})),
    ],

    "/snapshot": [
      ["GET"],
      async ({ searchParams }) => snapshotPage(pageRef(searchParams)),
    ],

    "/text": [
      ["GET"],
      async ({ searchParams }) => readPageText(pageRef(searchParams)),
    ],

    // Dev loop: reload the plugin from disk after `npm run build`.
    "/reload": [
      ["POST"],
      async () => {
        const { AddonManager } = ChromeUtils.importESModule(
          "resource://gre/modules/AddonManager.sys.mjs",
        );
        const self = await AddonManager.getAddonByID(addon.data.config.addonID);
        // Reply first; reloading tears down this endpoint.
        ztoolkit.getGlobal("setTimeout")(() => self?.reload(), 100);
        return { reloading: true };
      },
    ],

    "/reply": [
      ["POST"],
      async ({ data }) => {
        // id: an ask, or any region of one
        const { id, text } = data ?? {};
        if (!store.updateAsk(id, { reply: String(text ?? "") })) {
          throw httpError(404, `no ask ${id}`);
        }
        return { ok: true };
      },
    ],

    "/promote": [
      ["POST"],
      async ({ data }) => promoteMark(store, data?.id, data ?? {}),
    ],

    "/dismiss": [
      ["POST"],
      async ({ data }) => {
        // id: a mark, or an ask (dismisses all its regions)
        if (data?.all) {
          const removed = store.clear();
          for (const m of removed) await removeImage(m.imagePath);
          return { dismissed: removed.length };
        }
        const ask = store.getAsk(data?.id);
        const ids: string[] = ask ? [...ask.markIDs] : [data?.id];
        for (const id of ids) {
          const mark = store.removeMark(id);
          if (!mark) throw httpError(404, `no mark or ask ${id}`);
          await removeImage(mark.imagePath);
        }
        return { dismissed: ids.length };
      },
    ],
  };

  for (const [path, [methods, handler]] of Object.entries(routes)) {
    mount(PREFIX + path, methods, handler);
  }
}

function pageRef(params: URLSearchParams): PageRef {
  const index = params.get("pageIndex");
  return {
    attachmentKey: params.get("attachmentKey") ?? undefined,
    page: params.get("page") ?? undefined,
    pageIndex: index === null ? undefined : Number(index),
  };
}

export function unregisterEndpoints() {
  for (const path of registered.splice(0)) {
    delete (Zotero.Server.Endpoints as any)[path];
  }
}

function mount(path: string, methods: string[], handler: Handler) {
  const Endpoint = function () {} as any;
  Endpoint.prototype = {
    supportedMethods: methods,
    supportedDataTypes: ["application/json"],
    permitBookmarklet: false,
    // Zotero picks the calling convention from init.length; keep it at 1.
    init: async function (req: Request) {
      try {
        const body = await handler(req);
        return [200, "application/json", JSON.stringify(body ?? {})];
      } catch (e: any) {
        if (!e?.status) Zotero.logError(e);
        return [
          e?.status ?? 500,
          "application/json",
          JSON.stringify({ error: String(e?.message ?? e) }),
        ];
      }
    },
  };
  (Zotero.Server.Endpoints as any)[path] = Endpoint;
  registered.push(path);
}

async function itemInfo(attachmentID: number) {
  const attachment = Zotero.Items.get(attachmentID) || undefined;
  const parent = attachment?.parentItem;
  return {
    title: (parent ?? attachment)?.getField("title") ?? "",
    itemKey: parent?.key ?? null,
    attachmentKey: attachment?.key ?? null,
    pdfPath: (await attachment?.getFilePathAsync()) || null,
  };
}

function regionOf(mark: Mark) {
  return {
    id: mark.id,
    kind: mark.kind,
    text: mark.text,
    page: mark.pageLabel,
    pageIndex: mark.pageIndex,
    rects: mark.position.rects,
    imagePath: mark.imagePath ?? null,
  };
}

async function serialize(mark: Mark) {
  return {
    ...regionOf(mark),
    author: mark.author,
    note: mark.note ?? null,
    askID: mark.askID ?? null,
    createdAt: mark.createdAt,
    item: await itemInfo(mark.attachmentID),
  };
}

function inReplyTo(store: MarkStore, ask: Ask) {
  const parent = ask.parentID ? store.getAsk(ask.parentID) : undefined;
  if (!parent) return null;
  return {
    id: parent.id,
    prompt: parent.prompt,
    take: parent.take,
    reply: parent.reply ?? null,
  };
}

async function serializeAsk(store: MarkStore, ask: Ask) {
  return {
    id: ask.id,
    seq: ask.seq,
    prompt: ask.prompt,
    take: ask.take,
    reply: ask.reply ?? null,
    // Follow-ups carry the exchange they respond to.
    inReplyTo: inReplyTo(store, ask),
    createdAt: ask.createdAt,
    item: await itemInfo(ask.attachmentID),
    // In order: regions[0] is what the prompt calls [1].
    regions: ask.markIDs
      .map((id) => store.getMark(id))
      .filter((m): m is Mark => !!m)
      .map(regionOf),
  };
}

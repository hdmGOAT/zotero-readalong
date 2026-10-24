/**
 * Wires the reader modules into Zotero: event hooks on every reader tab,
 * redraws on store changes, and teardown.
 *
 * - view.ts      attaching to pdf.js views, shared state
 * - interact.ts  how the reader makes marks and asks (popup, box mode, drafts)
 * - overlay.ts   drawing marks, popovers, and the draft panel
 * - agent.ts     what the agent can do (context, snapshots, drawing)
 */
import {
  ensureToolbar,
  onSelectionPopup,
  onToolbar,
  onViewContextMenu,
  removeToolbar,
} from "./interact";
import type { MarkStore } from "./marks";
import { redrawAll } from "./overlay";
import { attach, state, views } from "./view";

let unsubscribe: (() => void) | undefined;

export function registerReader(store: MarkStore) {
  state.store = store;
  const id = addon.data.config.addonID;
  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    onSelectionPopup,
    id,
  );
  Zotero.Reader.registerEventListener("renderToolbar", onToolbar, id);
  Zotero.Reader.registerEventListener(
    "createViewContextMenu",
    onViewContextMenu,
    id,
  );
  unsubscribe = store.onChange(redrawAll);
  for (const reader of Zotero.Reader._readers) {
    ensureToolbar(reader);
    void attach(reader);
  }
}

export function unregisterReader() {
  unsubscribe?.();
  (Zotero.Reader as any)._unregisterEventListenerByPluginID(
    addon.data.config.addonID,
  );
  for (const reader of Zotero.Reader._readers) removeToolbar(reader);
  for (const view of views.values()) view.detach();
  views.clear();
}

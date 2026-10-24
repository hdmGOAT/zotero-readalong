/**
 * In-memory store of ephemeral marks and the asks that group them.
 *
 * A *mark* is a region of a page (a text selection or a box). An *ask* is
 * what the reader sends to the agent: a prompt, optionally the reader's own
 * take on it, and any number of marks. Marks being collected for an ask that
 * hasn't been sent yet sit in that attachment's *draft*.
 *
 * None of this is a Zotero item: it lives only as long as the plugin is
 * loaded, never syncs, and never touches the user's annotations unless a mark
 * is explicitly promoted (see promote.ts).
 */

export type MarkKind = "text" | "box";
/** Who made the mark: the reader (user) or the agent drawing on the page. */
export type MarkAuthor = "user" | "agent";

export interface MarkPosition {
  pageIndex: number;
  rects: number[][];
  [key: string]: unknown;
}

export interface Mark {
  /** Also used as the annotation key if the mark is promoted. */
  id: string;
  kind: MarkKind;
  author: MarkAuthor;
  attachmentID: number;
  pageIndex: number;
  pageLabel: string;
  position: MarkPosition;
  sortIndex: string;
  /** Selected text (text marks only). */
  text: string;
  /** PNG crop of the marked region, written to the temp dir. */
  imagePath?: string;
  /**
   * User marks: the ask this region was sent with (unset while drafting).
   * Agent marks: the ask this pointer answers, if any.
   */
  askID?: string;
  /** Agent marks: what the agent wants to point out. */
  note?: string;
  createdAt: string;
}

export interface Ask {
  id: string;
  /** Monotonic sequence number; agents poll with `after=<seq>`. */
  seq: number;
  attachmentID: number;
  /** The question, referring to marks as [1], [2], … in `markIDs` order. */
  prompt: string;
  /** What the reader thinks before asking: a guess, prediction, or reading. */
  take: string;
  markIDs: string[];
  /** Set when this ask responds to an earlier ask's reply (a follow-up). */
  parentID?: string;
  /** The agent's answer, shown in the reader. */
  reply?: string;
  /** Set once an agent has fetched the ask. */
  seen?: boolean;
  createdAt: string;
}

export interface Draft {
  markIDs: string[];
  prompt: string;
  take: string;
  /** The ask being responded to, if this draft is a follow-up. */
  parentID?: string;
}

export type NewMark = Omit<Mark, "createdAt">;

export class MarkStore {
  /**
   * Identifies this store instance. seq restarts at 0 whenever the plugin
   * (re)loads, so pollers must reset their position when the epoch changes.
   */
  readonly epoch = Date.now().toString(36);

  private marks = new Map<string, Mark>();
  private asks = new Map<string, Ask>();
  private drafts = new Map<number, Draft>();
  private seq = 0;
  private waiters = new Set<() => void>();
  private listeners = new Set<() => void>();

  get currentSeq() {
    return this.seq;
  }

  // -- marks ----------------------------------------------------------------

  allMarks(): Mark[] {
    return [...this.marks.values()];
  }

  getMark(id: string): Mark | undefined {
    return this.marks.get(id);
  }

  marksFor(attachmentID: number): Mark[] {
    return this.allMarks().filter((m) => m.attachmentID === attachmentID);
  }

  addMark(mark: NewMark): Mark {
    const full: Mark = { ...mark, createdAt: new Date().toISOString() };
    this.marks.set(full.id, full);
    this.emit();
    return full;
  }

  /** Remove a mark and unlink it from its ask or draft. */
  removeMark(id: string): Mark | undefined {
    const mark = this.marks.get(id);
    if (!mark) return undefined;
    this.marks.delete(id);
    const draft = this.drafts.get(mark.attachmentID);
    if (draft) draft.markIDs = draft.markIDs.filter((m) => m !== id);
    const ask =
      mark.author === "user" && mark.askID
        ? this.asks.get(mark.askID)
        : undefined;
    if (ask) {
      ask.markIDs = ask.markIDs.filter((m) => m !== id);
      if (!ask.markIDs.length && !ask.prompt) this.asks.delete(ask.id);
    }
    this.emit();
    return mark;
  }

  // -- drafts ---------------------------------------------------------------

  draftFor(attachmentID: number): Draft | undefined {
    return this.drafts.get(attachmentID);
  }

  openDraft(attachmentID: number): Draft {
    let draft = this.drafts.get(attachmentID);
    if (!draft) {
      draft = { markIDs: [], prompt: "", take: "" };
      this.drafts.set(attachmentID, draft);
      this.emit();
    }
    return draft;
  }

  addToDraft(attachmentID: number, markID: string) {
    this.openDraft(attachmentID).markIDs.push(markID);
    this.emit();
  }

  /** Update draft text without re-rendering (the reader is typing it). */
  setDraftText(
    attachmentID: number,
    text: Partial<Pick<Draft, "prompt" | "take">>,
  ) {
    Object.assign(this.openDraft(attachmentID), text);
  }

  /** Make the draft a follow-up to an ask (or clear that with undefined). */
  setDraftParent(attachmentID: number, parentID: string | undefined) {
    this.openDraft(attachmentID).parentID = parentID;
    this.emit();
  }

  /** Close the draft; its marks are removed. Returns them for cleanup. */
  discardDraft(attachmentID: number): Mark[] {
    const draft = this.drafts.get(attachmentID);
    if (!draft) return [];
    this.drafts.delete(attachmentID);
    const removed = draft.markIDs
      .map((id) => this.marks.get(id))
      .filter((m): m is Mark => !!m);
    for (const m of removed) this.marks.delete(m.id);
    this.emit();
    return removed;
  }

  /** Turn the draft into an ask. */
  sendDraft(attachmentID: number): Ask | undefined {
    const draft = this.drafts.get(attachmentID);
    if (!draft || (!draft.markIDs.length && !draft.prompt.trim())) {
      return undefined;
    }
    this.drafts.delete(attachmentID);
    return this.addAsk(attachmentID, draft);
  }

  // -- asks -----------------------------------------------------------------

  allAsks(): Ask[] {
    return [...this.asks.values()];
  }

  getAsk(id: string): Ask | undefined {
    return this.asks.get(id);
  }

  addAsk(
    attachmentID: number,
    {
      prompt,
      take,
      markIDs,
      parentID,
    }: Pick<Ask, "prompt" | "take" | "markIDs" | "parentID">,
  ): Ask {
    const ask: Ask = {
      id: Zotero.Utilities.generateObjectKey(),
      seq: ++this.seq,
      attachmentID,
      prompt: prompt.trim(),
      take: take.trim(),
      markIDs: [...markIDs],
      parentID: parentID && this.asks.has(parentID) ? parentID : undefined,
      createdAt: new Date().toISOString(),
    };
    this.asks.set(ask.id, ask);
    for (const id of markIDs) {
      const mark = this.marks.get(id);
      if (mark) mark.askID = ask.id;
    }
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    this.emit();
    return ask;
  }

  /** Accepts an ask id, or the id of any mark in it. */
  resolveAsk(id: string): Ask | undefined {
    return this.asks.get(id) ?? this.asks.get(this.marks.get(id)?.askID ?? "");
  }

  updateAsk(id: string, patch: Partial<Ask>): Ask | undefined {
    const ask = this.resolveAsk(id);
    if (!ask) return undefined;
    Object.assign(ask, patch);
    this.emit();
    return ask;
  }

  /** Follow-ups to an ask, oldest first. */
  childrenOf(id: string): Ask[] {
    return this.allAsks()
      .filter((a) => a.parentID === id)
      .sort((a, b) => a.seq - b.seq);
  }

  /** Agent pointers drawn in answer to an ask. */
  pointersFor(askID: string): Mark[] {
    return this.allMarks().filter(
      (m) => m.author === "agent" && m.askID === askID,
    );
  }

  /**
   * Remove an ask with its follow-ups, regions and pointers. Returns the
   * removed marks (for image cleanup).
   */
  removeAsk(id: string): Mark[] {
    const ask = this.asks.get(id);
    if (!ask) return [];
    const removed: Mark[] = [];
    const drop = (a: Ask) => {
      for (const child of this.childrenOf(a.id)) drop(child);
      this.asks.delete(a.id);
      for (const m of this.allMarks()) {
        if (m.askID === a.id) {
          this.marks.delete(m.id);
          removed.push(m);
        }
      }
    };
    drop(ask);
    this.emit();
    return removed;
  }

  asksNewerThan(seq: number): Ask[] {
    return this.allAsks().filter((a) => a.seq > seq);
  }

  // -- clearing -------------------------------------------------------------

  /** Remove everything (for one attachment, or all). Returns removed marks. */
  clear(attachmentID?: number): Mark[] {
    const match = (a: number) =>
      attachmentID === undefined || a === attachmentID;
    const removed = this.allMarks().filter((m) => match(m.attachmentID));
    for (const m of removed) this.marks.delete(m.id);
    for (const a of this.allAsks()) {
      if (match(a.attachmentID)) this.asks.delete(a.id);
    }
    for (const key of [...this.drafts.keys()]) {
      if (match(key)) this.drafts.delete(key);
    }
    this.emit();
    return removed;
  }

  // -- long-polling and change notification ---------------------------------

  /** Resolve once an ask newer than `after` exists, or after `timeoutMs`. */
  waitForNewer(after: number, timeoutMs: number): Promise<void> {
    if (this.seq > after || timeoutMs <= 0) return Promise.resolve();
    const setTimeout = ztoolkit.getGlobal("setTimeout");
    const clearTimeout = ztoolkit.getGlobal("clearTimeout");
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, timeoutMs);
      this.waiters.add(wake);
    });
  }

  /** Release any pending long-polls (used on shutdown). */
  releaseWaiters() {
    for (const wake of [...this.waiters]) wake();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (e) {
        ztoolkit.log("readalong: listener failed", e);
      }
    }
  }
}

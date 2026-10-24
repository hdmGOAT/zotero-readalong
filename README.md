# Zotero Read-Along

A study partner for reading papers, not a summarizer.

> **Status: early (v0.1).** Developed and tested on Zotero 10 on Linux with
> Claude Code. Expect rough edges; issues and PRs welcome.

Read-Along connects the Zotero reader to an AI agent you already work with
(built for [Claude Code](https://claude.com/claude-code)) so you can think
out loud while reading: point at a passage, box a figure, or gather several
regions and write a real question about how they connect, together with your
own guess about it. The agent responds to _your_ reasoning, points you to where
the answer is on the page, and checks your understanding.

It is deliberately **not** "ask the AI to explain the paper." Understanding
comes from doing the work: noticing what confuses you, forming a guess,
checking it against the text. The tool is shaped to keep you doing that work:

- **You start every exchange.** The agent never summarizes or explains
  unprompted; it answers what you asked.
- **Asking takes thought, cheaply.** The composer lets you collect regions
  across pages and phrase a precise question (`how does [1] follow from
[2]?`), which is half of understanding it.
- **Your guess comes first.** The composer has a "my guess" field for what you think
  before asking. Explaining your own understanding, then getting feedback on
  it, sticks far better than reading an explanation (self-explanation and
  retrieval practice are among the most robust findings in learning research).
- **Pointing over telling.** When the answer is in the paper, the agent marks
  where to look instead of pasting it.
- **Scratch, not clutter.** Marks live in memory, never sync, and never touch
  your annotations, until you decide something is worth keeping and promote it
  to a real Zotero annotation that records the exchange.

The protocol is plain HTTP, so any agent that can run a command can use it;
the agent's behavior lives in [skill/readalong/SKILL.md](skill/readalong/SKILL.md).

```
 Zotero reader                          your terminal (Claude Code, etc.)
 ─────────────                          ─────────────────────────────────
 sidebar: regions [1] [2] [3]
   + question + your guess         ──▶  readalong wait → sees every region
                                                         (text + PNG crop)
                                        responds to your guess, hints first
 reply in the sidebar thread       ◀──  readalong reply
 teal 📍 "look here" pointers       ◀──  readalong draw --ask ID --quote "..."
 "Keep"                            ──▶  real Zotero annotation with the exchange
```

## Why not an existing plugin?

There are good AI plugins for Zotero. They make a different trade-off
(as described in their READMEs, October 2026):

|                                                                                          | Where the AI lives                                                                                                            | What it sees                                            | Writes to your library                             |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| [llm-for-zotero](https://github.com/yilewang/llm-for-zotero)                             | Chat sidebar inside Zotero; many backends incl. an experimental Claude Code bridge that runs a _separate_ Claude conversation | Paper, selected text, screenshots, library (agent mode) | Yes, via agent tools (notes, tags, `annotate_pdf`) |
| [Annota](https://github.com/Liotou/zotero-annota)                                        | Prompt per highlight color, plus side-panel chat; backends incl. `claude -p`                                                  | The highlight you just made                             | Yes: every highlight's comment is auto-filled      |
| [PapersGPT](https://github.com/papersgpt/papersgpt-for-zotero), Zotero-easyGPT, BibGenie | Chat panel inside Zotero                                                                                                      | Paper / library                                         | Varies                                             |
| [zotero-mcp](https://github.com/54yyyu/zotero-mcp) and other MCP servers                 | Your agent, outside Zotero                                                                                                    | Library, metadata, existing annotations                 | Some can create annotations                        |
| **Read-Along**                                                                           | **Your existing agent session, outside Zotero**                                                                               | **What you point at, as text and pixels**               | **Only when you promote a mark**                   |

What's different here:

1. **Built for learning, not offloading.** Most tools optimize for getting
   answers fast. This one optimizes for you understanding the paper (above).
2. **The agent stays where your context is.** Your terminal session already
   has your notes, project, memory and tools. Zotero becomes a pointing device
   for it, not another chat window with its own history.
3. **A scratch layer.** Questions and half-formed confusion don't belong in
   your permanent annotations. Read-Along marks are throwaway by default and
   promoted on purpose.
4. **Both directions.** The agent can point back: highlight the definition you
   missed, box the panel that answers your question.
5. **Pixels, not just text.** Every mark ships a PNG crop, so boxes around
   figures, tables and equations work.
6. **Small.** No bundled model clients, keys, RAG or chat UI, just the marking
   layer and an HTTP protocol ([docs/protocol.md](docs/protocol.md)).

MCP servers like zotero-mcp complement this: they read your library; this
handles the live "look at this" loop while reading.

## How it works

Three small pieces:

- **The Zotero plugin** (`src/`) adds the scratch layer: region marks on the
  page, the Read-Along pane, and HTTP endpoints on Zotero's built-in local
  server (`127.0.0.1:23119/readalong/…`).
- **The `readalong` CLI** (`client/readalong`, Python 3, no dependencies) is
  how an agent talks to it: wait for questions, reply, draw pointers, render
  pages, promote marks. See [docs/protocol.md](docs/protocol.md).
- **The Claude Code skill** (`skill/readalong/SKILL.md`) tells the agent how to
  behave: start from your guess, hint before telling, point at the page,
  check understanding, never explain unprompted.

The agent has to be running to answer: start a Claude Code session and say
"read with me" (or `/readalong`). It then waits for your questions in the
background. Without it, questions sit at "Waiting…".

## Install

Requires Zotero 7–10, Python 3, Node.js 18+ (to build), and an agent such as
[Claude Code](https://claude.com/claude-code).

1. Build the plugin and install it in Zotero:
   ```sh
   git clone https://github.com/hdmGOAT/zotero-readalong
   cd zotero-readalong
   npm install && npm run build
   ```
   Then Tools → Plugins → ⚙ → Install Plugin From File →
   `.scaffold/build/read-along.xpi`. (Prebuilt `.xpi` files will be on
   the Releases page once published.)
2. Put the CLI on your PATH:
   `ln -s "$PWD/client/readalong" ~/.local/bin/readalong`
3. For Claude Code, install the skill:
   `ln -s "$PWD/skill/readalong" ~/.claude/skills/readalong`

Check it with `readalong ping`, then open a PDF in Zotero and tell Claude Code
"read with me".

## Use

Open a PDF; the **Read-Along** section is in the right-hand item pane (book
icon in the side nav). It works like a chat: the conversation about this
paper on top, the composer at the bottom.

1. **Attach regions:** select text and choose "Ask Claude about this", or click
   ⬚ (toolbar or composer) and drag a box around a figure or equation. Each
   becomes a chip `[1]`, `[2]`… in the composer; click a chip's number to
   insert the reference.
2. **Ask:** write your question. Click **✎ My guess** to say what you think
   first; the agent responds to your reasoning before anything else.
3. **Send** with Enter (Shift+Enter for a new line).
4. **Continue:** replies appear in the conversation, with teal 📍 pointers to
   where to look on the page. **↩ Respond** follows up in the same thread.
5. **Keep or toss:** "Keep" saves a conversation's regions and pointers as
   real Zotero annotations whose comment records the exchange; "Dismiss"
   removes them.

Marks on the page have badges too (`?` waiting, `…` seen, `✓` answered).

The agent name in the UI is the `extensions.zotero.readalong.agentName` pref
(default "Claude").

## Develop

Built on [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template).

```sh
npm install
npm run build     # → .scaffold/build/addon, .xpi
npx tsc --noEmit
```

To develop against your everyday Zotero profile without reinstalling the `.xpi`,
`scripts/dev-install.sh` points the profile at `.scaffold/build/addon` (then
restart Zotero; rebuild + restart to pick up changes). `npm start` runs
Zotero with a separate dev profile and hot reload; configure `.env` from
`.env.example` first.

`readalong reload` reloads the plugin from disk after a build (this clears
current marks).

Layout: `src/modules/` holds the plugin: `marks` (store of marks, asks,
drafts), `server` (HTTP endpoints), `reader` (wiring) with `view`, `interact`
(popup, box mode), `overlay` (marks and popovers on the page), `sidebar` (the chat-style item pane section) and
`agent` (agent drawing), plus `geometry` (quote search), `render` (crops) and
`promote`. `client/` is the CLI, `skill/` the Claude Code skill.

## Privacy and security

- Everything runs locally. The plugin never contacts the network; marks live
  in memory and region crops are written to your temp directory
  (`<tmp>/zotero-readalong/`).
- What reaches a model is whatever your agent reads: the regions and
  questions you send, and any of the paper it chooses to read. With Claude
  Code that goes to Anthropic under your account's terms.
- The endpoints are on Zotero's local server, which only listens on
  `127.0.0.1` and rejects requests from web pages. Any program running as you
  on the same machine can call them, the same as Zotero's existing connector
  endpoints.
- The agent can create real annotations only through "promote", and the skill
  tells it to do that only when you ask.

## Limitations

- PDFs only (no EPUB/snapshots yet). Marks are drawn on the primary view only
  (not split view).
- Agent `quote` rects are approximated from pdf.js text runs; good enough to
  point, slightly looser than Zotero's own highlights.
- Marks and conversations are scratch: they're gone when Zotero quits or the
  plugin reloads. That's the point; use **Keep** for anything worth saving.
- The agent only answers while a session is watching.
- A draft belongs to one PDF; regions can't span papers yet.

## Contributing

Contributions are welcome, and I'm happy to review them: bug reports, fixes,
support for other agents, EPUB/snapshot support, UI polish, or ideas that
make reading more active rather than less.

A heads-up on pace: this is a side project, so I won't be very active in
pushing updates myself. I'll work on it when I have free time or see a clear
need. Reviews may take a while, but they will happen.

To contribute:

- Open an issue first for anything bigger than a small fix, so we can agree on
  the approach.
- Keep pull requests focused, and run `npm run lint:check` and `npm run build`
  before sending.
- Changes to agent behavior go in [skill/readalong/SKILL.md](skill/readalong/SKILL.md);
  protocol changes should update [docs/protocol.md](docs/protocol.md).
- Keep the spirit of the project in mind: the tool should help the reader do
  the thinking, not do it for them.

## License

Copyright © 2026 Hans Matthew E. Del Mundo.

Licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).
Read-Along is built on
[zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
by windingwind and contributors (AGPL-3.0-or-later); the build setup,
`addon/bootstrap.js`, and `src/utils/` come from it. Zotero itself is
AGPL-3.0 as well. See [NOTICE](NOTICE) for details.

Not affiliated with or endorsed by Anthropic or the Corporation for Digital
Scholarship (Zotero). "Claude" and "Zotero" are trademarks of their
respective owners.

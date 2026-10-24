# Read-Along protocol

All endpoints live on Zotero's local server: `http://127.0.0.1:23119/readalong/…`.
Bodies are JSON (`Content-Type: application/json`). Errors come back as
`{"error": "..."}` with a 4xx/5xx status.

Zotero rejects requests that look like they came from a web page (browser
User-Agent or `Origin` header), so only local programs can call these.
Zotero's "Allow other applications to communicate" (local API) setting is
**not** required.

## Concepts

- **Mark**: a region of a page: a text selection or a box. Made by the user
  or the agent.
- **Ask**: what the user sends: a `prompt`, optionally their `take` (what they
  think before asking), and ordered `regions`. The prompt refers to regions
  as `[1]`, `[2]`… in that order. A quick ask has one region.
- **Draft**: regions being collected for an ask that hasn't been sent. Agents
  never see drafts.

```jsonc
// an ask, as returned by /next and /marks
{
  "id": "QK7Z2M4P",
  "seq": 3,                     // monotonic per epoch; poll with after=<seq>
  "prompt": "is [2] the same ratio plotted in [1]?",
  "take": "I think [1] plots ||F(h)||/||h|| so yes, but the scale looks off",
  "reply": null,
  "createdAt": "2026-10-24T13:00:00.000Z",
  "item": { "title": "...", "itemKey": "...", "attachmentKey": "...", "pdfPath": "..." },
  "regions": [
    {
      "id": "ABCD2345",         // mark id; also the annotation key if promoted
      "kind": "box",            // "text" | "box"
      "text": "",               // selected text (text regions)
      "page": "4", "pageIndex": 3,
      "rects": [[x1, y1, x2, y2]],   // PDF points, bottom-left origin
      "imagePath": "/tmp/zotero-readalong/ABCD2345.png"
    }
  ]
}
```

Agent marks are serialized like a region plus `author: "agent"`, `note`,
`createdAt`, and `item`.

Marks are in memory only. They disappear when Zotero quits or the plugin
reloads. Each plugin session has an `epoch` (returned by `/ping` and `/next`);
`seq` restarts with each epoch, so pass back the `epoch` you got with your
`after` and the server ignores stale positions.

## Endpoints

| Method | Path        | Body / query                                                                     | Returns                                                                                                                                |
| ------ | ----------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/ping`     |                                                                                  | `{name, version, seq}`                                                                                                                 |
| GET    | `/context`  |                                                                                  | active reader: `{title, itemKey, attachmentKey, pdfPath, page, pageIndex, marks}` or `{}`                                              |
| GET    | `/marks`    |                                                                                  | `{epoch, seq, asks, agentMarks}` (sent asks; drafts excluded)                                                                          |
| GET    | `/next`     | `epoch`, `after`, `timeout` (s, ≤3600)                                           | `{epoch, seq, asks}`: asks with `seq > after`; long-polls until one exists or timeout. Returned asks are flagged seen.                 |
| POST   | `/reply`    | `{id, text}` (ask id, or any of its region ids)                                  | `{ok}`; text shows in the mark's popover                                                                                               |
| POST   | `/draw`     | `{quote \| frac \| rect, note?, page? \| pageIndex?, attachmentKey?, navigate?}` | the new agent mark                                                                                                                     |
| GET    | `/snapshot` | `page` \| `pageIndex`, `attachmentKey?`                                          | `{imagePath, pageIndex, page, sizePt}`: whole-page PNG                                                                                 |
| GET    | `/text`     | `page` \| `pageIndex`, `attachmentKey?`                                          | `{pageIndex, text}`                                                                                                                    |
| POST   | `/promote`  | `{id, comment?, color?}`                                                         | `{annotationKey}`; mark becomes a real highlight/image annotation, comment defaults to the exchange (Q / take / A) or the agent's note |
| POST   | `/dismiss`  | `{id}` (mark, or ask → all its regions) or `{all: true}`                         | `{dismissed}`                                                                                                                          |
| POST   | `/reload`   |                                                                                  | dev: reload the plugin from disk (clears marks)                                                                                        |

### Drawing coordinates

- `quote`: exact text on the page; matched case- and whitespace-insensitively,
  tolerating end-of-line hyphenation. 422 if not found.
- `frac`: `[x1, y1, x2, y2]` as fractions of the page, **top-left** origin,
  the same frame as the `/snapshot` image.
- `rect`: PDF user-space points, bottom-left origin.

`page` is the printed label; `pageIndex` is zero-based. Neither means the
page currently in view. Without `attachmentKey`, the active reader tab is used;
drawing requires the PDF to be open in a tab (409 otherwise).

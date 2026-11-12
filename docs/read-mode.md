# Read mode — the living study document

Status: **implemented 2026-11-04** (owner rulings in the planning round the same day). This is the design record for the third session kind, alongside teach and practice.

## What it is

**Read** is a documentation-only mode. The agent writes a **living study document** into a dedicated reading pane; the learner reads it and steers changes through a short chat. There is no quiz, no probing, no plan tree, no problems, and no graph extraction.

The mode exists because teach opens by probing (the learner answers questions before seeing material), which can feel blind. Read inverts that: the material is written first, and the learner's reading drives the session. It is not a replacement for teaching — it is the place to read the material teaching would build from.

| | Teach | Practice | **Read** |
|---|---|---|---|
| Opens with | probing questions | problems | a written study document |
| Learner does | answers checks | solves problems | reads and steers |
| Quiz | yes | problems | none |
| Plan tree | yes | no | no |
| Graph extraction | yes | no | no |
| Session kind | absent (default) | `practice` | `read` |

## Owner decisions (2026-11-04)

- **AI-written study guide**, not a graph summary and not imported notes.
- **Dedicated document pane**, split view: document right, chat left; collapsible; full-screen overlay at narrow widths.
- **Living document you steer**: the agent writes, the learner steers through chat.
- **Agent-only edits**: the learner never edits the pane directly.
- **Starts with a summary of the topic's main ideas**, sized by the agent to the subject (no fixed word count); real explanation, not an outline.
- **Never asks a clarifying question before writing**: choose the standard reading and state the assumption in the document.
- **No quiz**, ever.
- **No knowledge-graph extraction** (a later explicit "save to graph" action is a possible follow-up).
- **Tools**: research, files/PDFs, and mermaid diagrams. No quiz/ask/plan/probe/problem/demo/visual tools.
- **Name**: Read. Session kind `read`.

## The document

`StudyDocument` lives on the session record (`ChatRecord.document`), not in transcript messages:

```ts
interface StudySection { id: string; heading: string; body: string }
interface StudyDocument {
  title: string;
  sections: StudySection[];
  revision: number;
  updatedAt: string;
}
```

Why the record: the guide must survive reloads and compaction, and the transcript is compacted. Section ids are stable slugs (the plan-tree discipline): the agent revises one section without restating the rest. `revision` bumps on every edit so a newer server copy is distinguishable.

The pane derives its TOC from the sections. The body is markdown rendered through the same `MessageResponse` pipeline as chat (LaTeX, mermaid, code, tables).

## The agent

- New `AgentKind: "read"` and `createReadAgent`.
- Prompt directory `src/agent/prompts/read/`:
  - `00-base.md` — the job, the immediate first write, the living-document mechanics, the short steering chat, the tools, the prohibitions.
  - `10-doctrine.md` — how to write a good study document and how to revise it.
- Shared prompt appendix (curated): voice, accuracy, learner files, formatting. The thinking-field and question-tool fragments stay out.
- Tool registry (`createReadTools`): `edit_document`, `read_document`, `read`, `ls`, `find`, `grep`, `research`, `pdf` (the job tools remain user-toggleable).
- Built from turn 1, like practice: no prober→teacher split.

### Document tools

- **`edit_document`** — server-executed. Upserts sections by id, removes by id, reorders with `order`, renames with `title`. The first call must set the title. Validation failures return `ok:false` with the problems (the `plan_init` retry pattern). Writes `ChatRecord.document` through `ChatStore.saveDocument` and emits `document-changed`.
- **`read_document`** — returns the current document (or one section). Needed after compaction or before a large rewrite; the full document is deliberately not echoed through every edit result.

The pure patch engine is `src/core/study-document.ts`: `applyStudyDocumentEdit`, `StudyDocumentError`, TOC/markdown/outline/word-count projections. All shape judgments live there, not in the store.

## Live updates

- `edit_document` saves the record and emits `document-changed` (`{chatId}` — tiny payload, notify-then-fetch).
- `GET /api/chats/[id]/document` returns `{document}`. The pane refetches on the event.
- The pane also refetches on `turn-settled` (belt and suspenders) and on SSE reconnect.
- A mid-turn document write updates the pane without touching the client's streaming message state — that is why the event is separate from `record-changed` (which the chat view ignores while a turn runs).
- The transcript gets a quiet `Document updated · …` line from the document card; the document body never duplicates into chat.

## Compaction

- `read` joins the compaction kind union.
- The read summarizer prompt preserves **the learner's steering** and **the document's title + section list**, not the body (the body is in the record; the future agent calls `read_document`).
- The document remains the canonical state through the record.

## Turn boundaries

`needsContinuation` ignores clean `edit_document`/`read_document` results. Without this, a turn ending right after a document write would wake a phantom continuation turn on reload. This is the read-mode sibling of the practice problem-pose exclusion.

## Extraction

Only teach sessions extract. `chat-handler` gates extraction on `(record.kind ?? "teach") === "teach"`; read and practice write nothing to the graph. The coverage ring is hidden in read sessions for the same reason.

## UI surfaces

- Home mode switch: Teach / Practice / Read (book icon).
- Sidebar: a third creation door, a fourth kind filter, a book icon on read rows.
- Draft: `/chat/new?mode=read`, reading copy, no graph picker.
- Session: Read tag instead of the phase chip; Document chip toggles the pane; no coverage ring; read composer placeholder.
- `ReadPane` (`components/read-pane.tsx`): h-15 header matching the TopBar, title/fallback session title, section count + reading time, TOC rail at wide widths / sticky chip row at narrow, independently scrolling article, active-section tracking, empty/writing states, close.
- `DocumentCard` (`components/artifacts/document-card.tsx`): the quiet transcript line for `edit_document`; `read_document` is invisible after settle.
- Narrow width: the pane is a full-viewport overlay (`fixed inset-0`) with its own close button; wide: a `lg:w-[44%]` full-height sibling of the chat column.

## Packaging

The prompt loader reads `src/agent/prompts/` at runtime, so `next.config.ts` explicitly includes the whole tree in the standalone trace, and `scripts/build-server.mjs` sanity-checks a read prompt asset alongside the teacher asset.

## Tests

- `tests/study-document.test.ts` — pure patch engine: first title, upsert, append, duplicate id/heading, remove, reorder, projections.
- `tests/read-agent.test.ts` — prompt composition, registry shape, edit/read execution against a fake store, continuation exclusion, read compaction prompt.
- `tests/render-read-pane.test.tsx` — pane surface, empty/writing states, live-write predicate, reading time.
- `tests/chat-kind.test.ts` — read kind stamping + document stays out of the list payload.
- `tests/render-new-session.test.tsx` — read draft creation body and copy.

## Explicitly not in v1

- Direct learner editing or inline annotations.
- Multiple documents per session.
- Export/print/copy-to-clipboard of the guide.
- Find-in-document (session find still covers the transcript only).
- Interactive demos/SVG figures inside the document.
- Graph extraction or a "save to graph" action.
- Document version history or undo.
- Resizable split ratio.

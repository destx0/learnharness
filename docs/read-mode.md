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
- **Document-first main view** (amended 2026-11-12): the full study document owns the main area. The conversation is secondary — a floating panel over the document, closed by default and opened from the Chat chip. No split view.
- **Living document you steer**: the agent writes, the learner steers through chat.
- **Agent-only edits**: the learner never edits the pane directly.
- **Starts with a summary of the topic's main ideas**, sized by the agent to the subject (no fixed word count); real explanation, not an outline.
- **Never asks a clarifying question before writing**: choose the standard reading and state the assumption in the document.
- **No graded quiz**, ever. The document may carry optional self-check questions with hidden model answers; the learner reveals them privately, never submits an answer.
- **No knowledge-graph extraction** (a later explicit "save to graph" action is a possible follow-up).
- **Tools**: research, files/PDFs, and mermaid diagrams. No quiz/ask/plan/probe/problem/demo/visual tools.
- **Name**: Read. Session kind `read`.

## The document

`StudyDocument` lives on the session record (`ChatRecord.document`), not in transcript messages:

```ts
interface StudyRoadmapRef { slug: string; nodeId: string; kind: "track" | "topic" | "subtopic" }
interface StudyTopicSuggestion { id: string; heading: string; blurb: string; documentId?: string; sectionId?: string; roadmap?: StudyRoadmapRef }
interface StudySectionQuestion { id: string; question: string; answer: string }
interface StudyRelatedLink { documentId: string; sectionId?: string; reason: string }
interface StudySection { id: string; heading: string; body: string; suggestions?: StudyTopicSuggestion[]; questions?: StudySectionQuestion[] }
interface StudyRoadmapView { slug: string; title: string; source: string; tracks: Array<{ id: string; title: string; topicIds: string[] }> }
interface StudyDocument {
  id: string;                    // "root" | "doc_…"
  title: string;
  sections: StudySection[];
  revision: number;
  updatedAt: string;
  parent?: { documentId: string; sectionId: string; topicId: string };
  related?: StudyRelatedLink[];
  roadmap?: StudyRoadmapView;    // seeded root only
  status?: "writing" | "ready" | "failed"; // absent reads ready
}
```

Why the record: the guide must survive reloads and compaction, and the transcript is compacted. Section ids are stable slugs (the plan-tree discipline): the agent revises one section without restating the rest. `revision` bumps on every edit so a newer server copy is distinguishable. `parent` is the tree edge; a child is always spawned from one chapter's suggestion.

The pane derives its chapter list from the sections and its tree from the parent links. The body is markdown rendered through the same `MessageResponse` pipeline as chat (LaTeX, mermaid, code, tables).

## The agent

- New `AgentKind: "read"` and `createReadAgent`.
- Prompt directory `src/agent/prompts/read/`:
  - `00-base.md` — the job, the immediate first write, the living-document mechanics, the short steering chat, the tools, the prohibitions.
  - `10-doctrine.md` — how to write a good study document and how to revise it.
  - `20-deeper.md` — the document tree, suggestion turns, child-document doctrine, related links, and bounds.
- Shared prompt appendix (curated): voice, accuracy, learner files, formatting. The thinking-field and question-tool fragments stay out.
- Tool registry (`createReadTools`): `edit_document`, `read_document`, `suggest_deeper`, `list_documents`, `read`, `ls`, `find`, `grep`, `research`, `pdf` (the job tools remain user-toggleable).
- Built from turn 1, like practice: no prober→teacher split.

### Document tools

- **`edit_document`** — server-executed. Upserts sections by id, removes by id, reorders with `order`, renames with `title`, replaces cross-links with `related`, and (on a section patch) carries `suggestions` (2–4 deeper directions) and `questions` (1–3 self-check Q&A pairs). The first call must set the title. Validation failures return `ok:false` with the problems (the `plan_init` retry pattern). Writes the target document through `ChatStore.saveDocument` and emits `document-changed`.
- **`read_document`** — returns one document (or one section), targeted by id.
- **`suggest_deeper`** — regenerates one chapter's directions (the refresh path).
- **`list_documents`** — the whole tree with ids, chapter ids, suggestions, and related links.

The pure patch engine is `src/core/study-document.ts`: `applyStudyDocumentEdit`, `applyStudySuggestions`, `StudyDocumentError`, TOC/markdown/outline/word-count projections. All shape judgments live there, not in the store.

## Live updates

- `edit_document` / `suggest_deeper` save the record and emit `document-changed` (`{chatId, documentId?}` — tiny payload, notify-then-fetch).
- `GET /api/chats/[id]/document` returns `{document, documents, readingDocumentId}`. The pane refetches on the event.
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
- Session: Read tag instead of the phase chip; Chat chip toggles the floating conversation panel; no coverage ring; read composer placeholder.
- `ReadPane` (`components/read-pane.tsx`): full-main-area reading surface below the TopBar; h-15 header, title/fallback session title, section count + reading time, TOC rail at wide widths / sticky chip row at narrow, independently scrolling article, active-section tracking, empty/writing states. No close affordance — the document is the mode's main view.
- `DocumentCard` (`components/artifacts/document-card.tsx`): the quiet transcript line for `edit_document`; `read_document` is invisible after settle.
- Chat panel: bottom-right floating card (~30rem wide, up to ~34rem tall), a slim Conversation header with close, the ordinary transcript and composer inside. Hidden (but mounted) when closed, so drafts and scroll state survive toggling. It overlays the document at every width.

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
- Export/print/copy-to-clipboard of a guide.
- Find-in-document (session find still covers the transcript only).
- Interactive demos/SVG figures inside the document.
- Knowledge-graph extraction or a "save to graph" action (the deeper tree is its own graph, not graph evidence).
- Document version history or undo.
- Manual cross-link creation (the agent authors them; the learner can remove).
- Resizable chat-panel dimensions.

## Deeper topics — the document graph (2026-11-12)

Read is no longer one flat guide. Each chapter can grow a **child study
document** for one of its suggested directions, and those children can grow
their own, recursively. The record holds a tree; the pane presents it as a
hidden contents drawer plus an optional topic graph.

### Owner decisions (2026-11-12)

- **Drill into a child document**, not inline expansion and not a new read
  session. Same session, same shared chat.
- **Directions ship with the chapter**, authored in the same
  `edit_document` patch: every new or substantially revised section carries
  2–4 deeper directions, so the learner sees them immediately. The
  "Go deeper" click is the regeneration/repair path, not the first reveal.
- **Self-check questions ship with the chapter too**, hidden in a collapsed
  accordion: 1–3 questions with model answers. The learner answers privately
  and then opens the answer. This is not a graded quiz or a question tool.
- **Switch immediately**: the pending child opens with a writing state and
  sections stream in as `edit_document` calls land.
- **Chat steers the open document.** Switching documents switches the
  target; history stays shared.
- **Hidden tree sidebar + breadcrumb**, and an optional **graph view** with
  document nodes, chapter nodes, and agent-authored cross-links.
- **Cross-links are agent-authored automatically** when it writes a child;
  the learner can remove a wrong link from the reading footer.
- Rejected: inline nested sections (one document grows too long), a new read
  session per topic (exploring becomes session switching), and zero
  cross-links (the owner wants a real topic graph).

### Data model

`ChatRecord` keeps the root in `document` and adds:

```ts
documents?: StudyDocument[];      // children, tree derived from parent links
readingDocumentId?: string;       // chat steering target (view state)
```

`StudyDocument` adds `id` (`"root"` or `doc_…`), `parent` (the chapter and
suggestion that spawned it), `related`, and `status` (`writing | ready |
failed`; absent reads ready). `StudySection` adds `suggestions` (stable
slug, heading, blurb, optional existing `documentId`/`sectionId`) and
`questions` (stable slug, question, answer).

`StudyRelatedLink` is document-level: `{documentId, sectionId?, reason}`.
The graph draws it dashed; the reading footer lists it.

Bounds: 50 documents per session, six levels below the root, twelve suggestions
at the hard ceiling (agent turns normally offer 2–4; roadmap seeds may use the
full list) and six questions per chapter. Section/body/total limits stay as
before per document.

### The turns

The learner's clicks are hidden session markers, not chat bubbles:

- `suggest-deeper` → `read-suggest` marker. This is the regeneration path
  (refresh, or a chapter authored before directions existed). The agent
  reads the chapter and calls `suggest_deeper`; the pane renders the chips.
- `go-deeper` → the server pre-creates the child (`status:"writing"`), makes
  it the active document, then appends a `read-deeper` marker and starts the
  writer turn. The agent writes with `edit_document` and the child's id.
- Ordinary chat text gets a `read-context` marker when the open document
  changed (or after compaction), so "expand this" targets what is on screen.

Turn settlement finalizes any `writing` document: sections landed → `ready`;
none → `failed` (the pane offers Retry, which reuses the same child id).

### Tools

- `edit_document` — `documentId` target (omit = active document), `related`
  replace-whole, and the existing section patch/remove/order fields.
- `read_document` — one document or one section, targeted.
- `suggest_deeper` — store 2–4 directions for one chapter.
- `list_documents` — the whole tree with section ids, suggestion ids and
  related links; the agent's map for suggestions and cross-links.
- `edit_document` / `read_document` / `suggest_deeper` / `list_documents`
  are internal work for the continuation fold (no phantom wake).

The prompt's `read/20-deeper.md` carries the doctrine: a child continues
from its parent chapter, delivers the chosen direction, avoids duplicates,
and links only genuinely related documents.

### API

- `GET /api/chats/[id]/document` → `{document, documents, readingDocumentId}`.
- `POST /api/chats/[id]/document/active` → remember the open document.
- `POST /api/chats/[id]/document/suggest` → start the suggestion turn.
- `POST /api/chats/[id]/document/deeper` → create/reopen the child, start
  the writer turn, return it.
- `POST /api/chats/[id]/document/related/remove` → drop one cross-link.

`document-changed` carries `{chatId, documentId}` (optional for old
listeners); the pane refetches all documents on a short debounce.

### UI notes

- The header's contents button opens a drawer: root → chapters → spawned
  child under the chapter. Writing/failed status dots; clicking a chapter
  opens its document at that section. Breadcrumb and back button for the
  document chain.
- Inline "Go deeper" at the end of every chapter: the authored 2–4 cards
  with title/blurb and an Open/Write/Retry/Writing state. A refresh control
  regenerates directions; a chapter with none still offers a quiet
  "Suggest deeper topics" button.
- Self-check questions render above the deeper block as a native `<details>`
  accordion, collapsed by default. Opening it lists each question; opening a
  question reveals its model answer. A chapter without questions renders
  nothing.
- Related links render as a footer list with a remove affordance.
- The graph toggle opens a dagre-laid-out SVG (documents left, chapters
  right, deeper branches further right; dashed related curves). Chapter
  nodes open their document at that section. Pan/zoom uses the shared
  pan-zoom math; Fit recenters.
- The tree drawer is an overlay at every width; the narrow chapter chip row
  stays as a quick-jump strip.

### Tests

- `tests/study-document.test.ts` — authored suggestions/questions, child
  creation, depth, breadcrumb, related links, tree text.
- `tests/read-agent.test.ts` — tool registry, targeted child edits,
  `suggest_deeper`, `list_documents`, prompt paths.
- `tests/read-deeper-input.test.ts` — parse + hidden markers + active-document
  context.
- `tests/read-document-route.test.ts` — GET shape, active-document route,
  target validation.
- `tests/read-graph.test.ts` — graph projection, ghost suggestions, generated-child suppression, deterministic layout.
- `tests/roadmap-seed.test.ts` — roadmap.sh import seed behavior.
- `tests/render-read-pane.test.tsx` — drawer, breadcrumb, suggestions,
  self-check accordion, related links, graph toggle, failed/empty states.
- `tests/chat-kind.test.ts` — child upsert + list payload exclusion.

Status: implemented 2026-11-12.


## Roadmap presets — roadmap.sh (2026-11-13)

A read session about a known topic can start from an imported roadmap
instead of a blank guide. Angular is the first preset, built from the
[roadmap.sh Angular roadmap](https://roadmap.sh/angular).

### Import

```bash
npm run roadmap:import -- angular
```

`scripts/import-roadmap.mjs` fetches roadmap.sh's official graph
(`/api/v1-official-roadmap/<slug>`), imposes the read-mode tree, and writes
`data/roadmaps/<slug>.json` under the mutable data dir (gitignored). Only
labels and hierarchy are stored — never roadmap.sh prose. The Angular
preset has 6 tracks, 26 main topics and 132 subtopics.

### The seeded opening

`POST /api/chats` (read only) calls `seedRoadmapForChat` when the opening
title names an imported roadmap. The root document starts with **every
main topic as a real section**:

- an **Overview** section with the source link and usage note;
- **26 topic sections**, each one-line seed body naming its subtopics;
- each topic's **roadmap subtopics as suggestions** (up to 12), carrying
  `roadmap: {slug, nodeId, kind:"subtopic"}` pointers;
- a document-level `roadmap` field with the track grouping and source.

This is the whole subject at a glance: the initial document lists all main
topics, and the roadmap map shows every topic and subtopic before the
learner commits a turn to any of them.

The read agent's opening rule for a seeded root is to keep every section
and suggestion, expand each one-line seed into a 2–4 sentence summary in
roadmap order (split across edit calls), and add self-check questions where
they fit. It does not replace the map with a new outline. Subtopic deep
dives are separate child documents started by clicking a subtopic.

### Deep dives

Clicking a subtopic suggestion (inline card, contents ghost, or map leaf)
creates a child document and starts the writer with a `Roadmap context:`
line. The child is a focused deep dive one level below its main topic; it
gets its own sections, directions and questions. The parent pointer keeps
the main topic/track context.

### The roadmap map

When the root carries a `roadmap` field, the graph toggle opens a
roadmap.sh-style map instead of the compact document graph:

- a large, tall canvas with the subject title at the top;
- main-topic cards on a central primary spine (theme card + primary
  accent);
- each topic's subtopic cards in a bordered, muted group box to the left
  or right, alternating;
- solid primary spine segments and dashed primary branch connectors;
- theme colors throughout (the layout is roadmap.sh's, not its palette);
- track labels (Foundations, Templates & UI, …) across the canvas;
- generated subtopics carry a green status dot; writing pulses blue,
  failed is red.

Main topic nodes open that section of the root guide. Subtopic nodes open
the generated child or start its deep-dive turn. Pan, wheel zoom, fit width
and fit-whole-map are available. The map is intentionally tall, like the
roadmap.sh poster; it opens fit-to-width at the top.

While the map is the full roadmap, the inline subtopic cards under a
roadmap section are collapsed in a **Roadmap subtopics** accordion so the
26-section guide stays readable. The contents drawer also lists each
subtopic as a ghost row.

### Tests

- `tests/roadmap-seed.test.ts` — title match, the all-main-topic root
  seed, track/topic/subtopic seeds, no-overwrite rule, route integration.
- `tests/read-roadmap-graph.test.ts` — spine/side-box layout, alternating
  branches, generated status, roadmap detection.

### Contract

- Preset data is runtime state (`data/roadmaps/`), not source; a fresh
  install has no preset until the import command runs.
- The roadmap's copyright notice allows personal use; the app stores only
  labels/hierarchy and links to the source. Do not commit imported data or
  redistribute the roadmap's prose.

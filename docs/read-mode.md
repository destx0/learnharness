# Read mode — the living study document

Status: **current as of 2026-11-15.** This is the single current design for the read session kind. The append-only record of how it got here (2026-11-04 → 11-13) is archived at [archive/read-mode-2026-11-13.md](archive/read-mode-2026-11-13.md); the 2026-11-15 audit and owner rulings are summarized under [Decisions](#decisions).

## What it is

**Read** is the documentation mode. The agent writes a **living study document** into a reading pane; the learner reads it and steers it through a short chat. There is no graded quiz, no probing, and no plan tree.

Teach opens by probing (the learner answers before seeing material), which can feel blind. Read inverts that: the material comes first. It is not a replacement for teaching — a chapter can hand off to a Teach session — but the place to read the material teaching would build from.

| | Teach | Practice | **Read** |
|---|---|---|---|
| Opens with | probing questions | problems | a written study document |
| Learner does | answers checks | solves problems | reads and steers |
| Quiz | yes | problems | none (private self-check Q&A only) |
| Plan tree | yes | no | no |
| Graph extraction | automatic | no | explicit "Save to graph" |
| Session kind | absent (default) | `practice` | `read` |

## Decisions

Owner rulings, newest first. Anything not listed here follows the archived record.

**2026-11-15 (audit round)**

- **Roadmaps open lazily.** The opening chat turn writes only the Overview. Every subtopic overview is written up front by parallel background writers; each main topic's summary is written **when the learner opens it** (navigates to it, or it stays on screen for ~1.2 s). The old bulk opening (26 summaries + ~130 overviews + questions in one turn) is gone.
- **Clicks run as parallel background writers**, never chat turns: deep dives, lazy summaries, subtopic overviews, more questions, fresh directions. At most **8 per session** run at once; the rest queue. They use the **session's own model**.
- **Limits raised:** 500 documents per session, 200 suggestions per section, depth stays 6. Agent-authored directions stay at 2–4 by doctrine.
- **Storage:** one file per document (`data/chats/<chatId>.docs/<docId>.json`); the record keeps only view state. Chat record version 5; older records migrate on first read.
- **Graph features:** "Save to graph" per document, "Teach me" per chapter (a Teach session with the chapter as hidden context; the prober still probes), and the graph-map reader for the read agent and writers (behind the existing graph-tools switch).
- **Roadmaps seed only from a roadmap card** (an explicit slug). Typed topics are never matched against roadmap names.
- **Imported data is cleaned at seed time:** glyph-only labels dropped, repeated topic titles disambiguated (`UIKit (2)`), and every seed must pass the edit engine's whole-document rules.
- **An edit with no `documentId` targets the document open when the turn started**, never whatever the learner navigates to mid-turn.
- **Reading UX:** a persistent contents rail on wide screens, an unread/error dot on the Chat chip (a turn error opens the conversation), and "Add self-check questions" on chapters that have none.

**2026-11-04 → 11-13 (still in force)**

- AI-written study guide; document-first main view with the conversation as a floating panel, closed by default.
- Agent-only edits: the learner steers, never edits the pane directly.
- Never asks a clarifying question before writing; picks the standard reading and states the assumption.
- No graded quiz, ever. Chapters may carry 1–3 private self-check questions with hidden model answers.
- Every new chapter ships with 2–4 deeper directions; choosing one drills into a **child document** in the same session (not inline expansion, not a new session).
- Cross-links between documents are agent-authored; the learner can remove a wrong one.
- roadmap.sh presets store labels and hierarchy only, never roadmap prose.

## The documents

```ts
interface StudySection {
  id: string; heading: string; body: string;          // markdown (LaTeX, mermaid)
  suggestions?: StudyTopicSuggestion[];               // deeper directions / roadmap subtopics
  questions?: StudySectionQuestion[];                 // private self-check Q&A
  seed?: boolean;                                     // roadmap topic, summary not written yet
}
interface StudyDocument {
  id: string;                    // "root" | "doc_…" (server-minted)
  title: string; sections: StudySection[];
  revision: number; updatedAt: string;
  parent?: { documentId: string; sectionId: string; topicId: string };
  related?: StudyRelatedLink[];
  roadmap?: StudyRoadmapView;    // roadmap-seeded root only
  status?: "writing" | "ready" | "failed";            // absent reads ready
}
```

- Documents live in their own files (`ChatStore.readDocuments` / `getDocument` / `saveDocument`). A write never rewrites the transcript, so parallel writers touch only their own file. The record keeps `readingDocumentId` (view state) and `roadmapSlug` (quick-start identity).
- Section ids are permanent slugs; headings are labels and must stay unique (the TOC must not lie). `revision` bumps on every write.
- A roadmap subtopic's blurb starts as the placeholder `Overview not written yet.` until a writer describes it.
- The pure patch engine is [`core/study-document.ts`](../src/core/study-document.ts): edits, suggestion and subtopic writes, question appends, whole-document validation (`studyDocumentProblems`), the skeleton projection, and tree helpers. Roadmap subtopics can never be dropped by an edit or a direction refresh; agent directions are added beside them.

## Who writes what

| Work | Writer | Trigger |
|---|---|---|
| First document, revisions, chat answers | the chat turn (read agent) | learner messages |
| Roadmap Overview | the opening chat turn | the roadmap card's opening message |
| Every roadmap subtopic overview | background writers (batches of ≤24 per topic) | queued when the opening turn starts |
| A roadmap topic's summary | background writer | the learner opens the topic |
| A deep dive (child document) | background writer | a direction / subtopic card, or the map |
| More self-check questions | background writer | "Generate more questions" / "Add self-check questions" |
| Fresh directions | background writer | the refresh control on a chapter |

### The chat agent

- `AgentKind: "read"`, prompts in `src/agent/prompts/read/` (`00-base` job and mechanics, `10-doctrine` writing standard, `20-deeper` the tree) plus the shared voice/accuracy/files/formatting appendix.
- Tools: `edit_document`, `read_document`, `describe_subtopics`, `add_questions`, `suggest_deeper`, `list_documents`, learner files, `research`, `pdf`, and (gated) `list_sessions` / `list_propositions`.
- An omitted `documentId` means the document open **when the turn started** (`defaultDocumentId`, pinned by the handler). A `read-context` marker tells the model which document that is whenever it changes.

### Background writers

- [`agent/read-writer.ts`](../src/agent/read-writer.ts): a stateless sub-agent per task with its own prompt (`prompts/read-writer/00-writer.md` + the read doctrine + shared voice/accuracy/formatting), a brief carrying exactly the text it builds on, and **scoped tools**: it can read anything but write only its target document (and, for a summary, only its one section).
- [`server/read-writers.ts`](../src/server/read-writers.ts): the queue. One task per key (kind + target), so repeated clicks join the running task. At most 8 running per session; the process-wide worker request pool still caps provider requests. Usage goes into the session's `turns` ledger.
- Settlement checks delivery: a deep dive with no sections becomes `failed` (Retry reuses the child id); a summary that left the section a seed, or subtopics left pending, count as failed. A failure is remembered for 30 minutes so an automatic summary does not re-fire; explicit Retry clears it.
- Each writer is a row in the sidebar's Background agents strip ("Document writer"), with the END control to stop it.
- Crash recovery: a child still `writing` with no live writer is finalized on the pane's next document read.

## Roadmap presets

```bash
npm run roadmap:catalog
npm run roadmap:import -- all      # or: npm run roadmap:import -- angular
```

The catalog (102 roadmaps) and each roadmap's labels/hierarchy are imported into `data/roadmaps/` (gitignored runtime data). Angular has a curated six-track mapping; every other roadmap is one track in visual order.

- The read draft's **Start from a roadmap** grid and the in-session **Roadmaps** chip open the catalog. A card is **Open** when a read session for it exists, otherwise **Start**.
- Starting creates a read session with `roadmapSlug`; the root is seeded with an Overview plus every main topic as a seed section whose subtopics are suggestions.
- Opening a subtopic starts a deep dive whose writer gets a `Roadmap subtopic: … (topic: …, track: …)` context line.
- The **roadmap map** (graph toggle on a seeded root) is a roadmap.sh-style poster in theme colors: topics on a spine, subtopic boxes alternating sides, status dots for generated children.

roadmap.sh's notice allows personal use. The app stores only labels and hierarchy and links to the source. Do not commit imported data or redistribute roadmap prose. Note that the local server is reachable through the `lh.pugg.in` tunnel ([local-deploy.md](local-deploy.md)); keep that tunnel personal.

## Graph features

- **Save to graph** (header button, per document): sends the document's written sections through the notes-import pipeline (extractor → auditor → merger). The source path is `Reading/<session>/<document>.md`, so saving again re-runs against the same source. Seed placeholders are never sent. Progress shows in Background agents.
- **Teach me** (per written chapter): creates a Teach session whose first message is a hidden `read-chapter` marker carrying the chapter's text, then opens it on "Teach me <heading>". The prober still probes: reading a chapter is not holding it.
- **Graph-map reader**: when the graph and graph-tools switches are on, the read agent and summary/deep-dive writers can list what the learner already holds, treat it as known ground, and link to it. They never mention the graph in the document.

## The pane

- `GET /api/chats/[id]/document[?documentId=]` returns every document as a **skeleton** (no bodies or answers) plus the shown document in full, and the session's writer state. The pane caches full documents by revision and fetches a skeleton in full when it is opened.
- Header: contents drawer (the whole tree), back + breadcrumb, title, section count and reading time, writing indicator (counts parallel writers), Save to graph, graph toggle.
- Wide screens: a persistent **Sections** rail for the open document. Narrow screens: a sticky chapter chip row.
- Per chapter: Teach me, the body (or the seed's waiting / writing / failed + Retry state), the self-check accordion (or "Add self-check questions"), and the directions (roadmap subtopics collapsed in an accordion on a seeded root).
- Related links render as a footer with a remove control.
- The conversation is a floating panel, closed by default; the Chat chip shows a dot for an unseen reply or an error, and a turn error opens the panel.

## API

| Route | Does |
|---|---|
| `GET /api/chats/[id]/document` | skeletons + shown document + writers |
| `POST …/document/active` | remember the open document (`readingDocumentId`) |
| `POST …/document/deeper` | create/reopen a child, queue its deep-dive writer |
| `POST …/document/summary` | queue a seed topic's summary (`retry` to re-fire a failure) |
| `POST …/document/questions` | queue a more-questions writer |
| `POST …/document/suggest` | queue a fresh-directions writer |
| `POST …/document/related/remove` | drop one cross-link (no model call) |
| `POST …/document/graph` | save one document to the knowledge graph |
| `POST /api/chats` with `readChapter` | start a Teach session from a chapter |
| `POST /api/activity/abort` with `kind: "read"` | stop a background writer |

`document-changed` (`{chatId, documentId}`) fires after every document write and every writer enqueue/settle; the pane refetches on a short debounce, on `turn-settled`, and on SSE reconnect.

## Compaction, turns, extraction

- The read summarizer keeps the learner's steering and the document tree (titles and section ids), never bodies; the agent re-reads with `read_document`.
- A clean document-tool result owes no continuation (no phantom wake after reload).
- Read sessions never extract automatically; "Save to graph" is the explicit path.

## Tests

- `study-document.test.ts` — the patch engine, tree helpers, limits.
- `read-agent.test.ts` — prompt, registry (incl. gated graph tools), edits, pinned target under mid-turn navigation, question append.
- `read-writer.test.ts` — writer prompt, briefs, scoped tools.
- `read-document-route.test.ts` — skeleton GET, parallel deep dives, the per-session cap, lazy summary failure/retry, migration, Teach handoff.
- `roadmap-seed.test.ts` — explicit-slug seeding, lazy seed shape, **every imported roadmap** passes validation, subtopic writer batches.
- `read-deeper-input.test.ts` — the read-context marker; removed click inputs are refused.
- `render-read-pane.test.tsx`, `read-graph.test.ts`, `read-roadmap-graph.test.ts`, `read-generation.test.ts`, `render-activity-dock.test.tsx`.

## Not built

- Learner editing or annotations; document version history or undo.
- Export/print (`studyDocumentToMarkdown` exists and feeds Save to graph).
- Find-in-document (session find covers the transcript only).
- Live cost on writer rows (usage lands in the session ledger at settlement).
- Resizable chat panel.

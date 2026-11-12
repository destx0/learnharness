/**
 * Chat-session contracts — records, summaries, UI extension points
 *
 * Part of the domain-split contracts (src/core/contracts/): each domain file
 * is owned outright by its stream — cross-domain schema changes go through
 * master. Pure types + protocol docs + tiny pure helpers. See docs/archive/vision.md.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { LhMessage } from "../native-messages.ts";
import type { Phase3 } from "../phases.ts";
import type { PlanNodeStatus, PlanTree } from "./plan.ts";
import type { EmissionStats } from "./graph.ts";

// ─── Chat records (the session store's on-disk format) ───────────────────────

/** Session kind: teach is the default when a saved record omits kind.
 * Practice uses the adaptive-practice agent; read uses the
documentation-only reader and the living study document (no
quiz/probing/plan, no graph extraction). Reading an absent kind does not
require a record migration. */
export type ChatKind = "teach" | "practice" | "read";

// ─── The living study document (read sessions) ─────────────────────────────
//
// The document is the read session's artifact: a structured, agent-authored
// study guide that the learner reads and steers through chat. It lives on the
// ChatRecord (the canonical state survives reloads and compaction) and is
// written only by the edit_document tool. Sections carry stable ids so the
// agent can revise one part without rewriting the whole guide; `revision`
// bumps on every edit so the pane can tell a newer server copy from its own.

/** One deeper-topic direction the read agent suggests for a chapter. The
 *  learner chooses one; the app then either opens an existing document
 *  (`documentId`) or writes a new child document for it. */
export interface StudyTopicSuggestion {
	/** Stable lowercase slug, unique within the section — chosen once. */
	id: string;
	heading: string;
	/** One line: what going deeper would cover. */
	blurb: string;
	/** An already-written document this direction points to. Absent means
	 *  choosing the suggestion generates a new child document. */
	documentId?: string;
	/** A chapter within `documentId` (defaults to that document's top). */
	sectionId?: string;
}

/** One suggested self-check question for a chapter. The learner answers it
 *  themselves and then reveals the stored model answer; the pane keeps the
 *  whole set collapsed by default. Not a graded quiz. */
export interface StudySectionQuestion {
	/** Stable lowercase slug, unique within the section. */
	id: string;
	question: string;
	answer: string;
}

/** A cross-link from a document to a related document/chapter. Agent-
 *  authored when it writes a child; drawn dashed in the graph and listed
 *  in the reading footer. */
export interface StudyRelatedLink {
	documentId: string;
	sectionId?: string;
	reason: string;
}

/** A child document's generation state. Absent reads as ready (root and
 *  pre-deeper records never carried a status). */
export type StudyDocumentStatus = "writing" | "ready" | "failed";

/** One navigable section of a study document. `body` is markdown (LaTeX and
 *  mermaid render in the pane); `heading` is the TOC label. */
export interface StudySection {
	/** Stable lowercase slug (a-z, 0-9, hyphens/underscores) — chosen once. */
	id: string;
	heading: string;
	body: string;
	/** Deeper directions for this chapter, authored with the chapter. */
	suggestions?: StudyTopicSuggestion[];
	/** Suggested self-check questions and their model answers. */
	questions?: StudySectionQuestion[];
}

export interface StudyDocument {
	/** `"root"` for the session's first document; server-minted `doc_…`
	 *  ids for deeper documents. */
	id: string;
	title: string;
	sections: StudySection[];
	/** Monotonic edit counter (1 on the first write). */
	revision: number;
	/** ISO timestamp of the latest edit. */
	updatedAt: string;
	/** Where this document was spawned from; absent on the root. */
	parent?: { documentId: string; sectionId: string; topicId: string };
	/** Cross-links to related documents/chapters. */
	related?: StudyRelatedLink[];
	/** Generation state; absent reads as ready. */
	status?: StudyDocumentStatus;
}

/** The read agent's document tool names (single-sourced for the tool
 *  registry, the continuation fold, and the UI's artifact renderer). */
export const EDIT_DOCUMENT_TOOL = "edit_document";
export const READ_DOCUMENT_TOOL = "read_document";

/** One persisted native session under data/chats/<id>.json. Messages retain
 * native agent history; transcript rendering groups them into a separate view.
 * Usage, images, plan state and side conversations are session-owned records. */
export interface ChatRecord {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messages: LhMessage[];
	/** Session-local processed pictures; artifact records carry references only. */
	imageSnapshots?: Record<string, ImageSnapshot>;
	/** The session's kind; an absent field reads as teach. */
	kind?: ChatKind;
	/** The session's plan tree, written by the native plan tools. */
	tree?: PlanTree;
	/** The living study document (read sessions) — written by the read
	 *  agent's edit_document tool via saveDocument. Absent on teach and
	 *  practice records. */
	document?: StudyDocument;
	/** Deeper documents spawned from chapters of the living document
	 *  (read sessions). The tree is derived from each document's parent
	 *  link; the root stays in `document` for pre-deeper compatibility. */
	documents?: StudyDocument[];
	/** The document the learner is currently reading. The floating chat
	 *  steers this document; absent reads as the root. */
	readingDocumentId?: string;
	/** Append-only usage log, separate from message history: one entry per billed
	 * turn, deduplicated by request identity. messageId associates usage with the
	 * transcript; token/cost aggregates are computed from the log at read time. */
	turns?: TurnUsage[];
	/** Append-only background-extraction usage for this chat, separate from
	 * messages. Finished runs include failed runs with usage; appends are
	 * idempotent by startedAt. */
	extractions?: ExtractionRunUsage[];
	/** Per-chat model/thinking overrides for the conversation agents. */
	settings?: ChatSettings;
	/** Durable clarification threads. Each explanation and associated check
	 * shares one thread. Every main request appends new raw exchanges across
	 * all threads; already-recorded teacher history is never rewritten. */
	sideChats?: SideChatThread[];
	/** Schema version. Absence denotes version 1; writes stamp the current
	 * supported version. Reads refuse records stamped newer than this build
	 * so a downgraded app cannot rewrite an unsupported record. */
	version?: number;
}

/** The chat record format this build writes and understands. Version 3
 *  adds the deeper-document tree (`documents` / `readingDocumentId`) and
 *  document suggestion/related state. */
export const CURRENT_CHAT_VERSION = 3;

/** Per-session model and thinking choices for native conversation agents.
 * Each absent field falls back independently to the strong model slot; no
 * configured model means conversation work is unavailable. Choices resolve
 * when composing a turn, not midway through an active request. Background
 * worker roles use their own model resolution. */
export interface ChatSettings {
	/** Explicit provider-qualified model coordinates from the host catalog. */
	model?: { provider: string; id: string };
	/** pi thinking level — must be in the chosen model's supported list
	 *  (getSupportedThinkingLevels; enforced by the settings route). */
	thinkingLevel?: ThinkingLevel;
}


// ─── Background-extraction usage (the money channel, extraction side) ────────

/** One pipeline stage's model usage — the stage's model + every step it
 *  billed (CallUsage per agent step). Steps, not a sum: cost and context
 *  folds happen at read time (core/prices.ts). */
export interface ExtractionStageUsage {
	/** The model that ran this stage, provider-qualified ("provider:id")
	 * for key-independent Pi catalog lookup at read time. */
	model: string;
	steps: CallUsage[];
}

/** One finished (or failed mid-flight) extraction run's usage record.
 *  Appended to the chat's `extractions` log when the run ends — success or
 *  failure, because money was spent either way; `stats` is present only
 *  when the merger actually ran. */
export interface ExtractionRunUsage {
	/** The run's registry startedAt (ms) — the idempotency key. */
	startedAt: number;
	at: string;
	durationMs: number;
	/** What the run merged into the graph; absent when it failed first. */
	stats?: EmissionStats;
	/** Model usage per stage, in pipeline order (merger is deterministic —
	 *  no model call, no entry). */
	stages: {
		extractor: ExtractionStageUsage;
		auditor: ExtractionStageUsage;
	};
}

// ─── Usage accounting (the money channel) ─────────────────────────────────────

// ─── Side questions (inline clarification threads, 2026-11-02) ──────────────

/** Where a side thread sits in the transcript: after one paragraph-level
 *  block (Streamdown's markdown block split) of one teacher prose part.
 *  Settled teacher prose never changes, so (partId, blockIndex) is stable. */
export interface SideChatAnchor {
	/** The native assistant message carrying the prose. */
	messageId: string;
	/** projectView's text-part identity (`<messageId>-t<n>`). */
	partId: string;
	/** 0-based block index inside that part's rendered markdown. */
	blockIndex: number;
	/** The block's markdown source when the thread was opened — the
	 *  default quote, and the anchor's text if the record is ever re-split. */
	blockText: string;
}

/** One message in a side thread. Plain text, never native pi history: the
 *  thread is replayed to the side model as user/assistant text turns. */
export interface SideChatMessage {
	id: string;
	role: "user" | "assistant";
	/** The learner's question, or the side answer (markdown). */
	text: string;
	/** user only: the passages the learner attached to this question. */
	quotes?: string[];
	/** Matching canonical Tutor quote links retain each passage's actual
	 * native source and exact-text selector, independent of segment identity.
	 * Legacy string-only quotes remain readable without a guessed target. */
	quoteCitations?: string[];
	/** ISO time the message was saved. */
	at: string;
	/** assistant only: provider-qualified model ("provider:id"). */
	model?: string;
	/** Idempotency identity of the ask/retry producing this reply. */
	requestId?: string;
	/** assistant only: the learner stopped the answer; `text` is partial. */
	stopped?: boolean;
	/** Delivery snapshot only: this reply was still generating at capture. */
	pending?: boolean;
	/** assistant only: the call failed; `text` is whatever arrived. */
	error?: string;
}

/** One side thread per explanation and associated question, displayed in
 * the shared floating/docked companion rather than inline windows. */
export interface SideChatThread {
	id: string;
	anchor: SideChatAnchor;
	/** Saved open/closed state for this thread. */
	open: boolean;
	createdAt: string;
	messages: SideChatMessage[];
	/** Compatibility snapshot retained when reading records that use a one-shot
	 * context cutoff. Current delivery uses immutable native update entries. */
	contextSnapshot?: SideChatMessage[];
}

/** Persisted token accounting for one model call. Undefined means the
 * provider did not report that field; absence must not be interpreted as zero. */
export interface CallUsage {
	/** Pi-normalized fresh input tokens; cache buckets are disjoint. */
	inputTokens: number | undefined;
	outputTokens: number | undefined;
	/** Cached input tokens READ (billed at the cache-read rate, if any). */
	cacheReadTokens: number | undefined;
	/** Input tokens written to the cache this call; undefined when not reported. */
	cacheWriteTokens: number | undefined;
	/** Subset of cacheWriteTokens written with one-hour retention. Missing
	 * on older logs; new native captures explicitly record zero if absent. */
	cacheWrite1hTokens?: number;
	/** The reasoning portion of the output tokens. */
	reasoningTokens: number | undefined;
}

/** Usage for one native conversation-handler invocation, including user and
 * wake turns. A tool-using turn may span several separately billed model calls.
 * Accounting is captured when the turn persists; cost is estimated from the
 * recorded calls and model catalog at read time. */
export interface TurnUsage {
	/** Request identity for one handler invocation and the append-only log's
	 * idempotency key. Distinct from the transcript association in messageId. */
	id: string;
	/** The assistant message the turn produced — provenance, keys this
	 *  entry to the transcript (the block this turn "belongs" to). */
	messageId: string;
	at: string;
	/** The model that ran the turn, provider-qualified ("provider:id")
	 * for key-independent Pi catalog lookup at read time. */
	model: string;
	/** One entry per agent step (model call) in this turn. */
	steps: CallUsage[];
}

// ─── Plan blocks (the plan lives in the chat) ────────────────────────────────

/** Payload of the persisted `data-plan-block` UI part (2026-09 design): a
 * SNAPSHOT of the plan at the moment it changed, rendered as a block in the
 * chat flow. Attached to the assistant message that carries the plan_init
 * tool call (kind "full") or the answered check quiz part (kind
 * "neighborhood"). Data parts never reach the model (convertToModelMessages
 * drops them) — the block is pure UI history, reappearing identically on
 * reload because it lives in the record.
 *
 * Rendering contract: a "full" block renders the whole DAG borderless,
 * horizontally filling the chat column, natural height; a "neighborhood"
 * block renders current node + direct parents + direct children in its own
 * small container, the current node glowing — clearly a fragment, not the
 * whole plan. Clicking either opens the full plan in a popup. */

/** The model-facing text of the probe→teach handoff wake (the custom-message
 *  scheme): the wake message carries only the data-probe-handoff part, and
 *  the adapter flattens it to THIS. Single-sourced so the prober's seam, the
 *  tests, and reality can't drift apart.
 *
 *  REASONING-FIRST PACING (owner, 2026-09-26): the wake is the one per-turn
 *  cue on the launch turn — the old one-liner read as a dispatch order
 *  ("author now") and the teacher skipped the deliberation the planning
 *  fragment asks for. So the wake paces it: reason out the optimal way to
 *  teach THIS person THIS thing BEFORE plan_init. Honest to the machinery
 *  — plan_init is still the first tool, the plan map still the first
 *  artifact, and presenting still ends the turn (the verdict death,
 *  2026-09-26: the learner's next message is a natural reply — a change
 *  request or the go-ahead). */
export const HANDOFF_TEXT =
	"Next: plan the full teaching arc from my current understanding to the goal understanding. " +
	"Apply the teaching methodology in your system prompt, and find the optimal way to teach me this. " +
	"Find the unconditional truths, plan the motivated derivations/discoveries, so every reasoning step has to land as obviously true. " +
	"Take your time here and really think this through. " +
	"When it's genuinely reasoned out, call plan_init and present the plan; I'll accept it or ask for changes.";

// ─── Practice sessions (owner, 2026-10-04) — marker + ack texts ──────────────
// Single-sourced here per the marker law: the model-facing text of every
// custom marker lives in core/contracts, never in the flattening seam.

/** The model-facing register of a thinking submission (newThinkingMessage
 *  prefixes the learner's text with this label). Hints and commits ride
 *  one channel — the label is the ONLY difference the model sees. */
/** The single submission label (owner round, 2026-10-05): one send
 *  lane — whether a submission claims an answer is read from the text,
 *  not declared by a button. */
export const THINKING_LABEL = "Your thinking";

/** The conclude tool's ack — shared by the executed call (agent layer) and
 *  the dismissal-synthesized pair (input-events), so a concluded problem
 *  reads identically to the model however it concluded. Owner round 16:
 *  the turn ENDS after concluding (a system-prompt law, no tool-level
 *  terminate — the model may speak its closing words first, then must
 *  stop calling tools); the next problem waits for the learner's
 *  explicit go-ahead. */
export const CONCLUDE_ACK_TEXT =
	"Problem concluded. Say your closing words about the learner's work if useful, then END YOUR TURN — no further tool calls. The next problem is NEVER posed here: it waits for the learner's explicit go-ahead (a *Next problem* message, or their own words asking for the next one). Between problems, answer their questions about the concluded one.";

/** The learner's explicit move-on signal (owner round 16, 2026-10-06):
 *  the model-facing text of the practice-next marker — single-sourced
 *  like THINKING_LABEL. The button/Enter-on-empty path appends the
 *  marker; the model reads this and poses (or wraps) per the doctrine. */
export const NEXT_PROBLEM_TEXT =
	"[NEXT PROBLEM] — the learner's explicit go-ahead: pose the next problem now per the selection rules, or wrap the session in text if the arc is complete.";

/** The compaction marker's model-facing header (owner round 14,
 *  2026-10-05). The marker's content is this header + the summary — the
 *  single text the provider sees in place of the dropped span. Wording
 *  law: it must tell the model (a) a cut happened and is routine, (b) the
 *  summary replaces everything before it, (c) what follows is verbatim
 *  recent transcript — so the model neither re-asks covered ground nor
 *  distrusts the seam. */
export const COMPACTED_HISTORY_HEADER =
	"[SESSION HISTORY COMPACTED] The transcript before this point was summarized to fit the context window; the summary below replaces it. Everything after this message is the verbatim recent transcript.";


export interface PlanBlockData {
	/** Only "full" survives (the 2026-09-11 pivot): the plan renders IN
	 *  FLOW once, at authoring. The neighborhood fragments are retired —
	 *  position derives live from the transcript (the persistent DAG
	 *  window is the successor). */
	kind: "full";
	at: string;
	/** The current node at snapshot time (the glow target; null = none). */
	current: string | null;
	/** All nodes of the authored tree. Statuses are the snapshot's,
	 * derived at emission time — the block never re-derives at render. */
	nodes: Array<{ id: string; title: string; status: PlanNodeStatus }>;
	edges: Array<{ from: string; to: string }>;
}

/** Saved-session summary with a message count instead of full history.
 * Phase and pending-input flags derive from native transcript events.
 * Live turn/compaction state is added separately in ChatListItem, not
 * inferred from the saved record. */
export interface ChatSummary {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	/** Normalized kind (absent record field reads as teach). */
	kind: ChatKind;
	messageCount: number;
	/** Transcript-derived phase: probe ends at successful probe_done completion;
	 * plan ends at the first node-tagged teaching question call, not its answer. */
	phase: Phase3;
	/** An unanswered quiz/ask question is waiting for the learner. */
	pendingQuestion: boolean;
	/** A practice problem is posed but not concluded. False on teaching sessions. */
	pendingProblem: boolean;
	/** Saved per-session model/thinking choices included in the list payload. */
	settings?: ChatSettings;
}

/** Session-list row combining a saved summary with live server state.
 * busy means a native conversation turn is in flight; detached background
 * jobs do not make the session busy. These flags are not persisted status. */
export interface ChatListItem extends ChatSummary {
	busy: boolean;
	/** True while background context compaction holds the chat's model gate.
	 * Supplied by the live compaction registry, not by saved compaction markers. */
	compacting: boolean;
}

// ─── Learner images in the lesson (issue #363) ──────────────────────────────

/** One upright, metadata-free picture, stored once per session. */
export interface ImageSnapshot {
	mimeType: "image/png" | "image/jpeg";
	data: string;
	width: number;
	height: number;
}

/** The show_image record payload. Its session-owned snapshot is never model-facing. */
export interface ShowImageDetails {
	/** The absolute path the image was read from. */
	path: string;
	caption?: string;
	mimeType: "image/png" | "image/jpeg";
	/** SHA-256 identity in ChatRecord.imageSnapshots. */
	snapshotId: string;
	width: number;
	height: number;
}

// ─── Artifact renderer registry (client extension point) ────────────────────

/**
 * components/chat.tsx renders any tool part it doesn't specially handle via
 * components/artifacts/index.ts's registry, keyed by tool name ("research",
 * "demo", "visual", …). Workers add renderers there — chat.tsx is off-limits
 * to artifact work. Renderer receives the raw tool part; it typically renders
 * an activity card while state is input-available (poll /api/jobs) and the
 * artifact (iframe / svg) when output-available.
 */
export interface ArtifactPartProps {
	part: {
		type: string;
		state: string;
		toolCallId: string;
		input?: unknown;
		output?: unknown;
		/** The pose-side fold (owner round 17): the whole problem-call
		 * arguments joined onto the conclude part by projectView — the
		 * observability drawer's data. */
		problemInput?: unknown;
		/** The view-seam join for conclude cards (owner round, 2026-10-05):
		 *  the modelSolution committed at POSE time, folded onto the part by
		 *  projectView — the reveal is never re-authored. */
		reveal?: unknown;
	};
}

/**
 * ChatStore — the fs JSON adapter (one file per chat in data/chats/).
 *
 * Implements core/ports.ts ChatStore; the record shapes live in
 * core/contracts.ts (ChatRecord/ChatSummary). Idioms: sync fs, tiny
 * records, id-guarded filenames, JSON with tab indentation. Wired in the
 * composition root (src/server/stores.ts); nothing else constructs it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { ChatStore } from "../core/ports.ts";
import type { ChatRecord, ChatSettings, ChatSummary, ExtractionRunUsage, ImageSnapshot, PlanTree, SideChatThread, StudyDocument, StudyDocumentSet, TurnUsage } from "../core/contracts.ts";
import { CURRENT_CHAT_VERSION } from "../core/contracts.ts";
import { STUDY_DOCUMENT_ID_RE, STUDY_ROOT_DOCUMENT_ID } from "../core/study-document.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { activeProblemOf, danglingQuestionOf } from "../core/native-messages.ts";
import { phaseAt3Lh } from "../core/phases.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";

function chatFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
	return path.join(/* turbopackIgnore: true */ PATHS.chats, `${id}.json`);
}

/** Study documents (read sessions, record version 5): one file per
 *  document under data/chats/<chatId>.docs/, so a document write never
 *  rewrites the transcript and parallel background writers touch only
 *  their own file. The directory name never ends in ".json", so the chat
 *  listing ignores it. */
function documentsDir(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
	return path.join(/* turbopackIgnore: true */ PATHS.chats, `${id}.docs`);
}

function documentFile(id: string, documentId: string): string {
	if (!STUDY_DOCUMENT_ID_RE.test(documentId)) throw new Error(`Invalid study document id: ${documentId}`);
	return path.join(/* turbopackIgnore: true */ documentsDir(id), `${documentId}.json`);
}

/** Parsed-document cache keyed by file path, invalidated by mtime+size:
 *  tree-wide reads (list_documents, the pane's outline) re-read only what
 *  changed. Process-global like the event bus (Next gives route entries
 *  their own module instances). */
interface CachedDocument { mtimeMs: number; size: number; doc: StudyDocument }
function documentCache(): Map<string, CachedDocument> {
	const g = globalThis as typeof globalThis & { __lhStudyDocumentCache?: Map<string, CachedDocument> };
	return (g.__lhStudyDocumentCache ??= new Map());
}

function readDocumentFile(file: string): StudyDocument | null {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(/* turbopackIgnore: true */ file);
	} catch {
		documentCache().delete(file);
		return null;
	}
	const cached = documentCache().get(file);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.doc;
	try {
		const doc = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf-8")) as StudyDocument;
		if (!doc || typeof doc.id !== "string" || !Array.isArray(doc.sections)) return null;
		documentCache().set(file, { mtimeMs: stat.mtimeMs, size: stat.size, doc });
		return doc;
	} catch {
		return null;
	}
}

function writeDocumentFile(id: string, document: StudyDocument): void {
	fs.mkdirSync(documentsDir(id), { recursive: true });
	const file = documentFile(id, document.id);
	writeFileAtomicSync(file, JSON.stringify(document, null, "\t"));
	documentCache().delete(file);
}

/** Every study document of a session: the root in `document`, deeper
 *  documents in `documents` (creation order). Callers get fresh objects
 *  only in the sense that the cache returns the parsed file; treat them as
 *  read-only — the pure engine always returns new documents. */
function readDocuments(id: string): StudyDocumentSet {
	let files: string[];
	try {
		files = fs.readdirSync(/* turbopackIgnore: true */ documentsDir(id)).filter((f) => f.endsWith(".json"));
	} catch {
		return { documents: [] };
	}
	let document: StudyDocument | undefined;
	const documents: StudyDocument[] = [];
	for (const file of files) {
		const doc = readDocumentFile(path.join(/* turbopackIgnore: true */ documentsDir(id), file));
		if (!doc) continue;
		if (doc.id === STUDY_ROOT_DOCUMENT_ID) document = doc;
		else documents.push(doc);
	}
	// Creation order: the server mints doc_<base36 time>_… ids, so the id
	// sorts chronologically; ties fall back to updatedAt.
	documents.sort((a, b) => a.id.localeCompare(b.id) || a.updatedAt.localeCompare(b.updatedAt));
	return { ...(document ? { document } : {}), documents };
}

function getDocument(id: string, documentId: string): StudyDocument | null {
	if (!STUDY_DOCUMENT_ID_RE.test(documentId)) return null;
	return readDocumentFile(documentFile(id, documentId));
}

/** Version 3–4 records carried the documents inline. Move them to files
 *  (a file that already exists is newer and wins), strip the fields, and
 *  stamp the record. Idempotent; runs inside getChat's first read. */
function migrateInlineDocuments(record: ChatRecord): ChatRecord {
	if (record.document === undefined && record.documents === undefined) return record;
	const inline = [...(record.document ? [record.document] : []), ...(record.documents ?? [])];
	for (const doc of inline) {
		if (!doc.id) doc.id = STUDY_ROOT_DOCUMENT_ID;
		if (!STUDY_DOCUMENT_ID_RE.test(doc.id)) continue;
		if (fs.existsSync(/* turbopackIgnore: true */ documentFile(record.id, doc.id))) continue;
		writeDocumentFile(record.id, doc);
	}
	const { document: _document, documents: _documents, ...rest } = record;
	writeChat(rest);
	return { ...rest, version: CURRENT_CHAT_VERSION };
}

/** THE SILENCE LAW (push S6, 2026-10-02): chats-changed announces ONLY
 *  list-SHAPE mutations — createChat, renameChat, deleteChat (below,
 *  each emits post-write). The content writers (saveMessages,
 *  appendTurnUsage, appendExtractionUsage, saveSettings, saveTree) are
 *  DELIBERATELY SILENT: saveMessages fires per turn-persist and would
 *  spam the bus, and every list-visible change it causes (title, order,
 *  phase, busy, pendingQuestion) is already announced by turn-started /
 *  turn-settled, which the sidebar refetches on. Silence here is law,
 *  not oversight. */
function createChat(title: string, kind?: "practice" | "read"): ChatRecord {
	const now = new Date().toISOString();
	const record: ChatRecord = {
		id: `chat_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		title: title.trim() || "Untitled session",
		createdAt: now,
		updatedAt: now,
		messages: [],
		// Practice/read sessions carry the marker; teach stays ABSENT
		// (absence reads as teach — pre-practice records never migrate).
		...(kind ? { kind } : {}),
	};
	fs.mkdirSync(PATHS.chats, { recursive: true });
	writeChat(record);
	emit("chats-changed", {});
	return { ...record, version: CURRENT_CHAT_VERSION }; // the in-memory twin of what landed on disk
}

/** THE WRITE CHOKE POINT (schema-versioning wave, owner 2026-10-10): every
 *  record persist goes through here and carries the CURRENT version stamp —
 *  lazy migration means existing files only get stamped on their next write.
 *  A future-version guard lives on the read side (getChat). */
function writeChat(record: ChatRecord): void {
	writeFileAtomicSync(chatFile(record.id), JSON.stringify({ ...record, version: CURRENT_CHAT_VERSION }, null, "\t"), { allowInPlaceFallback: true });
}

function getChat(id: string): ChatRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ chatFile(id), "utf-8"));
	} catch {
		return null;
	}
	// Honest refusal (owner ruling 2026-10-10): a record stamped NEWER than
	// this build (the downgrade scenario) reads as absent, never misparsed —
	// the next read-modify-write must not rewrite what it doesn't understand.
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_CHAT_VERSION) {
		console.error(`[chat ${id}] record stamped with schema version ${v} > ${CURRENT_CHAT_VERSION} — this app build is older; refusing to read it`);
		return null;
	}
	const record = parsed as ChatRecord;
	// Record version 5: inline study documents move to their own files.
	try {
		return migrateInlineDocuments(record);
	} catch (err) {
		console.error(`[chat ${id}] study-document migration failed:`, err);
		return record;
	}
}

function listChats(): ChatSummary[] {
	try {
		fs.mkdirSync(PATHS.chats, { recursive: true });
		return fs
			.readdirSync(/* turbopackIgnore: true */ PATHS.chats)
			.filter((f) => f.endsWith(".json"))
			.map((f) => getChat(f.slice(0, -5)))
			.filter((r): r is ChatRecord => r !== null)
			.map(({ messages, tree, document: _document, documents: _documents, readingDocumentId, turns, extractions, imageSnapshots: _imageSnapshots, sideChats: _sideChats, ...summary }) => {
				// Per-record isolation (Wave B): a record whose messages fail the
				// projection (e.g. pre-Wave-B UIMessage-format scratch — the
				// zero-back-compat wipe makes these "corrupt") must not blank the
				// whole sidebar — same isolation getChat's per-file catch gives.
				try {
					return {
						// turns and extractions stay out of the list payload (list =
						// summaries; usage aggregates ride the full record, the picker
						// never needs them).
						...summary,
						// Normalized kind: absent record field reads as teach.
						kind: summary.kind ?? "teach",
						messageCount: messages.length,
						// Record-derived status for the session picker: phase from the
						// transcript's explicit events (probe_done concluded / verdict
						// accepted — docs/archive/probe-teach-split.md §4), pending question
						// from the native dangling-call scan. Wave D: both folds read
						// the NATIVE record (core/phases.ts phaseAt3Lh +
						// native-messages.ts danglingQuestionOf). Liveness (busy) is
						// NOT record-derived — the API route merges it (ChatListItem).
						phase: phaseAt3Lh(messages),
						pendingQuestion: danglingQuestionOf(messages) !== null,
						// Practice: a posed problem with no conclude (the sidebar's
						// "Problem waiting"); false on teaching sessions, which
						// have no problem tool.
						pendingProblem: activeProblemOf(messages) !== null,
					};
				} catch (err) {
					console.error(`[chat ${summary.id}] summary projection failed:`, err);
					return null;
				}
			})
			.filter((s) => s !== null)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}

/** Persist the full native message list (the record IS the agent state —
 *  Wave B: replay is state.messages = record.messages). SILENT by the
 *  events law — see the SILENCE LAW comment at createChat. */
function saveMessages(id: string, messages: LhMessage[]): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	// Side-delivery watermarks are part of the appended native entries,
	// so input + updates commit together without mutating thread history.
	record.messages = messages;
	record.updatedAt = new Date().toISOString();
	writeChat(record);
}

/** A synchronous read/merge/write keeps concurrent worker and turn writes from losing snapshots. */
function saveImageSnapshot(id: string, snapshotId: string, image: ImageSnapshot): void {
	if (!/^[a-f0-9]{64}$/.test(snapshotId) || createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex") !== snapshotId) {
		throw new Error("Invalid image snapshot identity");
	}
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	if (record.imageSnapshots?.[snapshotId]) return;
	record.imageSnapshots = { ...record.imageSnapshots, [snapshotId]: {
		mimeType: image.mimeType, data: image.data, width: image.width, height: image.height,
	} };
	writeChat(record);
}

/** Append one usage entry to the record's turn log — idempotent per
 * turn id: each REQUEST carries its own id, so a replay of the same turn's
 * persist appends once, while continuation turns (which share a response
 *  message id) each keep their usage. */
function appendTurnUsage(id: string, entry: TurnUsage): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.turns = record.turns?.some((t) => t.id === entry.id)
		? record.turns
		: [...(record.turns ?? []), entry];
	writeChat(record);
}

/** Append one extraction-run usage entry to the record's extractions
 * log — idempotent per startedAt: a retry that reaches the append twice
 * (abort replays) does not double-count spend. */
function appendExtractionUsage(id: string, entry: ExtractionRunUsage): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.extractions = record.extractions?.some((r) => r.startedAt === entry.startedAt)
		? record.extractions
		: [...(record.extractions ?? []), entry];
	writeChat(record);
}

/** Persist the per-chat model/thinking settings — replace-whole (the
 * picker sends the complete object; absent = config defaults). */
function saveSettings(id: string, settings: ChatSettings): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	// Like saveTree: a settings tweak is not conversation activity, so it
	// deliberately does NOT bump updatedAt (sidebar order must not churn).
	record.settings = settings;
	writeChat(record);
}

/** Rename a session (the header's click-to-edit title, 2026-09-17). Like
 * saveSettings, a rename is NOT conversation activity: updatedAt stays put
 * so sidebar order never churns. Same fallback as createChat — the empty
 * string becomes "Untitled session" (the API gate rejects it first; this
 * is the honest floor for any other caller). */
function renameChat(id: string, title: string): ChatRecord {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.title = title.trim() || "Untitled session";
	writeChat(record);
	emit("chats-changed", {});
	return record;
}

/** Delete the session record file entirely (session-deletion wave 6,
 *  owner 2026-09-22). False when the id is unknown — the route turns that
 *  into a 404. The record's graph traces and jobs are the route's
 *  choreography (core/graph-deletion.ts), not the store's. */
function deleteChat(id: string): boolean {
	try {
		fs.unlinkSync(chatFile(id));
		removeLeftoverTemps(chatFile(id));
		try {
			const dir = documentsDir(id);
			for (const file of fs.readdirSync(/* turbopackIgnore: true */ dir)) documentCache().delete(path.join(dir, file));
			fs.rmSync(/* turbopackIgnore: true */ dir, { recursive: true, force: true });
		} catch {
			/* no study documents */
		}
		emit("chats-changed", {}); // only a real removal — the present-entry law
		return true;
	} catch {
		return false; // never existed, already deleted, or unreadable — same answer
	}
}

/** Persist the session plan tree (plan tools call this in execute). */
function saveTree(id: string, tree: PlanTree): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.tree = tree;
	// Deliberately does NOT bump updatedAt: tree mutations piggyback on the
	// turn's saveMessages, and sidebar ordering shouldn't churn on tree edits.
	writeChat(record);
}

/** Persist one study document to its own file (read sessions). Not
 *  conversation activity — the record (and its updatedAt) is untouched,
 *  which is what lets parallel background writers save independently. */
function saveDocument(id: string, document: StudyDocument): void {
	if (!fs.existsSync(/* turbopackIgnore: true */ chatFile(id))) throw new Error(`Chat not found: ${id}`);
	writeDocumentFile(id, document);
}

/** View state for chat steering (read sessions): which document the learner
 *  has open. Like saveTree/saveDocument, not conversation activity. */
function saveReadingDocumentId(id: string, documentId: string): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	if (documentId !== STUDY_ROOT_DOCUMENT_ID && !getDocument(id, documentId)) {
		throw new Error(`No study document with id "${documentId}"`);
	}
	record.readingDocumentId = documentId;
	writeChat(record);
}

/** Quick-start identity for a read session: which imported roadmap it came
 *  from. Like readingDocumentId, view state, not activity. */
function saveRoadmapSlug(id: string, roadmapSlug: string): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.roadmapSlug = roadmapSlug;
	writeChat(record);
}

/** Side-question threads (2026-11-02): one synchronous read-modify-write,
 *  so a concurrent turn's saveMessages (which re-reads the record) never
 *  loses a thread and a thread write never loses messages. Null when the
 *  chat is gone (a side answer finishing after session deletion). Silent
 *  and not conversation activity, like saveSettings. */
function updateSideChats(id: string, update: (threads: SideChatThread[]) => SideChatThread[]): SideChatThread[] | null {
	const record = getChat(id);
	if (!record) return null;
	const next = update(record.sideChats ?? []);
	if (next.length > 0) record.sideChats = next;
	else delete record.sideChats;
	writeChat(record);
	return next;
}

export const chatStore: ChatStore = {
	createChat,
	getChat,
	listChats,
	saveMessages,
	saveImageSnapshot,
	saveTree,
	saveDocument,
	readDocuments,
	getDocument,
	saveReadingDocumentId,
	saveRoadmapSlug,
	saveSettings,
	renameChat,
	deleteChat,
	appendTurnUsage,
	appendExtractionUsage,
	updateSideChats,
};

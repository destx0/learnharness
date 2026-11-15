import type { CallUsage, StudyDocument, StudyWriterView } from "../core/contracts.ts";
import { emit } from "../core/events.ts";
import { finishReadGeneration, noteReadGeneration } from "../core/read-generation.ts";
import { graphToolsEnabled, resolveConversationSpec } from "../core/settings-resolution.ts";
import {
	studyDocumentById,
	studyDocumentStatus,
	studySubtopicPending,
} from "../core/study-document.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { runReadWriter, type ReadWriterAssignment } from "../agent/read-writer.ts";
import { callUsage } from "../agent/subagents/extraction.ts";
import { isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { providerKeyPresent } from "./keys.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";
import { effectiveSettings, stores } from "./stores.ts";

/**
 * THE BACKGROUND WRITER QUEUE (read sessions, 2026-11-15).
 *
 * Click-generated document work — deep dives, a roadmap topic's lazy
 * summary, subtopic overviews, more questions, fresh directions — runs as
 * parallel background writers (agent/read-writer.ts), never as chat turns:
 * a session allows one chat turn at a time, and a click must never answer
 * "a turn is already running". At most PER_SESSION writers run per session;
 * the rest wait FIFO. The process-wide worker request pool
 * (worker-request-admission.ts) still caps concurrent provider requests.
 *
 * Identity: one task per KEY (kind + target), so a second click on the same
 * topic, or the auto-summary firing twice while it is on screen, joins the
 * existing task instead of spawning another. A failed key is remembered
 * (with its error) so the pane shows Retry instead of re-firing an
 * automatic summary forever; an explicit retry clears it.
 *
 * Settlement: a deep dive's pending child becomes ready (sections landed)
 * or failed (empty); a summary whose section is still a seed counts as
 * failed. Every enqueue and settle emits document-changed so open panes
 * refetch their writer state.
 *
 * Model: the SESSION's own conversation model (the chat's settings over
 * the strong slot), the same quality as what the chat itself writes.
 * Usage lands in the session's turns ledger, so the session cost includes
 * its writers.
 *
 * All state is on globalThis (the turn-liveness lesson: Next gives each
 * route entry its own module instance).
 */

export const READ_WRITERS_PER_SESSION = 8;
/** How long a failure suppresses automatic re-firing of the same key. */
const FAILURE_TTL_MS = 30 * 60_000;

export type ReadWriterTaskView = StudyWriterView;

interface WriterTask {
	id: string;
	key: string;
	chatId: string;
	assignment: ReadWriterAssignment;
	label: string;
	status: "queued" | "running";
	createdAt: number;
	controller: AbortController;
}

interface WriterFailure {
	key: string;
	chatId: string;
	assignment: ReadWriterAssignment;
	label: string;
	error: string;
	at: number;
}

export interface ReadWriterRun {
	taskId: string;
	chatId: string;
	assignment: ReadWriterAssignment;
	signal: AbortSignal;
	onActivity: (activity: string) => void;
}
/** The run seam: production builds the session-model sub-agent; tests
 *  inject a scripted executor. */
export type ReadWriterExecutor = (run: ReadWriterRun) => Promise<void>;

interface WriterState {
	tasks: Map<string, WriterTask>;
	failures: Map<string, WriterFailure>;
	executor?: ReadWriterExecutor;
}

function state(): WriterState {
	const g = globalThis as typeof globalThis & { __lhReadWriters?: WriterState };
	return (g.__lhReadWriters ??= { tasks: new Map(), failures: new Map() });
}

/** Test seam: replace (or restore, with undefined) the writer executor. */
export function setReadWriterExecutor(executor: ReadWriterExecutor | undefined): void {
	state().executor = executor;
}

/** Test seam: forget every task and failure (aborting running ones). */
export function resetReadWriters(): void {
	for (const task of state().tasks.values()) task.controller.abort();
	state().tasks.clear();
	state().failures.clear();
}

export function readWriterKey(chatId: string, assignment: ReadWriterAssignment): string {
	const batch = assignment.kind === "subtopics" && assignment.subtopicIds?.length ? assignment.subtopicIds.join(",") : "";
	return [chatId, assignment.kind, assignment.documentId, assignment.sectionId ?? "", batch].join("|");
}

function view(task: WriterTask | WriterFailure, status: ReadWriterTaskView["status"], id: string, error?: string): ReadWriterTaskView {
	return {
		id,
		key: task.key,
		kind: task.assignment.kind,
		documentId: task.assignment.documentId,
		...(task.assignment.sectionId ? { sectionId: task.assignment.sectionId } : {}),
		...(task.assignment.parent ? { topicId: task.assignment.parent.topicId } : {}),
		status,
		label: task.label,
		...(error ? { error } : {}),
	};
}

/** The session's writers: queued, running, and recently failed. */
export function readWriterStatus(chatId: string): ReadWriterTaskView[] {
	const now = Date.now();
	const out: ReadWriterTaskView[] = [];
	for (const task of state().tasks.values()) if (task.chatId === chatId) out.push(view(task, task.status, task.id));
	for (const failure of state().failures.values()) {
		if (failure.chatId !== chatId) continue;
		if (now - failure.at > FAILURE_TTL_MS) {
			state().failures.delete(failure.key);
			continue;
		}
		if (out.some((entry) => entry.key === failure.key)) continue;
		out.push(view(failure, "failed", `failed:${failure.key}`, failure.error));
	}
	return out;
}

/** Is any writer queued or running for this document? (Crash recovery
 *  must not finalize a child whose writer is still working.) */
export function readWriterActive(chatId: string, documentId: string): boolean {
	for (const task of state().tasks.values()) {
		if (task.chatId === chatId && task.assignment.documentId === documentId) return true;
	}
	return false;
}

function rowId(task: WriterTask): string {
	return `read:${task.id}`;
}

function sessionTitle(chatId: string): string {
	return stores.chatStore.getChat(chatId)?.title ?? "Reading session";
}

/** Queue one writer. `retry` clears a remembered failure of the same key
 *  (an explicit click); without it a recent failure is reported back
 *  instead of re-firing (the automatic summary). */
export function enqueueReadWriter(
	chatId: string,
	assignment: ReadWriterAssignment,
	label: string,
	options: { retry?: boolean } = {},
): { taskId: string; deduped: boolean; failed?: string } {
	const key = readWriterKey(chatId, assignment);
	for (const task of state().tasks.values()) {
		if (task.key === key) return { taskId: task.id, deduped: true };
	}
	const failure = state().failures.get(key);
	if (failure && !options.retry && Date.now() - failure.at <= FAILURE_TTL_MS) {
		return { taskId: `failed:${key}`, deduped: true, failed: failure.error };
	}
	state().failures.delete(key);
	const task: WriterTask = {
		id: `w_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		key,
		chatId,
		assignment,
		label,
		status: "queued",
		createdAt: Date.now(),
		controller: new AbortController(),
	};
	state().tasks.set(task.id, task);
	noteReadGeneration(rowId(task), chatId, sessionTitle(chatId), "Queued", label);
	emit("document-changed", { chatId, documentId: assignment.documentId });
	pump(chatId);
	return { taskId: task.id, deduped: false };
}

/** The dock's END control. True when a task was aborted. */
export function abortReadWriter(taskId: string): boolean {
	const task = state().tasks.get(taskId.startsWith("read:") ? taskId.slice("read:".length) : taskId);
	if (!task) return false;
	task.controller.abort();
	if (task.status === "queued") {
		state().tasks.delete(task.id);
		finishReadGeneration(rowId(task));
		settleDocument(task);
		emit("document-changed", { chatId: task.chatId, documentId: task.assignment.documentId });
	}
	return true;
}

function pump(chatId: string): void {
	const tasks = [...state().tasks.values()].filter((task) => task.chatId === chatId);
	let running = tasks.filter((task) => task.status === "running").length;
	for (const task of tasks.sort((a, b) => a.createdAt - b.createdAt)) {
		if (running >= READ_WRITERS_PER_SESSION) break;
		if (task.status !== "queued") continue;
		task.status = "running";
		running++;
		void run(task);
	}
}

/** A deep dive's pending child: ready with content, failed when empty. */
function settleDocument(task: WriterTask): void {
	if (task.assignment.kind !== "deep-dive") return;
	if (readWriterActiveExcept(task)) return;
	const doc = stores.chatStore.getDocument(task.chatId, task.assignment.documentId);
	if (!doc || studyDocumentStatus(doc) !== "writing") return;
	const next: StudyDocument = { ...doc, status: doc.sections.length > 0 ? "ready" : "failed", updatedAt: new Date().toISOString() };
	stores.chatStore.saveDocument(task.chatId, next);
}

function readWriterActiveExcept(task: WriterTask): boolean {
	for (const other of state().tasks.values()) {
		if (other !== task && other.chatId === task.chatId && other.assignment.documentId === task.assignment.documentId && other.assignment.kind === "deep-dive") return true;
	}
	return false;
}

/** Did the writer actually deliver? (A run can end cleanly without the
 *  write landing — the model gave up or kept hitting validation.) */
function deliveryProblem(task: WriterTask): string | null {
	const doc = stores.chatStore.getDocument(task.chatId, task.assignment.documentId);
	if (!doc) return "The document no longer exists.";
	const section = task.assignment.sectionId ? doc.sections.find((s) => s.id === task.assignment.sectionId) : undefined;
	switch (task.assignment.kind) {
		case "deep-dive":
			return doc.sections.length > 0 ? null : "The writer stopped before writing any section.";
		case "summary":
			return section && !section.seed ? null : "The writer stopped before writing the summary.";
		case "subtopics": {
			const wanted = new Set(task.assignment.subtopicIds ?? []);
			const pending = (section?.suggestions ?? []).filter((t) => (wanted.size === 0 || wanted.has(t.id)) && studySubtopicPending(t));
			return pending.length === 0 ? null : `${pending.length} subtopic overview(s) were not written.`;
		}
		default:
			return null;
	}
}

async function run(task: WriterTask): Promise<void> {
	noteReadGeneration(rowId(task), task.chatId, sessionTitle(task.chatId), "Writing", task.label);
	let error: string | null = null;
	try {
		const executor = state().executor ?? defaultExecutor;
		await executor({
			taskId: task.id,
			chatId: task.chatId,
			assignment: task.assignment,
			signal: task.controller.signal,
			onActivity: (activity) => noteReadGeneration(rowId(task), task.chatId, sessionTitle(task.chatId), "Writing", `${task.label} · ${activity}`),
		});
		error = deliveryProblem(task);
	} catch (err) {
		error = task.controller.signal.aborted
			? "Stopped."
			: err instanceof Error ? err.message : String(err);
		if (!task.controller.signal.aborted) console.error(`[read-writer ${task.chatId}] ${task.label} failed:`, err);
	} finally {
		state().tasks.delete(task.id);
		finishReadGeneration(rowId(task));
	}
	if (error) state().failures.set(task.key, { key: task.key, chatId: task.chatId, assignment: task.assignment, label: task.label, error, at: Date.now() });
	try {
		settleDocument(task);
	} catch (err) {
		console.error(`[read-writer ${task.chatId}] settlement failed:`, err);
	}
	emit("document-changed", { chatId: task.chatId, documentId: task.assignment.documentId });
	pump(task.chatId);
}

/** Production: the session's conversation model, background-flagged off
 *  (a click is the learner's own request), usage into the turns ledger. */
const defaultExecutor: ReadWriterExecutor = async ({ taskId, chatId, assignment, signal, onActivity }) => {
	// Writers make real provider calls; a test that did not script one
	// must never reach the network.
	if (process.env.NODE_ENV === "test") throw new Error("Background writers need an injected executor under test.");
	const record = stores.chatStore.getChat(chatId);
	if (!record) throw new Error("The session no longer exists.");
	const effective = effectiveSettings();
	const spec = resolveConversationSpec(record.settings, effective.models.strong);
	if (!spec) throw new Error("No model is configured. Set the strong model in Settings → Models.");
	if (isSubscriptionProvider(spec.provider)) await refreshConnectionCatalog(spec.provider);
	if (!providerKeyPresent(spec.provider)) throw new Error(`No API key is set for ${spec.provider}.`);
	const engine = piEngineForSpec(spec, false, undefined, () => stores.settingsStore.readSettings()?.models?.strong?.cacheRetention);
	const steps: CallUsage[] = [];
	try {
		await runReadWriter({
			assignment,
			chatId,
			sessionTitle: record.title,
			chatStore: stores.chatStore,
			...(graphToolsEnabled(effective) ? { graphStore: stores.graphStore } : {}),
			engine,
			promptSwitches: effective.agent.prompts,
			signal,
			onUsage: (usage) => steps.push(callUsage(usage)),
			onActivity,
		});
	} finally {
		if (steps.length > 0) {
			stores.chatStore.appendTurnUsage(chatId, {
				id: `writer_${taskId}`,
				messageId: "",
				at: new Date().toISOString(),
				model: `${engine.model.provider}:${engine.model.id}`,
				steps,
			});
		}
	}
};

/** Queue the roadmap opening's subtopic overviews: every pending subtopic,
 *  in batches of at most SUBTOPIC_BATCH per writer, in roadmap order.
 *  Idempotent (keys dedupe). Returns how many writers were queued. */
const SUBTOPIC_BATCH = 24;
export function enqueueRoadmapSubtopicWriters(chatId: string): number {
	const docs = stores.chatStore.readDocuments(chatId);
	const root = studyDocumentById(docs, "root");
	if (!root?.roadmap) return 0;
	let queued = 0;
	for (const section of root.sections) {
		const pending = (section.suggestions ?? []).filter(studySubtopicPending);
		for (let i = 0; i < pending.length; i += SUBTOPIC_BATCH) {
			const batch = pending.slice(i, i + SUBTOPIC_BATCH).map((t) => t.id);
			const result = enqueueReadWriter(
				chatId,
				{ kind: "subtopics", documentId: root.id, sectionId: section.id, subtopicIds: batch },
				`Subtopic overviews · ${section.heading}`,
			);
			if (!result.deduped) queued++;
		}
	}
	return queued;
}

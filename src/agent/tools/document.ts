import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { ChatStore } from "../../core/ports.ts";
import type { StudyDocumentSet, StudyRelatedLink, StudyTopicSuggestion } from "../../core/contracts/chat.ts";
import {
	EDIT_DOCUMENT_TOOL,
	READ_DOCUMENT_TOOL,
} from "../../core/contracts/chat.ts";
import {
	applyStudyDocumentEdit,
	applyStudyQuestionsAppend,
	applyStudySubtopicBlurbs,
	applyStudySuggestions,
	StudyDocumentError,
	studyDocumentById,
	studyDocumentList,
	studyDocumentToc,
	studyDocumentTreeText,
	STUDY_BODY_MAX,
	STUDY_HEADING_MAX,
	STUDY_QUESTIONS_APPEND_MAX,
	STUDY_QUESTIONS_MAX,
	STUDY_QUESTION_MAX,
	STUDY_RELATED_MAX,
	STUDY_RELATED_REASON_MAX,
	STUDY_ROOT_DOCUMENT_ID,
	STUDY_SECTIONS_MAX,
	STUDY_SUGGESTION_BLURB_MAX,
	STUDY_SUGGESTION_HEADING_MAX,
	STUDY_SUGGESTIONS_MAX,
	STUDY_TITLE_MAX,
	STUDY_ANSWER_MAX,
} from "../../core/study-document.ts";
import { emit } from "../../core/events.ts";

/**
 * The READ agent's document tools (read sessions, owner 2026-11-04; deeper
 * tree 2026-11-12; background writers 2026-11-15).
 *
 * The living study documents are artifacts of the SESSION, not transcript
 * messages: every write goes through ChatStore.saveDocument (one file per
 * document since record version 5) and the open reading pane refetches on
 * the document-changed event. That split is what lets the documents survive
 * compaction, reloads, and a conversation far longer than its context.
 *
 * Two callers build these tools:
 *   - the chat turn (the steering conversation). An omitted documentId
 *     means `defaultDocumentId` — the document the learner had open WHEN
 *     THE TURN STARTED, pinned by the handler. Reading the live
 *     readingDocumentId instead would let a mid-turn navigation silently
 *     retarget the agent's edits into another document.
 *   - a background writer (server/read-writers.ts), which carries a
 *     `scope`: writes outside the scope's document (and, for a topic
 *     summary, outside its one section) are rejected, so parallel writers
 *     cannot clobber each other's work.
 *
 * Writes from both are serialized per session (withDocumentLock), so a
 * read-modify-write never sees a half-applied sibling.
 *
 * The tools are SERVER-EXECUTED like plan_init: validation failures return
 * ok:false with the problems so the model retries in the same run.
 */

export interface DocumentToolScope {
	/** The only document this caller may write. */
	documentId: string;
	/** When set, section patches may touch only this section (and the
	 *  document's title/order/related/remove stay off-limits). */
	sectionId?: string;
}

export interface DocumentToolContext {
	chatId: string;
	chatStore: ChatStore;
	/** The target of an omitted documentId (the chat turn's pinned open
	 *  document). Absent = the root. */
	defaultDocumentId?: string;
	/** Background-writer write scope (see DocumentToolScope). */
	scope?: DocumentToolScope;
	/** Progress line for the writer's activity row. */
	onActivity?: (activity: string) => void;
}

/** Parallel document tool calls are allowed, but writes are serialized per
 *  session: read-modify-write must never see a half-applied sibling batch.
 *  Process-global (Next gives route entries their own module copies; the
 *  chat turn and the background writers must share one queue). */
function documentQueues(): Map<string, Promise<unknown>> {
	const g = globalThis as typeof globalThis & { __lhStudyDocumentQueues?: Map<string, Promise<unknown>> };
	return (g.__lhStudyDocumentQueues ??= new Map());
}
export function withDocumentLock<T>(chatId: string, work: () => Promise<T>): Promise<T> {
	const queues = documentQueues();
	const previous = queues.get(chatId) ?? Promise.resolve();
	const run = previous.then(work, work);
	const tail = run.then(() => undefined, () => undefined);
	queues.set(chatId, tail);
	void tail.finally(() => {
		if (queues.get(chatId) === tail) queues.delete(chatId);
	});
	return run;
}

const topicSuggestion = Type.Object({
	id: Type.String({
		maxLength: 64,
		description: "Stable lowercase slug, unique within this chapter.",
	}),
	heading: Type.String({
		maxLength: STUDY_SUGGESTION_HEADING_MAX,
		description: "Short topic title — a direction the learner can choose.",
	}),
	blurb: Type.String({
		maxLength: STUDY_SUGGESTION_BLURB_MAX,
		description: "One line: what going deeper would cover and why it follows from this chapter.",
	}),
	documentId: Type.Optional(
		Type.String({
			description:
				"An already-written document this direction points to. Omit to make the direction generate a new child document.",
		}),
	),
	sectionId: Type.Optional(
		Type.String({
			description: "A chapter inside documentId; omit for the document top.",
		}),
	),
});

const questionPatch = Type.Object({
	id: Type.String({
		maxLength: 64,
		description: "Stable lowercase slug, unique within this chapter's questions.",
	}),
	question: Type.String({
		maxLength: STUDY_QUESTION_MAX,
		description: "One self-check question the learner can try to answer before revealing the answer.",
	}),
	answer: Type.String({
		maxLength: STUDY_ANSWER_MAX,
		description: "The model answer — concise but complete, in the reader's terms.",
	}),
});

const sectionPatch = Type.Object({
	id: Type.String({
		description:
			"Stable section id — a lowercase slug (a-z, 0-9, hyphens/underscores), chosen once and never reused for different material. Existing ids update in place.",
	}),
	heading: Type.Optional(
		Type.String({
			maxLength: STUDY_HEADING_MAX,
			description: "Short TOC label. Required for a new section; omit to keep an existing heading.",
		}),
	),
	body: Type.Optional(
		Type.String({
			maxLength: STUDY_BODY_MAX,
			description:
				"Markdown body (LaTeX and mermaid render). Required for a new section; omit to keep an existing body. Do not repeat the section heading inside it.",
		}),
	),
	suggestions: Type.Optional(
		Type.Array(topicSuggestion, {
			maxItems: STUDY_SUGGESTIONS_MAX,
			description:
				"This chapter's 2–4 deeper directions, shown immediately in the reading pane. Include them whenever you write or substantially revise the section; omit on small edits to keep the existing directions. An empty array clears them. Roadmap subtopics on a seeded chapter are always kept; directions you send are added beside them.",
		}),
	),
	questions: Type.Optional(
		Type.Array(questionPatch, {
			maxItems: STUDY_QUESTIONS_MAX,
			description:
				"Replace this chapter's self-check questions (1–3 for a new chapter), hidden in a collapsed accordion. Include them whenever you write or substantially revise the section; omit on small edits. An empty array clears them. To ADD questions to an existing set, use add_questions instead.",
		}),
	),
});

const relatedLink = Type.Object({
	documentId: Type.String({
		description: "The related document's id from list_documents.",
	}),
	sectionId: Type.Optional(
		Type.String({
			description: "A chapter id inside that document; omit for the document itself.",
		}),
	),
	reason: Type.String({
		maxLength: STUDY_RELATED_REASON_MAX,
		description: "One line: why this is genuinely related.",
	}),
});

export const editDocumentInput = Type.Object({
	documentId: Type.Optional(
		Type.String({
			description:
				"Target document id. Omit to edit the document the learner had open when this turn started (the root when none). A deeper document must already exist; this tool never invents ids.",
		}),
	),
	title: Type.Optional(
		Type.String({
			maxLength: STUDY_TITLE_MAX,
			description: "Document title. Required on the first edit of the root; omit to keep the current title.",
		}),
	),
	sections: Type.Optional(
		Type.Array(sectionPatch, {
			maxItems: STUDY_SECTIONS_MAX,
			description:
				"Upsert sections by id. New ids append in the order given; existing ids update only the fields provided. A compact first summary can be one call; a long one may be split across a few calls, and later revisions stay small.",
		}),
	),
	remove: Type.Optional(
		Type.Array(Type.String(), {
			maxItems: STUDY_SECTIONS_MAX,
			description: "Section ids to delete.",
		}),
	),
	order: Type.Optional(
		Type.Array(Type.String(), {
			maxItems: STUDY_SECTIONS_MAX,
			description:
				"The complete section order — a permutation of every current id after this edit. Omit to keep the current order (new sections append).",
		}),
	),
	related: Type.Optional(
		Type.Array(relatedLink, {
			maxItems: STUDY_RELATED_MAX,
			description:
				"Replace this document's related-topic links. Only genuinely related documents/chapters; these appear as dashed edges in the topic graph.",
		}),
	),
});

export const readDocumentInput = Type.Object({
	documentId: Type.Optional(
		Type.String({
			description: "Target document id; omit for the document the learner had open when this turn started.",
		}),
	),
	sectionId: Type.Optional(
		Type.String({
			description: "Read just this section by id; omit to read the whole document.",
		}),
	),
});

export const suggestDeeperInput = Type.Object({
	documentId: Type.Optional(
		Type.String({
			description: "Target document id; omit for the document the learner had open when this turn started.",
		}),
	),
	sectionId: Type.String({
		description: "The chapter whose deeper directions are being replaced.",
	}),
	suggestions: Type.Array(topicSuggestion, {
		minItems: 1,
		maxItems: STUDY_SUGGESTIONS_MAX,
		description:
			"2–4 genuinely deeper directions. Each is a short heading plus one line of what it covers. Point at an existing document when the topic is already written. Roadmap subtopics on a seeded chapter are kept regardless.",
	}),
});

export const describeSubtopicsInput = Type.Object({
	documentId: Type.Optional(
		Type.String({
			description: "Target document id; omit for the document the learner had open when this turn started.",
		}),
	),
	sectionId: Type.String({
		description: "The main-topic section whose roadmap subtopics are being described.",
	}),
	subtopics: Type.Array(
		Type.Object({
			id: Type.String({ description: "An existing roadmap subtopic id in this section." }),
			blurb: Type.String({
				maxLength: STUDY_SUGGESTION_BLURB_MAX,
				description: "One or two sentences: what this subtopic covers and why it matters. Keep it concrete.",
			}),
		}),
		{
			minItems: 1,
			maxItems: STUDY_SUGGESTIONS_MAX,
			description: "A batch of subtopic overviews. Batches merge by id; titles and roadmap pointers stay untouched.",
		},
	),
});

export const addQuestionsInput = Type.Object({
	documentId: Type.Optional(
		Type.String({
			description: "Target document id; omit for the document the learner had open when this turn started.",
		}),
	),
	sectionId: Type.String({ description: "The chapter receiving the new questions." }),
	questions: Type.Array(questionPatch, {
		minItems: 1,
		maxItems: STUDY_QUESTIONS_APPEND_MAX,
		description: "Only the NEW questions (2–3 is usual), each with a new id. Existing questions are kept automatically.",
	}),
});

export const listDocumentsInput = Type.Object({});

/** The slim result shared by the editing tools. `changed` is the UI's
 *  one-line "Document updated · …" descriptor; the model gets the TOC so
 *  it can reference ids exactly. */
interface DocumentToolResult {
	ok: boolean;
	error?: string;
	documentId?: string;
	revision?: number;
	title?: string;
	toc?: Array<{ id: string; heading: string }>;
	changed?: Array<{ id: string; heading: string }>;
}

function targetId(ctx: DocumentToolContext, documentId?: string): string {
	return documentId ?? ctx.scope?.documentId ?? ctx.defaultDocumentId ?? STUDY_ROOT_DOCUMENT_ID;
}

function unknownDocument(id: string, docs: StudyDocumentSet): string {
	const ids = studyDocumentList(docs).map((doc) => doc.id);
	return ids.length > 0
		? `No study document with id "${id}". Current ids: ${ids.join(", ")}`
		: "No study document exists yet.";
}

/** A background writer may write only its assigned target. */
function scopeProblem(ctx: DocumentToolContext, id: string, sectionId?: string): string | null {
	const scope = ctx.scope;
	if (!scope) return null;
	if (id !== scope.documentId) return `This writer may only write document "${scope.documentId}", not "${id}".`;
	if (scope.sectionId && sectionId !== undefined && sectionId !== scope.sectionId) {
		return `This writer may only write section "${scope.sectionId}" of "${scope.documentId}", not "${sectionId}".`;
	}
	return null;
}

/** Related targets must exist in this session; the pure engine owns format
 *  and self-link validation. */
function relatedTargetProblems(docs: StudyDocumentSet, links: readonly StudyRelatedLink[]): string[] {
	const problems: string[] = [];
	for (const [i, link] of links.entries()) {
		if (!link || typeof link.documentId !== "string") continue;
		const target = studyDocumentById(docs, link.documentId);
		if (!target) {
			problems.push(`related[${i}]: no document with id "${link.documentId}"`);
			continue;
		}
		if (link.sectionId && !target.sections.some((section) => section.id === link.sectionId)) {
			problems.push(`related[${i}]: "${link.documentId}" has no section "${link.sectionId}"`);
		}
	}
	return problems;
}

function suggestionTargetProblems(docs: StudyDocumentSet, suggestions: readonly StudyTopicSuggestion[]): string[] {
	const problems: string[] = [];
	for (const [i, suggestion] of suggestions.entries()) {
		if (!suggestion || typeof suggestion.documentId !== "string") continue;
		const target = studyDocumentById(docs, suggestion.documentId);
		if (!target) {
			problems.push(`suggestions[${i}]: no document with id "${suggestion.documentId}"`);
			continue;
		}
		if (suggestion.sectionId && !target.sections.some((section) => section.id === suggestion.sectionId)) {
			problems.push(`suggestions[${i}]: "${suggestion.documentId}" has no section "${suggestion.sectionId}"`);
		}
	}
	return problems;
}

export function editDocumentTool(ctx: DocumentToolContext): AgentTool<typeof editDocumentInput> {
	return {
		name: EDIT_DOCUMENT_TOOL,
		label: EDIT_DOCUMENT_TOOL,
		description:
			"Create or update one study document shown in the learner's reading pane. Omit documentId to edit the document the learner had open when this turn started (the root when none); pass documentId to edit a deeper document. Use `sections` to upsert by id (new sections need an id, heading, and body), `remove` to delete ids, `order` to set the full section order, `title` to name the document, and `related` to link related documents. Each section patch should also carry its 2–4 `suggestions` (deeper directions) and 1–3 `questions` (self-check question/answer pairs) whenever you write or substantially revise that section. Roadmap subtopic suggestions on a seeded chapter are always kept. " +
			"The first root edit must set the title. Section ids are permanent: choose a lowercase slug once and reuse it for revisions. Only change what the learner asked for; keep the rest of the document stable. " +
			"The result returns the target's current table of contents. Use read_document before a large rewrite or whenever the current text is not in your context, and list_documents to see the whole tree.",
		parameters: editDocumentInput,
		executionMode: "parallel",
		execute: serverExecute(EDIT_DOCUMENT_TOOL, editDocumentInput, (input) => withDocumentLock(ctx.chatId, async () => {
			const docs = ctx.chatStore.readDocuments(ctx.chatId);
			const id = targetId(ctx, input.documentId);
			const scoped = scopeProblem(ctx, id);
			if (scoped) return { ok: false, error: scoped } satisfies DocumentToolResult;
			if (ctx.scope?.sectionId) {
				const outside = (input.sections ?? []).find((patch) => patch.id !== ctx.scope!.sectionId);
				if (outside || input.remove || input.order || input.title !== undefined || input.related !== undefined) {
					return {
						ok: false,
						error: `This writer may only patch section "${ctx.scope.sectionId}" (no title, remove, order or related changes).`,
					} satisfies DocumentToolResult;
				}
			}
			const document = studyDocumentById(docs, id);
			if (!document && id !== STUDY_ROOT_DOCUMENT_ID) {
				return { ok: false, error: unknownDocument(id, docs) } satisfies DocumentToolResult;
			}
			if (input.related !== undefined) {
				const problems = relatedTargetProblems(docs, input.related);
				if (problems.length > 0) return { ok: false, error: problems.join("\n") } satisfies DocumentToolResult;
			}
			const sentSuggestions = (input.sections ?? []).flatMap((patch) => patch.suggestions ?? []);
			if (sentSuggestions.length > 0) {
				const problems = suggestionTargetProblems(docs, sentSuggestions);
				if (problems.length > 0) return { ok: false, error: problems.join("\n") } satisfies DocumentToolResult;
			}
			try {
				const next = applyStudyDocumentEdit(document ?? undefined, input);
				ctx.chatStore.saveDocument(ctx.chatId, next);
				// The pane's live update channel: a mid-turn write must reach
				// the reading pane without touching the client's streaming
				// message state (record-changed is ignored while a turn runs).
				emit("document-changed", { chatId: ctx.chatId, documentId: next.id });
				const changed = (input.sections ?? []).map((patch) => {
					const section = next.sections.find((s) => s.id === patch.id);
					return { id: patch.id, heading: section?.heading ?? patch.heading ?? patch.id };
				});
				if (changed.length > 0) ctx.onActivity?.(`Wrote ${changed.slice(0, 3).map((c) => c.heading).join(", ")}`);
				return {
					ok: true,
					documentId: next.id,
					revision: next.revision,
					title: next.title,
					toc: studyDocumentToc(next),
					changed,
				} satisfies DocumentToolResult;
			} catch (err) {
				if (err instanceof StudyDocumentError) {
					return { ok: false, error: err.message } satisfies DocumentToolResult;
				}
				throw err;
			}
		})),
	};
}

export function readDocumentTool(ctx: DocumentToolContext): AgentTool<typeof readDocumentInput> {
	return {
		name: READ_DOCUMENT_TOOL,
		label: READ_DOCUMENT_TOOL,
		description:
			"Read one study document — the title and ordered sections, including its deeper suggestions and related links. Omit documentId for the document the learner had open when this turn started. Optionally pass `sectionId` to read just one section. For the whole tree of documents, use list_documents.",
		parameters: readDocumentInput,
		executionMode: "parallel",
		execute: serverExecute(READ_DOCUMENT_TOOL, readDocumentInput, async ({ documentId, sectionId }) => {
			const docs = ctx.chatStore.readDocuments(ctx.chatId);
			const id = targetId(ctx, documentId);
			const document = studyDocumentById(docs, id);
			if (!document) return { ok: false, error: unknownDocument(id, docs) };
			const head = {
				ok: true,
				documentId: document.id,
				title: document.title,
				revision: document.revision,
				status: document.status ?? "ready",
				parent: document.parent ?? null,
				related: document.related ?? [],
			};
			if (sectionId !== undefined) {
				const section = document.sections.find((s) => s.id === sectionId);
				if (!section) {
					return {
						ok: false,
						error: `No section with id "${sectionId}" in "${document.title}". Current ids: ${document.sections.map((s) => s.id).join(", ")}`,
					};
				}
				return { ...head, sections: [section] };
			}
			return { ...head, sections: document.sections };
		}),
	};
}

export function suggestDeeperTool(ctx: DocumentToolContext): AgentTool<typeof suggestDeeperInput> {
	return {
		name: "suggest_deeper",
		label: "suggest_deeper",
		description:
			"Replace one chapter's deeper-topic directions: 2–4 directions that go one level deeper (a prerequisite, mechanism, consequence, comparison, or worked application), each with a short heading and one-line blurb. Do not write the child document here — the learner picks first. Point at an existing document when the topic is already written.",
		parameters: suggestDeeperInput,
		executionMode: "parallel",
		execute: serverExecute("suggest_deeper", suggestDeeperInput, (input) => withDocumentLock(ctx.chatId, async () => {
			const docs = ctx.chatStore.readDocuments(ctx.chatId);
			const id = targetId(ctx, input.documentId);
			const scoped = scopeProblem(ctx, id, input.sectionId);
			if (scoped) return { ok: false, error: scoped };
			const document = studyDocumentById(docs, id);
			if (!document) return { ok: false, error: unknownDocument(id, docs) };
			const problems = suggestionTargetProblems(docs, input.suggestions);
			if (problems.length > 0) return { ok: false, error: problems.join("\n") };
			try {
				const next = applyStudySuggestions(document, input.sectionId, input.suggestions);
				ctx.chatStore.saveDocument(ctx.chatId, next);
				emit("document-changed", { chatId: ctx.chatId, documentId: next.id });
				const section = next.sections.find((s) => s.id === input.sectionId);
				ctx.onActivity?.(`Directions · ${section?.heading ?? input.sectionId}`);
				return {
					ok: true,
					documentId: next.id,
					sectionId: input.sectionId,
					suggestions: section?.suggestions ?? [],
				};
			} catch (err) {
				if (err instanceof StudyDocumentError) return { ok: false, error: err.message };
				throw err;
			}
		})),
	};
}

export function describeSubtopicsTool(ctx: DocumentToolContext): AgentTool<typeof describeSubtopicsInput> {
	return {
		name: "describe_subtopics",
		label: "describe_subtopics",
		description:
			"Write or update the one-line overviews of roadmap subtopics in one main-topic chapter. After a roadmap seed, every subtopic already exists as a suggestion; this tool fills in what each one covers and why it matters without changing its id, title or roadmap pointer.",
		parameters: describeSubtopicsInput,
		executionMode: "parallel",
		execute: serverExecute("describe_subtopics", describeSubtopicsInput, (input) => withDocumentLock(ctx.chatId, async () => {
			const docs = ctx.chatStore.readDocuments(ctx.chatId);
			const id = targetId(ctx, input.documentId);
			const scoped = scopeProblem(ctx, id, input.sectionId);
			if (scoped) return { ok: false, error: scoped };
			const document = studyDocumentById(docs, id);
			if (!document) return { ok: false, error: unknownDocument(id, docs) };
			try {
				const next = applyStudySubtopicBlurbs(document, input.sectionId, input.subtopics);
				ctx.chatStore.saveDocument(ctx.chatId, next);
				emit("document-changed", { chatId: ctx.chatId, documentId: next.id });
				const section = next.sections.find((candidate) => candidate.id === input.sectionId);
				ctx.onActivity?.(`Subtopic overviews · ${section?.heading ?? input.sectionId} (${input.subtopics.length})`);
				return {
					ok: true,
					documentId: next.id,
					sectionId: input.sectionId,
					described: input.subtopics.length,
				};
			} catch (err) {
				if (err instanceof StudyDocumentError) return { ok: false, error: err.message };
				throw err;
			}
		})),
	};
}

export function addQuestionsTool(ctx: DocumentToolContext): AgentTool<typeof addQuestionsInput> {
	return {
		name: "add_questions",
		label: "add_questions",
		description:
			"Add new self-check questions (with model answers) to one chapter, keeping every existing question. Send only the new pairs with new ids; do not resend the old ones.",
		parameters: addQuestionsInput,
		executionMode: "parallel",
		execute: serverExecute("add_questions", addQuestionsInput, (input) => withDocumentLock(ctx.chatId, async () => {
			const docs = ctx.chatStore.readDocuments(ctx.chatId);
			const id = targetId(ctx, input.documentId);
			const scoped = scopeProblem(ctx, id, input.sectionId);
			if (scoped) return { ok: false, error: scoped };
			const document = studyDocumentById(docs, id);
			if (!document) return { ok: false, error: unknownDocument(id, docs) };
			try {
				const next = applyStudyQuestionsAppend(document, input.sectionId, input.questions);
				ctx.chatStore.saveDocument(ctx.chatId, next);
				emit("document-changed", { chatId: ctx.chatId, documentId: next.id });
				const section = next.sections.find((candidate) => candidate.id === input.sectionId);
				ctx.onActivity?.(`Self-check questions · ${section?.heading ?? input.sectionId}`);
				return {
					ok: true,
					documentId: next.id,
					sectionId: input.sectionId,
					questions: section?.questions?.length ?? 0,
				};
			} catch (err) {
				if (err instanceof StudyDocumentError) return { ok: false, error: err.message };
				throw err;
			}
		})),
	};
}

export function listDocumentsTool(ctx: DocumentToolContext): AgentTool<typeof listDocumentsInput> {
	return {
		name: "list_documents",
		label: "list_documents",
		description:
			"The whole deeper-document tree for this reading session: every document's id, title, status, parent chapter, section ids and headings, existing suggestion ids, and related links. Use it before suggesting deeper directions or adding cross-links; call read_document for one document's prose.",
		parameters: listDocumentsInput,
		executionMode: "parallel",
		execute: serverExecute("list_documents", listDocumentsInput, async () => {
			const docs = ctx.chatStore.readDocuments(ctx.chatId);
			return {
				ok: true,
				tree: studyDocumentTreeText(docs),
				documents: studyDocumentList(docs).map((doc) => ({
					id: doc.id,
					title: doc.title,
					status: doc.status ?? "ready",
					parent: doc.parent ?? null,
					sections: doc.sections.map((s) => ({ id: s.id, heading: s.heading })),
					related: doc.related ?? [],
				})),
			};
		}),
	};
}

/** The chat turn's full document tool set. */
export function documentTools(ctx: DocumentToolContext): Record<string, AgentTool<any>> {
	return {
		[EDIT_DOCUMENT_TOOL]: editDocumentTool(ctx),
		[READ_DOCUMENT_TOOL]: readDocumentTool(ctx),
		suggest_deeper: suggestDeeperTool(ctx),
		describe_subtopics: describeSubtopicsTool(ctx),
		add_questions: addQuestionsTool(ctx),
		list_documents: listDocumentsTool(ctx),
	};
}

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { ChatStore } from "../../core/ports.ts";
import type { ChatRecord, StudyRelatedLink, StudyTopicSuggestion } from "../../core/contracts/chat.ts";
import {
	EDIT_DOCUMENT_TOOL,
	READ_DOCUMENT_TOOL,
} from "../../core/contracts/chat.ts";
import {
	applyStudyDocumentEdit,
	applyStudySuggestions,
	StudyDocumentError,
	studyDocumentById,
	studyDocumentList,
	studyDocumentToc,
	studyDocumentTreeText,
	STUDY_BODY_MAX,
	STUDY_HEADING_MAX,
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
 * tree 2026-11-12).
 *
 * The living study document is an artifact of the SESSION RECORD, not a
 * transcript message: edit_document patches it through the ChatStore (the
 * only writer), and the open reading pane refetches on the document-changed
 * event. That split is what lets the documents survive compaction, reloads,
 * and a conversation that runs far longer than its own context window.
 *
 * Deeper documents form a tree on the same record. Every tool targets one
 * document by id; an omitted id means the document the learner is reading
 * (the record's readingDocumentId), falling back to the root. The learner's
 * clicks — "suggest deeper directions" and "write this child" — arrive as
 * hidden session markers, so the agent can tell an automatic expansion
 * from ordinary chat.
 *
 * The tools are SERVER-EXECUTED like plan_init: the model's raw arguments
 * stream to the client for the live "Writing the document…" card, then the
 * execute seam validates and persists. Validation failures return ok:false
 * (the plan_init pattern) so the model retries in the same turn.
 */

export interface DocumentToolContext {
	chatId: string;
	chatStore: ChatStore;
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
				"This chapter's 2–4 deeper directions, shown immediately in the reading pane. Include them whenever you write or substantially revise the section; omit on small edits to keep the existing directions. An empty array clears them.",
		}),
	),
	questions: Type.Optional(
		Type.Array(questionPatch, {
			maxItems: STUDY_QUESTIONS_MAX,
			description:
				"This chapter's 1–3 self-check questions and answers, hidden in a collapsed accordion. Include them whenever you write or substantially revise the section; omit on small edits. An empty array clears them.",
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
				"Target document id. Omit to edit the document the learner is currently reading (the root when none). A deeper document must already exist; this tool never invents ids.",
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
			description: "Target document id; omit for the document the learner is reading (the root when none).",
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
			description: "Target document id; omit for the document the learner is reading.",
		}),
	),
	sectionId: Type.String({
		description: "The chapter id the learner pressed 'Go deeper' on.",
	}),
	suggestions: Type.Array(topicSuggestion, {
		minItems: 1,
		maxItems: STUDY_SUGGESTIONS_MAX,
		description:
			"2–4 genuinely deeper directions. Each is a short heading plus one line of what it covers. Point at an existing document when the topic is already written.",
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

function resolveTarget(record: ChatRecord, documentId?: string): { id: string; document: ReturnType<typeof studyDocumentById> } {
	const id = documentId ?? record.readingDocumentId ?? STUDY_ROOT_DOCUMENT_ID;
	return { id, document: studyDocumentById(record, id) };
}

function unknownDocument(id: string, record: ChatRecord): string {
	const ids = studyDocumentList(record).map((doc) => doc.id);
	return ids.length > 0
		? `No study document with id "${id}". Current ids: ${ids.join(", ")}`
		: "No study document exists yet.";
}

/** Related targets must exist in this session; the pure engine owns format
 *  and self-link validation. */
function relatedTargetProblems(record: ChatRecord, links: readonly StudyRelatedLink[]): string[] {
	const problems: string[] = [];
	for (const [i, link] of links.entries()) {
		if (!link || typeof link.documentId !== "string") continue;
		const target = studyDocumentById(record, link.documentId);
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

function suggestionTargetProblems(record: ChatRecord, suggestions: readonly StudyTopicSuggestion[]): string[] {
	const problems: string[] = [];
	for (const [i, suggestion] of suggestions.entries()) {
		if (!suggestion || typeof suggestion.documentId !== "string") continue;
		const target = studyDocumentById(record, suggestion.documentId);
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
			"Create or update one study document shown in the learner's reading pane. Omit documentId to edit the document the learner is reading (the root when none); pass documentId to edit a deeper document. Use `sections` to upsert by id (new sections need an id, heading, and body), `remove` to delete ids, `order` to set the full section order, `title` to name the document, and `related` to link related documents. Each section patch should also carry its 2–4 `suggestions` (deeper directions) and 1–3 `questions` (self-check question/answer pairs) whenever you write or substantially revise that section — the learner sees the directions immediately and the questions in a collapsed accordion. " +
			"The first root edit must set the title. Section ids are permanent: choose a lowercase slug once and reuse it for revisions. Only change what the learner asked for; keep the rest of the document stable. " +
			"The result returns the target's current table of contents. Use read_document before a large rewrite or whenever the current text is not in your context, and list_documents to see the whole tree.",
		parameters: editDocumentInput,
		executionMode: "sequential",
		execute: serverExecute(EDIT_DOCUMENT_TOOL, editDocumentInput, async (input) => {
			const record = ctx.chatStore.getChat(ctx.chatId);
			if (!record) return { ok: false, error: `Chat not found: ${ctx.chatId}` } satisfies DocumentToolResult;
			const { id, document } = resolveTarget(record, input.documentId);
			if (!document && id !== STUDY_ROOT_DOCUMENT_ID) {
				return { ok: false, error: unknownDocument(id, record) } satisfies DocumentToolResult;
			}
			if (input.related !== undefined) {
				const problems = relatedTargetProblems(record, input.related);
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
		}),
	};
}

export function readDocumentTool(ctx: DocumentToolContext): AgentTool<typeof readDocumentInput> {
	return {
		name: READ_DOCUMENT_TOOL,
		label: READ_DOCUMENT_TOOL,
		description:
			"Read one study document — the title and ordered sections, including its deeper suggestions and related links. Omit documentId for the document the learner is reading. Optionally pass `sectionId` to read just one section. For the whole tree of documents, use list_documents.",
		parameters: readDocumentInput,
		executionMode: "sequential",
		execute: serverExecute(READ_DOCUMENT_TOOL, readDocumentInput, async ({ documentId, sectionId }) => {
			const record = ctx.chatStore.getChat(ctx.chatId);
			if (!record) return { ok: false, error: `Chat not found: ${ctx.chatId}` };
			const { id, document } = resolveTarget(record, documentId);
			if (!document) return { ok: false, error: unknownDocument(id, record) };
			if (sectionId !== undefined) {
				const section = document.sections.find((s) => s.id === sectionId);
				if (!section) {
					return {
						ok: false,
						error: `No section with id "${sectionId}" in "${document.title}". Current ids: ${document.sections.map((s) => s.id).join(", ")}`,
					};
				}
				return {
					ok: true,
					documentId: document.id,
					title: document.title,
					revision: document.revision,
					status: document.status ?? "ready",
					parent: document.parent ?? null,
					related: document.related ?? [],
					sections: [section],
				};
			}
			return {
				ok: true,
				documentId: document.id,
				title: document.title,
				revision: document.revision,
				status: document.status ?? "ready",
				parent: document.parent ?? null,
				related: document.related ?? [],
				sections: document.sections,
			};
		}),
	};
}

export function suggestDeeperTool(ctx: DocumentToolContext): AgentTool<typeof suggestDeeperInput> {
	return {
		name: "suggest_deeper",
		label: "suggest_deeper",
		description:
			"Store deeper-topic directions for one chapter of a study document. The learner pressed 'Go deeper' on that chapter; propose 2–4 directions that go one level deeper (a prerequisite, mechanism, consequence, comparison, or worked application), each with a short heading and one-line blurb. Do not write the child document here — the learner picks first. Point at an existing document when the topic is already written.",
		parameters: suggestDeeperInput,
		executionMode: "sequential",
		execute: serverExecute("suggest_deeper", suggestDeeperInput, async (input) => {
			const record = ctx.chatStore.getChat(ctx.chatId);
			if (!record) return { ok: false, error: `Chat not found: ${ctx.chatId}` };
			const { id, document } = resolveTarget(record, input.documentId);
			if (!document) return { ok: false, error: unknownDocument(id, record) };
			const problems = suggestionTargetProblems(record, input.suggestions);
			if (problems.length > 0) return { ok: false, error: problems.join("\n") };
			try {
				const next = applyStudySuggestions(document, input.sectionId, input.suggestions);
				ctx.chatStore.saveDocument(ctx.chatId, next);
				emit("document-changed", { chatId: ctx.chatId, documentId: next.id });
				const section = next.sections.find((s) => s.id === input.sectionId);
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
		}),
	};
}

export function listDocumentsTool(ctx: DocumentToolContext): AgentTool<typeof listDocumentsInput> {
	return {
		name: "list_documents",
		label: "list_documents",
		description:
			"The whole deeper-document tree for this reading session: every document's id, title, status, parent chapter, section ids and headings, existing suggestion ids, and related links. Use it before suggesting deeper directions or adding cross-links; call read_document for one document's prose.",
		parameters: listDocumentsInput,
		executionMode: "sequential",
		execute: serverExecute("list_documents", listDocumentsInput, async () => {
			const record = ctx.chatStore.getChat(ctx.chatId);
			if (!record) return { ok: false, error: `Chat not found: ${ctx.chatId}` };
			return {
				ok: true,
				tree: studyDocumentTreeText(record),
				documents: studyDocumentList(record).map((doc) => ({
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

export function documentTools(ctx: DocumentToolContext): Record<string, AgentTool<any>> {
	return {
		[EDIT_DOCUMENT_TOOL]: editDocumentTool(ctx),
		[READ_DOCUMENT_TOOL]: readDocumentTool(ctx),
		suggest_deeper: suggestDeeperTool(ctx),
		list_documents: listDocumentsTool(ctx),
	};
}

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { ChatStore } from "../../core/ports.ts";
import {
	EDIT_DOCUMENT_TOOL,
	READ_DOCUMENT_TOOL,
} from "../../core/contracts/chat.ts";
import {
	applyStudyDocumentEdit,
	StudyDocumentError,
	studyDocumentToc,
	STUDY_BODY_MAX,
	STUDY_HEADING_MAX,
	STUDY_SECTIONS_MAX,
	STUDY_TITLE_MAX,
} from "../../core/study-document.ts";
import { emit } from "../../core/events.ts";

/**
 * The READ agent's document tools (read sessions, owner 2026-11-04).
 *
 * The living study document is an artifact of the SESSION RECORD, not a
 * transcript message: edit_document patches it through the ChatStore (the
 * only writer), and the open reading pane refetches on the document-changed
 * event. That split is what lets the document survive compaction, reloads,
 * and a conversation that runs far longer than its own context window.
 *
 * Both tools are SERVER-EXECUTED like plan_init: the model's raw arguments
 * stream to the client for the live "Writing the document…" card, then the
 * execute seam validates and persists. Validation failures return ok:false
 * (the plan_init pattern) so the model retries in the same turn.
 */

export interface DocumentToolContext {
	chatId: string;
	chatStore: ChatStore;
}

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
});

export const editDocumentInput = Type.Object({
	title: Type.Optional(
		Type.String({
			maxLength: STUDY_TITLE_MAX,
			description: "Document title. Required on the first edit; omit to keep the current title.",
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
});

export const readDocumentInput = Type.Object({
	sectionId: Type.Optional(
		Type.String({
			description: "Read just this section by id; omit to read the whole document.",
		}),
	),
});

/** The slim result shared by both tools. `changed` is the UI's one-line
 *  "Document updated · …" descriptor; the model gets the TOC so it can
 *  reference ids exactly. */
interface DocumentToolResult {
	ok: boolean;
	error?: string;
	revision?: number;
	title?: string;
	toc?: Array<{ id: string; heading: string }>;
	changed?: Array<{ id: string; heading: string }>;
}

function documentOf(ctx: DocumentToolContext) {
	const record = ctx.chatStore.getChat(ctx.chatId);
	if (!record) return { record: null, error: `Chat not found: ${ctx.chatId}` };
	return { record, error: null };
}

export function editDocumentTool(ctx: DocumentToolContext): AgentTool<typeof editDocumentInput> {
	return {
		name: EDIT_DOCUMENT_TOOL,
		label: EDIT_DOCUMENT_TOOL,
		description:
			"Create or update the study document shown in the learner's reading pane. Use `sections` to upsert by id (new sections need an id, heading, and body), `remove` to delete ids, `order` to set the full section order, and `title` to name the document. " +
			"The first call must set the title. Section ids are permanent: choose a lowercase slug once and reuse it for revisions. Only change what the learner asked for; keep the rest of the document stable. " +
			"The result returns the current table of contents. Use read_document before a large rewrite or whenever the current text is not in your context.",
		parameters: editDocumentInput,
		executionMode: "sequential",
		execute: serverExecute(EDIT_DOCUMENT_TOOL, editDocumentInput, async (input) => {
			const { record, error } = documentOf(ctx);
			if (!record) return { ok: false, error } satisfies DocumentToolResult;
			try {
				const next = applyStudyDocumentEdit(record.document, input);
				ctx.chatStore.saveDocument(ctx.chatId, next);
				// The pane's live update channel: a mid-turn write must reach
				// the reading pane without touching the client's streaming
				// message state (record-changed is ignored while a turn runs).
				emit("document-changed", { chatId: ctx.chatId });
				const changed = (input.sections ?? []).map((patch) => {
					const section = next.sections.find((s) => s.id === patch.id);
					return { id: patch.id, heading: section?.heading ?? patch.heading ?? patch.id };
				});
				return {
					ok: true,
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
			"Read the current study document — the title and ordered sections — so you can revise it accurately. Optionally pass `sectionId` to read just one section. This is the reading pane's document, not a learner file; for files use read/ls/find/grep.",
		parameters: readDocumentInput,
		executionMode: "sequential",
		execute: serverExecute(READ_DOCUMENT_TOOL, readDocumentInput, async ({ sectionId }) => {
			const { record, error } = documentOf(ctx);
			if (!record) return { ok: false, error };
			const document = record.document;
			if (!document) return { ok: false, error: "No study document exists yet — create one with edit_document." };
			if (sectionId !== undefined) {
				const section = document.sections.find((s) => s.id === sectionId);
				if (!section) {
					return {
						ok: false,
						error: `No section with id "${sectionId}". Current ids: ${document.sections.map((s) => s.id).join(", ")}`,
					};
				}
				return {
					ok: true,
					title: document.title,
					revision: document.revision,
					sections: [section],
				};
			}
			return {
				ok: true,
				title: document.title,
				revision: document.revision,
				sections: document.sections,
			};
		}),
	};
}

export function documentTools(ctx: DocumentToolContext): Record<string, AgentTool<any>> {
	return {
		[EDIT_DOCUMENT_TOOL]: editDocumentTool(ctx),
		[READ_DOCUMENT_TOOL]: readDocumentTool(ctx),
	};
}

/**
 * The living study document (read sessions, owner 2026-11-04).
 *
 * The read agent authors ONE structured document per session: a title plus
 * ordered sections, each a heading and a markdown body. The document lives on
 * the ChatRecord (contracts/chat.ts StudyDocument) and is written ONLY by the
 * read agent's edit_document tool. This module is the pure patch engine that
 * sits between the tool's raw input and the store: validate, upsert by stable
 * section id, remove, reorder, bump the revision. Storage stays dumb; every
 * judgment about document shape is here, testable without IO.
 *
 * The section id is the identity anchor. Headings are labels and may change;
 * ids are chosen once, are never reused for different material, and let the
 * agent revise one section without restating the rest (the plan-tree slug
 * discipline applied to prose).
 */

import type {
	ChatRecord,
	StudyDocument,
	StudyDocumentStatus,
	StudyRelatedLink,
	StudySection,
	StudyTopicSuggestion,
} from "./contracts/chat.ts";

/** Stable section id: lowercase slug, same family as plan node ids. */
export const STUDY_SECTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The session's first document. Deeper documents are server-minted. */
export const STUDY_ROOT_DOCUMENT_ID = "root";
export const STUDY_DOCUMENT_ID_RE = /^(root|doc_[a-z0-9][a-z0-9_-]{0,63})$/;

export const STUDY_TITLE_MAX = 200;
export const STUDY_HEADING_MAX = 200;
export const STUDY_BODY_MAX = 100_000;
export const STUDY_SECTIONS_MAX = 100;
/** A whole-document ceiling: the guide is a reading artifact, not a corpus.
 *  Keeps the record, the page payload, and read_document outputs bounded. */
export const STUDY_TOTAL_MAX = 200_000;

/** The deeper tree's bounds. Recursion is intentional, but a session must
 *  stay a readable record rather than an unbounded corpus. */
export const STUDY_DOCUMENTS_MAX = 50;
export const STUDY_DEPTH_MAX = 6;
export const STUDY_SUGGESTIONS_MAX = 6;
export const STUDY_SUGGESTION_HEADING_MAX = 160;
export const STUDY_SUGGESTION_BLURB_MAX = 240;
export const STUDY_RELATED_MAX = 12;
export const STUDY_RELATED_REASON_MAX = 240;

/** One section patch. Existing sections update only the fields provided; a
 *  NEW section requires both heading and body. */
export interface StudySectionPatch {
	id: string;
	heading?: string;
	body?: string;
}

/** One edit_document call. At least one field must carry work. */
export interface StudyDocumentEdit {
	/** Rename the document (required on the first edit). */
	title?: string;
	/** Upsert sections by id (new ids append in patch order). */
	sections?: StudySectionPatch[];
	/** Delete existing sections by id. */
	remove?: string[];
	/** Set the complete section order — a permutation of the final ids. */
	order?: string[];
	/** Replace this document's cross-links (omit to keep them). */
	related?: StudyRelatedLink[];
}

/** Validation failure: the tool returns `problems` to the model for a retry. */
export class StudyDocumentError extends Error {
	constructor(public readonly problems: string[]) {
		super(problems.join("\n"));
		this.name = "StudyDocumentError";
	}
}

export function emptyStudyDocument(): StudyDocument {
	return { id: STUDY_ROOT_DOCUMENT_ID, title: "", sections: [], revision: 0, updatedAt: "" };
}

/** All documents in a session, root first. */
export function studyDocumentList(record: Pick<ChatRecord, "document" | "documents">): StudyDocument[] {
	const docs: StudyDocument[] = [];
	if (record.document) docs.push(record.document);
	for (const doc of record.documents ?? []) if (!docs.some((d) => d.id === doc.id)) docs.push(doc);
	return docs;
}

export function studyDocumentById(
	record: Pick<ChatRecord, "document" | "documents">,
	id: string,
): StudyDocument | null {
	if (!id) return null;
	if (id === STUDY_ROOT_DOCUMENT_ID) return record.document ?? null;
	return (record.documents ?? []).find((d) => d.id === id) ?? null;
}

export function studyDocumentStatus(doc: StudyDocument): StudyDocumentStatus {
	return doc.status ?? "ready";
}

export function studyDocumentToc(doc: StudyDocument | null | undefined): Array<{ id: string; heading: string }> {
	return (doc?.sections ?? []).map((s) => ({ id: s.id, heading: s.heading }));
}

/** Word count over section bodies (the pane's reading-time estimate). */
export function studyDocumentWordCount(doc: StudyDocument | null | undefined): number {
	if (!doc) return 0;
	return doc.sections.reduce((n, s) => n + (s.body.trim() ? s.body.trim().split(/\s+/).length : 0), 0);
}

/** The document as plain markdown — the copy/export shape. */
export function studyDocumentToMarkdown(doc: StudyDocument): string {
	const parts: string[] = [];
	if (doc.title.trim()) parts.push(`# ${doc.title.trim()}`);
	for (const section of doc.sections) {
		parts.push(`## ${section.heading}`);
		if (section.body.trim()) parts.push(section.body.trim());
	}
	return parts.join("\n\n");
}

export function studyDocumentChildren(
	record: Pick<ChatRecord, "document" | "documents">,
	documentId: string,
): StudyDocument[] {
	return studyDocumentList(record).filter((doc) => doc.parent?.documentId === documentId);
}

/** Root = 0; children increment. A missing/cyclic parent chain stops at the
 *  last resolvable document (never loops). */
export function studyDocumentDepth(
	record: Pick<ChatRecord, "document" | "documents">,
	documentId: string,
): number {
	let depth = 0;
	let current = studyDocumentById(record, documentId);
	const seen = new Set<string>();
	while (current?.parent && !seen.has(current.id)) {
		seen.add(current.id);
		const parent = studyDocumentById(record, current.parent.documentId);
		if (!parent) break;
		depth++;
		current = parent;
	}
	return depth;
}

export function studyDocumentBreadcrumb(
	record: Pick<ChatRecord, "document" | "documents">,
	documentId: string,
): StudyDocument[] {
	const chain: StudyDocument[] = [];
	let current = studyDocumentById(record, documentId);
	const seen = new Set<string>();
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		chain.unshift(current);
		current = current.parent ? studyDocumentById(record, current.parent.documentId) : null;
	}
	return chain;
}

/** The child generated from one chapter suggestion, if it exists. */
export function studyDocumentChildForTopic(
	record: Pick<ChatRecord, "document" | "documents">,
	documentId: string,
	sectionId: string,
	topicId: string,
): StudyDocument | null {
	return studyDocumentList(record).find((doc) =>
		doc.parent?.documentId === documentId &&
		doc.parent.sectionId === sectionId &&
		doc.parent.topicId === topicId,
	) ?? null;
}

export function studyDocumentTopic(
	doc: StudyDocument | null | undefined,
	sectionId: string,
	topicId: string,
): { section: StudySection; topic: StudyTopicSuggestion } | null {
	const section = doc?.sections.find((s) => s.id === sectionId);
	const topic = section?.suggestions?.find((t) => t.id === topicId);
	return section && topic ? { section, topic } : null;
}

/** The title + section list only (the compaction digest — the full text is
 *  in the record, and the agent can call read_document for it). */
export function studyDocumentOutline(doc: StudyDocument): string {
	const lines = [`Title: ${doc.title || "(untitled)"}`];
	if (doc.sections.length === 0) lines.push("Sections: none");
	else {
		lines.push("Sections:");
		for (const s of doc.sections) lines.push(`- ${s.heading} (${s.id})`);
	}
	return lines.join("\n");
}

/** The whole deeper tree (titles, section ids, suggestion ids, related
 *  links) — the read agent's map for suggestions and cross-links. Bodies
 *  stay out; the agent reads one with read_document. Deterministic. */
export function studyDocumentTreeText(record: Pick<ChatRecord, "document" | "documents">): string {
	const docs = studyDocumentList(record);
	const lines: string[] = ["Document tree:"];
	if (docs.length === 0) {
		lines.push("(no documents yet)");
		return lines.join("\n");
	}
	const visited = new Set<string>();
	const walk = (doc: StudyDocument, depth: number) => {
		if (visited.has(doc.id)) return;
		visited.add(doc.id);
		const pad = "  ".repeat(depth);
		const origin = doc.parent
			? ` — from ${doc.parent.documentId} § ${doc.parent.sectionId}, topic "${doc.parent.topicId}"`
			: "";
		lines.push(`${pad}- [${doc.id}] ${doc.title || "(untitled)"} (${studyDocumentStatus(doc)})${origin}`);
		if (doc.sections.length === 0) lines.push(`${pad}  Sections: none`);
		else {
			lines.push(`${pad}  Sections:`);
			for (const section of doc.sections) {
				const suggested = section.suggestions?.length
					? ` [deeper: ${section.suggestions.map((t) => `${t.id} (${t.heading})`).join("; ")}]`
					: "";
				lines.push(`${pad}  - ${section.heading} (${section.id})${suggested}`);
			}
		}
		if (doc.related?.length) {
			lines.push(`${pad}  Related: ${doc.related.map((l) => `${l.documentId}${l.sectionId ? ` § ${l.sectionId}` : ""} (${l.reason})`).join("; ")}`);
		}
		const children = studyDocumentChildren(record, doc.id);
		for (const child of children) walk(child, depth + 1);
	};
	const roots = docs.filter((doc) => !doc.parent || !studyDocumentById(record, doc.parent.documentId));
	for (const root of roots) walk(root, 0);
	// Orphans (a parent was removed) still appear, so nothing is invisible.
	for (const doc of docs) if (!visited.has(doc.id)) walk(doc, 0);
	return lines.join("\n");
}

/** Is another child allowed under this document? */
export function studyDocumentCanGoDeeper(
	record: Pick<ChatRecord, "document" | "documents">,
	documentId: string,
): boolean {
	return studyDocumentList(record).length < STUDY_DOCUMENTS_MAX &&
		studyDocumentDepth(record, documentId) < STUDY_DEPTH_MAX;
}

function validateHeading(value: string, label: string, problems: string[]): string | undefined {
	const heading = value.trim();
	if (!heading) problems.push(`${label}: heading must not be empty`);
	else if (heading.length > STUDY_HEADING_MAX) problems.push(`${label}: heading is longer than ${STUDY_HEADING_MAX} characters`);
	else return heading;
	return undefined;
}

function validateBody(value: string, label: string, problems: string[]): string | undefined {
	if (!value.trim()) problems.push(`${label}: body must not be empty`);
	else if (value.length > STUDY_BODY_MAX) problems.push(`${label}: body is longer than ${STUDY_BODY_MAX} characters`);
	else return value;
	return undefined;
}

function validateRelated(
	links: readonly StudyRelatedLink[],
	documentId: string,
	problems: string[],
): StudyRelatedLink[] {
	if (links.length > STUDY_RELATED_MAX) {
		problems.push(`related: ${links.length} links; the limit is ${STUDY_RELATED_MAX}`);
	}
	const out: StudyRelatedLink[] = [];
	const seen = new Set<string>();
	for (const [i, link] of links.entries()) {
		const label = `related[${i}]`;
		if (!link || typeof link !== "object") {
			problems.push(`${label}: must be an object`);
			continue;
		}
		if (typeof link.documentId !== "string" || !STUDY_DOCUMENT_ID_RE.test(link.documentId)) {
			problems.push(`${label}: invalid documentId "${String(link.documentId)}"`);
			continue;
		}
		if (link.sectionId !== undefined && (typeof link.sectionId !== "string" || !STUDY_SECTION_ID_RE.test(link.sectionId))) {
			problems.push(`${label}: invalid sectionId "${String(link.sectionId)}"`);
			continue;
		}
		if (link.documentId === documentId && (link.sectionId === undefined)) {
			problems.push(`${label}: a document cannot relate to itself`);
			continue;
		}
		const reason = typeof link.reason === "string" ? link.reason.trim() : "";
		if (!reason) {
			problems.push(`${label}: a one-line reason is required`);
			continue;
		}
		if (reason.length > STUDY_RELATED_REASON_MAX) {
			problems.push(`${label}: reason is longer than ${STUDY_RELATED_REASON_MAX} characters`);
			continue;
		}
		const key = `${link.documentId}\u0000${link.sectionId ?? ""}`;
		if (seen.has(key)) {
			problems.push(`${label}: duplicate link to ${link.documentId}${link.sectionId ? ` § ${link.sectionId}` : ""}`);
			continue;
		}
		seen.add(key);
		out.push({ documentId: link.documentId, ...(link.sectionId ? { sectionId: link.sectionId } : {}), reason });
	}
	return out;
}

/**
 * Apply one edit to a document. Pure: returns a NEW document, never mutates
 * the input. Throws StudyDocumentError with every problem found (the model
 * retries against the list). The first edit must carry a title.
 */
export function applyStudyDocumentEdit(
	current: StudyDocument | undefined,
	edit: StudyDocumentEdit,
	now = new Date(),
): StudyDocument {
	const problems: string[] = [];
	const currentSections = current?.sections ?? [];
	const documentId = current?.id ?? STUDY_ROOT_DOCUMENT_ID;

	const hasWork =
		edit.title !== undefined ||
		(edit.sections?.length ?? 0) > 0 ||
		(edit.remove?.length ?? 0) > 0 ||
		edit.order !== undefined ||
		edit.related !== undefined;
	if (!hasWork) problems.push("the edit carries nothing: provide title, sections, remove, order, or related");

	// Title first — the first write must name the document.
	let title = current?.title ?? "";
	if (edit.title !== undefined) {
		const next = edit.title.trim();
		if (!next) problems.push("title must not be empty");
		else if (next.length > STUDY_TITLE_MAX) problems.push(`title is longer than ${STUDY_TITLE_MAX} characters`);
		else title = next;
	}
	if (!current && !title) problems.push("the first edit needs a title");

	// Build the working map, preserving current order for untouched sections.
	const work: StudySection[] = currentSections.map((s) => ({ ...s }));
	const byId = new Map(work.map((s) => [s.id, s]));

	// Removals happen before upserts; patching a section in the same edit as
	// removing it is contradictory and rejected explicitly.
	const removed = new Set(edit.remove ?? []);
	if (removed.size > 0) {
		for (const id of removed) {
			if (!byId.has(id)) problems.push(`remove: no section with id "${id}"`);
		}
		for (const patch of edit.sections ?? []) {
			if (removed.has(patch.id)) problems.push(`sections: "${patch.id}" is both patched and removed`);
		}
	}
	for (const id of removed) {
		if (byId.has(id)) {
			byId.delete(id);
			const at = work.findIndex((s) => s.id === id);
			if (at >= 0) work.splice(at, 1);
		}
	}

	const patched = new Set<string>();
	for (const patch of edit.sections ?? []) {
		if (typeof patch.id !== "string" || !STUDY_SECTION_ID_RE.test(patch.id)) {
			problems.push(`sections: invalid id "${String(patch.id)}" — use a lowercase slug (a-z, 0-9, hyphens/underscores)`);
			continue;
		}
		if (patched.has(patch.id)) {
			problems.push(`sections: "${patch.id}" appears more than once in one edit`);
			continue;
		}
		patched.add(patch.id);
		const existing = byId.get(patch.id);
		if (existing) {
			if (patch.heading === undefined && patch.body === undefined) {
				problems.push(`sections: "${patch.id}" has neither heading nor body to update`);
				continue;
			}
			if (patch.heading !== undefined) {
				const heading = validateHeading(patch.heading, `sections["${patch.id}"]`, problems);
				if (heading !== undefined) existing.heading = heading;
			}
			if (patch.body !== undefined) {
				const body = validateBody(patch.body, `sections["${patch.id}"]`, problems);
				if (body !== undefined) existing.body = body;
			}
			continue;
		}
		// New section: both fields required, then append.
		const heading =
			patch.heading === undefined
				? (problems.push(`sections: new section "${patch.id}" needs a heading`), undefined)
				: validateHeading(patch.heading, `sections["${patch.id}"]`, problems);
		const body =
			patch.body === undefined
				? (problems.push(`sections: new section "${patch.id}" needs a body`), undefined)
				: validateBody(patch.body, `sections["${patch.id}"]`, problems);
		if (heading !== undefined && body !== undefined) {
			const section: StudySection = { id: patch.id, heading, body };
			byId.set(section.id, section);
			work.push(section);
		}
	}

	if (work.length > STUDY_SECTIONS_MAX) {
		problems.push(`the document has ${work.length} sections; the limit is ${STUDY_SECTIONS_MAX}`);
	}
	const totalChars = work.reduce((n, s) => n + s.heading.length + s.body.length, 0);
	if (totalChars > STUDY_TOTAL_MAX) {
		problems.push(
			`the document is too large (${totalChars} characters; the limit is ${STUDY_TOTAL_MAX}). Trim or split the material instead of exceeding it`,
		);
	}

	// The TOC needs distinct labels; duplicate headings make navigation lie.
	const seenHeadings = new Map<string, string>();
	for (const section of work) {
		const key = section.heading.trim().toLowerCase();
		const prior = seenHeadings.get(key);
		if (prior !== undefined) problems.push(`headings must be unique: "${section.heading}" is used by both "${prior}" and "${section.id}"`);
		else seenHeadings.set(key, section.id);
	}

	// Reorder only when asked; the permutation must name every final section.
	let ordered = work;
	if (edit.order !== undefined) {
		const ids = edit.order;
		const unique = new Set(ids);
		if (unique.size !== ids.length) problems.push("order: contains a duplicate id");
		for (const id of ids) if (!byId.has(id)) problems.push(`order: no section with id "${id}"`);
		for (const section of work) if (!unique.has(section.id)) problems.push(`order: missing section "${section.id}"`);
		if (problems.length === 0) {
			ordered = ids.map((id) => byId.get(id)!).map((s) => ({ ...s }));
		}
	}

	// Cross-links replace the whole list when provided. Targets are checked
	// against the session by the tool (this engine has one document).
	let related = current?.related;
	if (edit.related !== undefined) related = validateRelated(edit.related, documentId, problems);

	if (problems.length > 0) throw new StudyDocumentError(problems);

	const next: StudyDocument = {
		...current,
		id: documentId,
		title,
		sections: ordered,
		revision: (current?.revision ?? 0) + 1,
		updatedAt: now.toISOString(),
	};
	if (related && related.length > 0) next.related = related;
	else delete next.related;
	return next;
}

/** Normalize one suggestion list (shared by the engine and the child
 *  creator's topic lookup). Throws every problem at once. */
function validateSuggestions(
	suggestions: readonly StudyTopicSuggestion[],
	documentId: string,
	sectionId: string,
	problems: string[],
): StudyTopicSuggestion[] {
	if (suggestions.length === 0) problems.push("suggestions: at least one direction is required");
	if (suggestions.length > STUDY_SUGGESTIONS_MAX) {
		problems.push(`suggestions: ${suggestions.length} directions; the limit is ${STUDY_SUGGESTIONS_MAX}`);
	}
	const out: StudyTopicSuggestion[] = [];
	const seen = new Set<string>();
	for (const [i, suggestion] of suggestions.entries()) {
		const label = `suggestions[${i}]`;
		if (!suggestion || typeof suggestion !== "object") {
			problems.push(`${label}: must be an object`);
			continue;
		}
		if (typeof suggestion.id !== "string" || !STUDY_SECTION_ID_RE.test(suggestion.id)) {
			problems.push(`${label}: invalid id "${String(suggestion.id)}" — use a lowercase slug`);
			continue;
		}
		if (seen.has(suggestion.id)) {
			problems.push(`${label}: "${suggestion.id}" appears more than once`);
			continue;
		}
		seen.add(suggestion.id);
		const heading = typeof suggestion.heading === "string" ? suggestion.heading.trim() : "";
		if (!heading) problems.push(`${label}: heading must not be empty`);
		else if (heading.length > STUDY_SUGGESTION_HEADING_MAX) {
			problems.push(`${label}: heading is longer than ${STUDY_SUGGESTION_HEADING_MAX} characters`);
		}
		const blurb = typeof suggestion.blurb === "string" ? suggestion.blurb.trim() : "";
		if (!blurb) problems.push(`${label}: blurb must not be empty`);
		else if (blurb.length > STUDY_SUGGESTION_BLURB_MAX) {
			problems.push(`${label}: blurb is longer than ${STUDY_SUGGESTION_BLURB_MAX} characters`);
		}
		if (suggestion.documentId !== undefined) {
			if (!STUDY_DOCUMENT_ID_RE.test(suggestion.documentId)) problems.push(`${label}: invalid documentId "${suggestion.documentId}"`);
			if (suggestion.sectionId !== undefined && !STUDY_SECTION_ID_RE.test(suggestion.sectionId)) {
				problems.push(`${label}: invalid sectionId "${suggestion.sectionId}"`);
			}
			if (suggestion.documentId === documentId && suggestion.sectionId === sectionId) {
				problems.push(`${label}: points back at the chapter being read`);
			}
		} else if (suggestion.sectionId !== undefined) {
			problems.push(`${label}: sectionId requires documentId`);
		}
		if (heading && blurb) {
			out.push({
				id: suggestion.id,
				heading,
				blurb,
				...(suggestion.documentId ? { documentId: suggestion.documentId } : {}),
				...(suggestion.documentId && suggestion.sectionId ? { sectionId: suggestion.sectionId } : {}),
			});
		}
	}
	return out;
}

/** Replace one chapter's deeper directions. Pure; bumps the revision. */
export function applyStudySuggestions(
	current: StudyDocument,
	sectionId: string,
	suggestions: readonly StudyTopicSuggestion[],
	now = new Date(),
): StudyDocument {
	const problems: string[] = [];
	const section = current.sections.find((s) => s.id === sectionId);
	if (!section) {
		const ids = current.sections.map((s) => s.id).join(", ") || "(none)";
		throw new StudyDocumentError([`suggestions: no section with id "${sectionId}". Current ids: ${ids}`]);
	}
	const normalized = validateSuggestions(suggestions, current.id, sectionId, problems);
	if (problems.length > 0) throw new StudyDocumentError(problems);
	return {
		...current,
		sections: current.sections.map((s) => s.id === sectionId ? { ...s, suggestions: normalized } : s),
		revision: current.revision + 1,
		updatedAt: now.toISOString(),
	};
}

/** The pending child document created when the learner picks a suggestion.
 *  The server owns the id; the agent fills the sections in. Pure. */
export function createChildStudyDocument(
	record: Pick<ChatRecord, "document" | "documents">,
	parentDocumentId: string,
	sectionId: string,
	topicId: string,
	childId: string,
	now = new Date(),
): StudyDocument {
	const problems: string[] = [];
	const parent = studyDocumentById(record, parentDocumentId);
	if (!parent) problems.push(`no document with id "${parentDocumentId}"`);
	const found = parent ? studyDocumentTopic(parent, sectionId, topicId) : null;
	if (parent && !found) problems.push(`no suggestion "${topicId}" in section "${sectionId}" of "${parentDocumentId}"`);
	if (!STUDY_DOCUMENT_ID_RE.test(childId) || childId === STUDY_ROOT_DOCUMENT_ID) {
		problems.push(`invalid child document id "${childId}"`);
	}
	if (parent && !studyDocumentCanGoDeeper(record, parentDocumentId)) {
		problems.push(`the deeper tree is at its limit (${STUDY_DOCUMENTS_MAX} documents, ${STUDY_DEPTH_MAX} levels)`);
	}
	if (problems.length > 0) throw new StudyDocumentError(problems);
	return {
		id: childId,
		title: found!.topic.heading,
		sections: [],
		revision: 0,
		updatedAt: now.toISOString(),
		parent: { documentId: parentDocumentId, sectionId, topicId },
		status: "writing",
	};
}

/** Remove one related link. Pure; returns the same document when absent. */
export function removeStudyRelatedLink(
	current: StudyDocument,
	targetDocumentId: string,
	targetSectionId?: string,
	now = new Date(),
): StudyDocument {
	const remaining = (current.related ?? []).filter((link) =>
		!(link.documentId === targetDocumentId && (link.sectionId ?? undefined) === (targetSectionId ?? undefined)),
	);
	if (remaining.length === (current.related ?? []).length) return current;
	const next: StudyDocument = {
		...current,
		revision: current.revision + 1,
		updatedAt: now.toISOString(),
	};
	if (remaining.length > 0) next.related = remaining;
	else delete next.related;
	return next;
}

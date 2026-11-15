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
	StudyDocument,
	StudyDocumentSet,
	StudyDocumentStatus,
	StudyRelatedLink,
	StudySection,
	StudyRoadmapRef,
	StudySectionQuestion,
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
export const STUDY_DOCUMENTS_MAX = 500;
export const STUDY_DEPTH_MAX = 6;
/** Per-section ceiling. Roadmap seeds carry a topic's whole subtopic list
 *  (the largest imported topic has 103); agent-authored directions stay at
 *  2–4 by prompt doctrine, not by this bound. */
export const STUDY_SUGGESTIONS_MAX = 200;
export const STUDY_SUGGESTION_HEADING_MAX = 160;
export const STUDY_SUGGESTION_BLURB_MAX = 240;
export const STUDY_QUESTIONS_MAX = 20;
/** One "more questions" append adds at most this many. */
export const STUDY_QUESTIONS_APPEND_MAX = 5;
export const STUDY_QUESTION_MAX = 300;
export const STUDY_ANSWER_MAX = 4000;
export const STUDY_RELATED_MAX = 12;
export const STUDY_RELATED_REASON_MAX = 240;

/** One section patch. Existing sections update only the fields provided; a
 *  NEW section requires both heading and body. */
export interface StudySectionPatch {
	id: string;
	heading?: string;
	body?: string;
	/** Replace this section's deeper directions (empty clears them). */
	suggestions?: StudyTopicSuggestion[];
	/** Replace this section's self-check questions (empty clears them). */
	questions?: StudySectionQuestion[];
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
export function studyDocumentList(record: StudyDocumentSet): StudyDocument[] {
	const docs: StudyDocument[] = [];
	if (record.document) docs.push(record.document);
	for (const doc of record.documents ?? []) if (!docs.some((d) => d.id === doc.id)) docs.push(doc);
	return docs;
}

export function studyDocumentById(
	record: StudyDocumentSet,
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
	record: StudyDocumentSet,
	documentId: string,
): StudyDocument[] {
	return studyDocumentList(record).filter((doc) => doc.parent?.documentId === documentId);
}

/** Root = 0; children increment. A missing/cyclic parent chain stops at the
 *  last resolvable document (never loops). */
export function studyDocumentDepth(
	record: StudyDocumentSet,
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
	record: StudyDocumentSet,
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
	record: StudyDocumentSet,
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
export function studyDocumentTreeText(record: StudyDocumentSet): string {
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
					? ` [deeper: ${section.suggestions.map((t) => `${t.id} (${t.heading}${t.documentId ? ` → ${t.documentId}${t.sectionId ? ` § ${t.sectionId}` : ""}` : ""})`).join("; ")}]`
					: "";
				lines.push(`${pad}  - ${section.heading} (${section.id})${section.seed ? " [summary not written yet]" : ""}${suggested}`);
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
	record: StudyDocumentSet,
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
			if (patch.heading === undefined && patch.body === undefined && patch.suggestions === undefined && patch.questions === undefined) {
				problems.push(`sections: "${patch.id}" has no heading, body, suggestions or questions to update`);
				continue;
			}
			if (patch.heading !== undefined) {
				const heading = validateHeading(patch.heading, `sections["${patch.id}"]`, problems);
				if (heading !== undefined) existing.heading = heading;
			}
			if (patch.body !== undefined) {
				const body = validateBody(patch.body, `sections["${patch.id}"]`, problems);
				if (body !== undefined) {
					existing.body = body;
					// A written body is the summary: the section stops being a
					// lazy roadmap seed.
					delete existing.seed;
				}
			}
			if (patch.suggestions !== undefined) {
				const seeded = (existing.suggestions ?? []).filter((entry) => entry.roadmap !== undefined);
				if (seeded.length > 0) {
					// Imported roadmap subtopics are the section's structure and
					// can never be dropped by an edit: every seeded entry stays
					// (its roadmap pointer and heading intact; a re-sent blurb
					// updates it), and agent-authored directions are appended.
					const sent = new Map(patch.suggestions.filter((entry) => entry && typeof entry === "object").map((entry) => [entry.id, entry]));
					const kept = seeded.map((entry) => {
						const blurb = sent.get(entry.id)?.blurb;
						return typeof blurb === "string" && blurb.trim() ? { ...entry, blurb } : entry;
					});
					const keptIds = new Set(kept.map((entry) => entry.id));
					const added = patch.suggestions.filter((entry) => !entry || typeof entry !== "object" || !keptIds.has(entry.id));
					existing.suggestions = validateSuggestions([...kept, ...added], documentId, patch.id, problems);
				} else if (patch.suggestions.length === 0) delete existing.suggestions;
				else existing.suggestions = validateSuggestions(patch.suggestions, documentId, patch.id, problems);
			}
			if (patch.questions !== undefined) {
				if (patch.questions.length === 0) delete existing.questions;
				else existing.questions = validateQuestions(patch.questions, `sections["${patch.id}"].questions`, problems);
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
		const suggestions = patch.suggestions && patch.suggestions.length > 0
			? validateSuggestions(patch.suggestions, documentId, patch.id, problems)
			: undefined;
		const questions = patch.questions && patch.questions.length > 0
			? validateQuestions(patch.questions, `sections["${patch.id}"].questions`, problems)
			: undefined;
		if (heading !== undefined && body !== undefined) {
			const section: StudySection = {
				id: patch.id,
				heading,
				body,
				...(suggestions && suggestions.length > 0 ? { suggestions } : {}),
				...(questions && questions.length > 0 ? { questions } : {}),
			};
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
		let roadmap: StudyRoadmapRef | undefined;
		if (suggestion.roadmap !== undefined) {
			const ref = suggestion.roadmap;
			if (!ref || typeof ref !== "object" || typeof ref.slug !== "string" || !ref.slug || typeof ref.nodeId !== "string" || !ref.nodeId || (ref.kind !== "track" && ref.kind !== "topic" && ref.kind !== "subtopic")) {
				problems.push(`${label}: invalid roadmap reference`);
			} else {
				roadmap = { slug: ref.slug, nodeId: ref.nodeId, kind: ref.kind };
			}
		}
		if (heading && blurb) {
			out.push({
				id: suggestion.id,
				heading,
				blurb,
				...(suggestion.documentId ? { documentId: suggestion.documentId } : {}),
				...(suggestion.documentId && suggestion.sectionId ? { sectionId: suggestion.sectionId } : {}),
				...(roadmap ? { roadmap } : {}),
			});
		}
	}
	return out;
}

/** Validate a self-check question list. Empty is legal (clears the set).
 *  Unique ids keep the accordion keys stable across revisions. */
function validateQuestions(
	questions: readonly StudySectionQuestion[],
	label: string,
	problems: string[],
): StudySectionQuestion[] {
	if (questions.length > STUDY_QUESTIONS_MAX) {
		problems.push(`${label}: ${questions.length} questions; the limit is ${STUDY_QUESTIONS_MAX}`);
	}
	const out: StudySectionQuestion[] = [];
	const seen = new Set<string>();
	for (const [i, entry] of questions.entries()) {
		const at = `${label}[${i}]`;
		if (!entry || typeof entry !== "object") {
			problems.push(`${at}: must be an object`);
			continue;
		}
		if (typeof entry.id !== "string" || !STUDY_SECTION_ID_RE.test(entry.id)) {
			problems.push(`${at}: invalid id "${String(entry.id)}" — use a lowercase slug`);
			continue;
		}
		if (seen.has(entry.id)) {
			problems.push(`${at}: "${entry.id}" appears more than once`);
			continue;
		}
		seen.add(entry.id);
		const question = typeof entry.question === "string" ? entry.question.trim() : "";
		if (!question) problems.push(`${at}: question must not be empty`);
		else if (question.length > STUDY_QUESTION_MAX) problems.push(`${at}: question is longer than ${STUDY_QUESTION_MAX} characters`);
		const answer = typeof entry.answer === "string" ? entry.answer.trim() : "";
		if (!answer) problems.push(`${at}: answer must not be empty`);
		else if (answer.length > STUDY_ANSWER_MAX) problems.push(`${at}: answer is longer than ${STUDY_ANSWER_MAX} characters`);
		if (question && answer) out.push({ id: entry.id, question, answer });
	}
	return out;
}

/** One generated subtopic overview patch. The roadmap title/ref stays. */
export interface StudySubtopicBlurb {
	id: string;
	blurb: string;
}

/** Write the generated one-line overview of roadmap subtopics without
 *  touching their titles, ids or roadmap pointers. Batches merge by id, so
 *  parallel generation calls are safe. Pure; bumps the revision. */
export function applyStudySubtopicBlurbs(
	current: StudyDocument,
	sectionId: string,
	blurbs: readonly StudySubtopicBlurb[],
	now = new Date(),
): StudyDocument {
	const problems: string[] = [];
	const section = current.sections.find((s) => s.id === sectionId);
	if (!section) {
		const ids = current.sections.map((s) => s.id).join(", ") || "(none)";
		throw new StudyDocumentError([`subtopics: no section with id "${sectionId}". Current ids: ${ids}`]);
	}
	if (blurbs.length === 0) problems.push("subtopics: at least one overview is required");
	const known = new Set((section.suggestions ?? []).map((suggestion) => suggestion.id));
	const next = new Map<string, string>();
	for (const [i, entry] of blurbs.entries()) {
		const label = `subtopics[${i}]`;
		if (!entry || typeof entry !== "object") {
			problems.push(`${label}: must be an object`);
			continue;
		}
		if (typeof entry.id !== "string" || !known.has(entry.id)) {
			problems.push(`${label}: no roadmap subtopic with id "${String(entry.id)}" in "${sectionId}"`);
			continue;
		}
		if (next.has(entry.id)) {
			problems.push(`${label}: "${entry.id}" appears more than once`);
			continue;
		}
		const value = typeof entry.blurb === "string" ? entry.blurb.trim() : "";
		if (!value) problems.push(`${label}: blurb must not be empty`);
		else if (value.length > STUDY_SUGGESTION_BLURB_MAX) problems.push(`${label}: blurb is longer than ${STUDY_SUGGESTION_BLURB_MAX} characters`);
		else next.set(entry.id, value);
	}
	if (problems.length > 0) throw new StudyDocumentError(problems);
	return {
		...current,
		sections: current.sections.map((s) => s.id === sectionId
			? {
				...s,
				suggestions: (s.suggestions ?? []).map((suggestion) =>
					next.has(suggestion.id) ? { ...suggestion, blurb: next.get(suggestion.id)! } : suggestion,
				),
			}
			: s),
		revision: current.revision + 1,
		updatedAt: now.toISOString(),
	};
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
	// Roadmap subtopics are structure, not regenerable directions: a refresh
	// keeps them and replaces only the agent-authored ones.
	const seeded = (section.suggestions ?? []).filter((entry) => entry.roadmap !== undefined);
	const seededIds = new Set(seeded.map((entry) => entry.id));
	const normalized = validateSuggestions(
		[...seeded, ...suggestions.filter((entry) => !entry || typeof entry !== "object" || !seededIds.has(entry.id))],
		current.id,
		sectionId,
		problems,
	);
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
	record: StudyDocumentSet,
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

/** Append new self-check questions to one chapter, keeping every existing
 *  question (the "Generate more questions" path, 2026-11-15). The model
 *  sends only the new pairs; ids that already exist are rejected so a
 *  regenerated duplicate never silently overwrites an answer. Pure. */
export function applyStudyQuestionsAppend(
	current: StudyDocument,
	sectionId: string,
	questions: readonly StudySectionQuestion[],
	now = new Date(),
): StudyDocument {
	const problems: string[] = [];
	const section = current.sections.find((s) => s.id === sectionId);
	if (!section) {
		const ids = current.sections.map((s) => s.id).join(", ") || "(none)";
		throw new StudyDocumentError([`questions: no section with id "${sectionId}". Current ids: ${ids}`]);
	}
	if (questions.length === 0) problems.push("questions: at least one new question is required");
	if (questions.length > STUDY_QUESTIONS_APPEND_MAX) {
		problems.push(`questions: ${questions.length} new questions; add at most ${STUDY_QUESTIONS_APPEND_MAX} at a time`);
	}
	const existing = section.questions ?? [];
	const existingIds = new Set(existing.map((q) => q.id));
	for (const [i, entry] of questions.entries()) {
		if (entry && typeof entry === "object" && existingIds.has(entry.id)) {
			problems.push(`questions[${i}]: "${entry.id}" already exists in this chapter — choose a new id`);
		}
	}
	const added = validateQuestions(questions, "questions", problems);
	const merged = [...existing, ...added];
	if (merged.length > STUDY_QUESTIONS_MAX) {
		problems.push(`questions: the chapter would have ${merged.length} questions; the limit is ${STUDY_QUESTIONS_MAX}`);
	}
	if (problems.length > 0) throw new StudyDocumentError(problems);
	return {
		...current,
		sections: current.sections.map((s) => s.id === sectionId ? { ...s, questions: merged } : s),
		revision: current.revision + 1,
		updatedAt: now.toISOString(),
	};
}

/** Every problem a whole document has, by the same rules edits enforce
 *  (title, section ids/headings/bodies, unique headings, sizes, suggestion
 *  and question shapes). Seeds built outside the edit engine (roadmap
 *  imports) must pass this, or the first agent edit would be rejected for
 *  a problem the agent did not cause. Empty = valid. */
export function studyDocumentProblems(doc: StudyDocument): string[] {
	const problems: string[] = [];
	if (!STUDY_DOCUMENT_ID_RE.test(doc.id)) problems.push(`invalid document id "${doc.id}"`);
	const title = doc.title.trim();
	if (!title) problems.push("title must not be empty");
	else if (title.length > STUDY_TITLE_MAX) problems.push(`title is longer than ${STUDY_TITLE_MAX} characters`);
	if (doc.sections.length > STUDY_SECTIONS_MAX) problems.push(`the document has ${doc.sections.length} sections; the limit is ${STUDY_SECTIONS_MAX}`);
	const ids = new Set<string>();
	const headings = new Map<string, string>();
	let total = 0;
	for (const section of doc.sections) {
		const label = `sections["${section.id}"]`;
		if (!STUDY_SECTION_ID_RE.test(section.id)) problems.push(`${label}: invalid id`);
		if (ids.has(section.id)) problems.push(`${label}: duplicate id`);
		ids.add(section.id);
		const heading = validateHeading(section.heading, label, problems);
		if (heading !== undefined) {
			const key = heading.toLowerCase();
			const prior = headings.get(key);
			if (prior !== undefined) problems.push(`headings must be unique: "${heading}" is used by both "${prior}" and "${section.id}"`);
			else headings.set(key, section.id);
		}
		validateBody(section.body, label, problems);
		total += section.heading.length + section.body.length;
		if (section.suggestions && section.suggestions.length > 0) validateSuggestions(section.suggestions, doc.id, section.id, problems);
		if (section.questions && section.questions.length > 0) validateQuestions(section.questions, `${label}.questions`, problems);
	}
	if (total > STUDY_TOTAL_MAX) problems.push(`the document is too large (${total} characters; the limit is ${STUDY_TOTAL_MAX})`);
	return problems;
}

/** The pane's light projection of a document: structure, suggestions and
 *  question prompts without section bodies or model answers. The tree
 *  drawer, the graphs and the chapter cards need only this; the open
 *  document is fetched whole. */
export function studyDocumentSkeleton(doc: StudyDocument): StudyDocument {
	return {
		...doc,
		sections: doc.sections.map((section) => ({
			...section,
			body: "",
			...(section.questions ? { questions: section.questions.map((q) => ({ ...q, answer: "" })) } : {}),
		})),
	};
}

/** A roadmap subtopic's blurb before its overview is generated (the pane
 *  renders it muted; the opening's background writers replace it). */
export const STUDY_SUBTOPIC_PLACEHOLDER = "Overview not written yet.";

/** Is this roadmap subtopic still waiting for its generated overview? */
export function studySubtopicPending(suggestion: StudyTopicSuggestion): boolean {
	return suggestion.roadmap !== undefined && suggestion.blurb === STUDY_SUBTOPIC_PLACEHOLDER;
}

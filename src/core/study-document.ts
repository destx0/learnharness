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

import type { StudyDocument, StudySection } from "./contracts/chat.ts";

/** Stable section id: lowercase slug, same family as plan node ids. */
export const STUDY_SECTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const STUDY_TITLE_MAX = 200;
export const STUDY_HEADING_MAX = 200;
export const STUDY_BODY_MAX = 100_000;
export const STUDY_SECTIONS_MAX = 100;
/** A whole-document ceiling: the guide is a reading artifact, not a corpus.
 *  Keeps the record, the page payload, and read_document outputs bounded. */
export const STUDY_TOTAL_MAX = 200_000;

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
}

/** Validation failure: the tool returns `problems` to the model for a retry. */
export class StudyDocumentError extends Error {
	constructor(public readonly problems: string[]) {
		super(problems.join("\n"));
		this.name = "StudyDocumentError";
	}
}

export function emptyStudyDocument(): StudyDocument {
	return { title: "", sections: [], revision: 0, updatedAt: "" };
}

export function studyDocumentToc(doc: StudyDocument | null | undefined): Array<{ id: string; heading: string }> {
	return (doc?.sections ?? []).map((s) => ({ id: s.id, heading: s.heading }));
}

/** Word count over section bodies (the pane's reading-time estimate). */
export function studyDocumentWordCount(doc: StudyDocument | null | undefined): number {
	if (!doc) return 0;
	return doc.sections.reduce((n, s) => n + (s.body.trim() ? s.body.trim().split(/\s+/).length : 0), 0);
}

/** The document as plain markdown — the copy/export shape and the compact
 *  digest the read compaction prompt carries (title + TOC there). */
export function studyDocumentToMarkdown(doc: StudyDocument): string {
	const parts: string[] = [];
	if (doc.title.trim()) parts.push(`# ${doc.title.trim()}`);
	for (const section of doc.sections) {
		parts.push(`## ${section.heading}`);
		if (section.body.trim()) parts.push(section.body.trim());
	}
	return parts.join("\n\n");
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

	const hasWork =
		edit.title !== undefined ||
		(edit.sections?.length ?? 0) > 0 ||
		(edit.remove?.length ?? 0) > 0 ||
		edit.order !== undefined;
	if (!hasWork) problems.push("the edit carries nothing: provide title, sections, remove, or order");

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

	if (problems.length > 0) throw new StudyDocumentError(problems);

	return {
		title,
		sections: ordered,
		revision: (current?.revision ?? 0) + 1,
		updatedAt: now.toISOString(),
	};
}

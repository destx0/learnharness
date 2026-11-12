/**
 * THE LIVING STUDY DOCUMENT (read sessions, 2026-11-04): the pure patch
 * engine is the only place document shape is judged. These pins hold the
 * laws the edit_document tool relies on: first write needs a title, section
 * ids are stable, new sections need both fields, removals/reorders are
 * explicit, and the TOC cannot lie through duplicate headings.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	applyStudyDocumentEdit,
	StudyDocumentError,
	studyDocumentOutline,
	studyDocumentToc,
	studyDocumentToMarkdown,
	studyDocumentWordCount,
} from "../src/core/study-document.ts";
import type { StudyDocument } from "../src/core/contracts/chat.ts";

const NOW = new Date("2026-11-04T12:00:00.000Z");

function firstDoc(): StudyDocument {
	return applyStudyDocumentEdit(
		undefined,
		{
			title: "Linear algebra — a working overview",
			sections: [
				{ id: "overview", heading: "Overview", body: "Vectors are the nouns of the subject." },
				{ id: "maps", heading: "Linear maps", body: "A linear map preserves addition and scaling." },
			],
		},
		NOW,
	);
}

describe("applyStudyDocumentEdit — the first write", () => {
	it("creates the document with revision 1 and the requested order", () => {
		const doc = firstDoc();
		assert.equal(doc.title, "Linear algebra — a working overview");
		assert.equal(doc.revision, 1);
		assert.deepEqual(doc.sections.map((s) => s.id), ["overview", "maps"]);
		assert.equal(doc.updatedAt, NOW.toISOString());
	});

	it("refuses a first edit without a title", () => {
		assert.throws(
			() => applyStudyDocumentEdit(undefined, { sections: [{ id: "x", heading: "X", body: "Body" }] }),
			(err) => err instanceof StudyDocumentError && /first edit needs a title/.test(err.message),
		);
	});

	it("refuses an empty edit", () => {
		assert.throws(
			() => applyStudyDocumentEdit(firstDoc(), {}),
			(err) => err instanceof StudyDocumentError && /carries nothing/.test(err.message),
		);
	});
});

describe("applyStudyDocumentEdit — revision and upsert", () => {
	it("updates one section in place, keeps the other untouched, bumps revision", () => {
		const doc = firstDoc();
		const next = applyStudyDocumentEdit(
			doc,
			{ sections: [{ id: "maps", body: "A linear map is a structure-preserving function." }] },
			NOW,
		);
		assert.equal(next.revision, 2);
		assert.equal(next.sections[0]!.body, "Vectors are the nouns of the subject.");
		assert.equal(next.sections[1]!.heading, "Linear maps");
		assert.equal(next.sections[1]!.body, "A linear map is a structure-preserving function.");
	});

	it("appends new sections in patch order and requires heading + body", () => {
		const next = applyStudyDocumentEdit(
			firstDoc(),
			{
				sections: [
					{ id: "eigen", heading: "Eigenvectors", body: "Directions a map only scales." },
					{ id: "span", heading: "Span", body: "Everything a set of vectors can reach." },
				],
			},
			NOW,
		);
		assert.deepEqual(next.sections.map((s) => s.id), ["overview", "maps", "eigen", "span"]);

		assert.throws(
			() => applyStudyDocumentEdit(firstDoc(), { sections: [{ id: "half" }] }),
			(err) =>
				err instanceof StudyDocumentError &&
				/needs a heading/.test(err.message) &&
				/needs a body/.test(err.message),
		);
	});

	it("rejects duplicate ids and duplicate headings", () => {
		assert.throws(
			() =>
				applyStudyDocumentEdit(firstDoc(), {
					sections: [
						{ id: "overview", body: "One." },
						{ id: "overview", body: "Two." },
					],
				}),
			(err) => err instanceof StudyDocumentError && /more than once/.test(err.message),
		);
		assert.throws(
			() =>
				applyStudyDocumentEdit(firstDoc(), {
					sections: [{ id: "maps", heading: "Overview" }],
				}),
			(err) => err instanceof StudyDocumentError && /headings must be unique/.test(err.message),
		);
	});

	it("rejects an invalid section id", () => {
		assert.throws(
			() => applyStudyDocumentEdit(firstDoc(), { sections: [{ id: "Not A Slug", heading: "X", body: "Y" }] }),
			(err) => err instanceof StudyDocumentError && /invalid id/.test(err.message),
		);
	});
});

describe("applyStudyDocumentEdit — remove and reorder", () => {
	it("removes an existing section", () => {
		const next = applyStudyDocumentEdit(firstDoc(), { remove: ["maps"] }, NOW);
		assert.deepEqual(next.sections.map((s) => s.id), ["overview"]);
	});

	it("refuses unknown removals and patch+remove contradictions", () => {
		assert.throws(
			() => applyStudyDocumentEdit(firstDoc(), { remove: ["nope"] }),
			(err) => err instanceof StudyDocumentError && /no section with id "nope"/.test(err.message),
		);
		assert.throws(
			() => applyStudyDocumentEdit(firstDoc(), { remove: ["maps"], sections: [{ id: "maps", body: "x" }] }),
			(err) => err instanceof StudyDocumentError && /both patched and removed/.test(err.message),
		);
	});

	it("reorders only with a complete permutation", () => {
		const next = applyStudyDocumentEdit(firstDoc(), { order: ["maps", "overview"] }, NOW);
		assert.deepEqual(next.sections.map((s) => s.id), ["maps", "overview"]);

		assert.throws(
			() => applyStudyDocumentEdit(firstDoc(), { order: ["overview"] }),
			(err) => err instanceof StudyDocumentError && /missing section "maps"/.test(err.message),
		);
		assert.throws(
			() => applyStudyDocumentEdit(firstDoc(), { order: ["overview", "maps", "extra"] }),
			(err) => err instanceof StudyDocumentError && /no section with id "extra"/.test(err.message),
		);
	});
});

describe("study document projections", () => {
	it("TOC, markdown, outline and word count are deterministic", () => {
		const doc = firstDoc();
		assert.deepEqual(studyDocumentToc(doc), [
			{ id: "overview", heading: "Overview" },
			{ id: "maps", heading: "Linear maps" },
		]);
		assert.match(studyDocumentToMarkdown(doc), /^# Linear algebra/);
		assert.match(studyDocumentToMarkdown(doc), /## Linear maps\n\nA linear map preserves/);
		assert.match(studyDocumentOutline(doc), /Title: Linear algebra/);
		assert.match(studyDocumentOutline(doc), /- Linear maps \(maps\)/);
		assert.equal(studyDocumentWordCount(doc), 14);
	});
});

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
	applyStudySuggestions,
	createChildStudyDocument,
	removeStudyRelatedLink,
	StudyDocumentError,
	studyDocumentBreadcrumb,
	studyDocumentById,
	studyDocumentCanGoDeeper,
	studyDocumentChildForTopic,
	studyDocumentDepth,
	studyDocumentList,
	studyDocumentOutline,
	studyDocumentToc,
	studyDocumentToMarkdown,
	studyDocumentTreeText,
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


describe("deeper-document tree", () => {
	function withDirections(): StudyDocument {
		const doc = applyStudySuggestions(firstDoc(), "maps", [
			{ id: "eigen", heading: "Eigenvectors", blurb: "The directions a map leaves fixed." },
			{ id: "rank", heading: "Rank and nullity", blurb: "What a map destroys and keeps." },
		], NOW);
		return doc;
	}

	it("stores directions on a chapter and replaces them on refresh", () => {
		const doc = withDirections();
		assert.deepEqual(doc.sections.find((s) => s.id === "maps")?.suggestions?.map((t) => t.id), ["eigen", "rank"]);
		const again = applyStudySuggestions(doc, "maps", [
			{ id: "dual", heading: "Dual spaces", blurb: "Maps seen from the other side." },
		], NOW);
		assert.deepEqual(again.sections.find((s) => s.id === "maps")?.suggestions?.map((t) => t.id), ["dual"]);
		assert.throws(
			() => applyStudySuggestions(doc, "missing", [{ id: "x", heading: "X", blurb: "Y" }]),
			(err) => err instanceof StudyDocumentError && /no section with id "missing"/.test(err.message),
		);
		assert.throws(
			() => applyStudySuggestions(doc, "maps", [{ id: "x", heading: "X", blurb: "" }]),
			(err) => err instanceof StudyDocumentError && /blurb must not be empty/.test(err.message),
		);
	});

	it("creates a pending child with a parent link and finds it by topic", () => {
		const root = withDirections();
		const child = createChildStudyDocument(
			{ document: root, documents: [] },
			"root",
			"maps",
			"eigen",
			"doc_eigen",
			NOW,
		);
		assert.equal(child.id, "doc_eigen");
		assert.equal(child.title, "Eigenvectors");
		assert.equal(child.status, "writing");
		assert.deepEqual(child.parent, { documentId: "root", sectionId: "maps", topicId: "eigen" });
		const record = { document: root, documents: [child] };
		assert.equal(studyDocumentList(record).length, 2);
		assert.equal(studyDocumentById(record, "doc_eigen")?.title, "Eigenvectors");
		assert.equal(studyDocumentChildForTopic(record, "root", "maps", "eigen")?.id, "doc_eigen");
		assert.equal(studyDocumentDepth(record, "doc_eigen"), 1);
		assert.deepEqual(studyDocumentBreadcrumb(record, "doc_eigen").map((d) => d.id), ["root", "doc_eigen"]);
		assert.equal(studyDocumentCanGoDeeper(record, "doc_eigen"), true);
		assert.match(studyDocumentTreeText(record), /\[doc_eigen\] Eigenvectors \(writing\)/);
		assert.match(studyDocumentTreeText(record), /eigen \(Eigenvectors\)/);
	});

	it("refuses a child for an unknown topic or an exhausted depth", () => {
		const root = withDirections();
		assert.throws(
			() => createChildStudyDocument({ document: root, documents: [] }, "root", "maps", "nope", "doc_x", NOW),
			(err) => err instanceof StudyDocumentError && /no suggestion "nope"/.test(err.message),
		);
		// Build the maximum chain: each child gets a chapter, a direction,
		// then one child.
		let current: StudyDocument = root;
		let rootDoc: StudyDocument = root;
		const documents: StudyDocument[] = [];
		for (let depth = 0; depth < 6; depth++) {
			current = applyStudySuggestions(current, "overview", [
				{ id: `next-${depth}`, heading: `Deeper ${depth}`, blurb: "Next." },
			], NOW);
			if (current.id === "root") rootDoc = current;
			else {
				const at = documents.findIndex((doc) => doc.id === current.id);
				if (at >= 0) documents[at] = current;
			}
			const child = createChildStudyDocument(
				{ document: rootDoc, documents },
				current.id,
				"overview",
				`next-${depth}`,
				`doc_d${depth}`,
				NOW,
			);
			documents.push(child);
			current = applyStudyDocumentEdit(child, {
				sections: [{ id: "overview", heading: "Overview", body: "A chapter." }],
			}, NOW);
			const childAt = documents.findIndex((doc) => doc.id === current.id);
			if (childAt >= 0) documents[childAt] = current;
		}
		assert.equal(studyDocumentDepth({ document: rootDoc, documents }, "doc_d5"), 6);
		assert.equal(studyDocumentCanGoDeeper({ document: rootDoc, documents }, "doc_d5"), false);
		assert.throws(
			() => createChildStudyDocument({ document: rootDoc, documents }, "doc_d5", "overview", "next", "doc_more", NOW),
			(err) => err instanceof StudyDocumentError && /limit/.test(err.message),
		);
	});

	it("stores and removes related links", () => {
		const root = withDirections();
		const edited = applyStudyDocumentEdit(root, {
			related: [{ documentId: "doc_eigen", sectionId: "idea", reason: "Same geometry, other direction." }],
		}, NOW);
		assert.equal(edited.related?.length, 1);
		assert.throws(
			() => applyStudyDocumentEdit(root, { related: [{ documentId: "root", reason: "Self." }] }, NOW),
			(err) => err instanceof StudyDocumentError && /cannot relate to itself/.test(err.message),
		);
		const removed = removeStudyRelatedLink(edited, "doc_eigen", "idea", NOW);
		assert.equal(removed.related, undefined);
		assert.equal(removeStudyRelatedLink(removed, "doc_eigen", "idea"), removed);
	});
});


describe("authoring directions and self-check questions with a section", () => {
	it("stores suggestions and questions on a new section", () => {
		const doc = applyStudyDocumentEdit(undefined, {
			title: "Linear algebra",
			sections: [{
				id: "maps",
				heading: "Linear maps",
				body: "A map preserves structure.",
				suggestions: [{ id: "eigen", heading: "Eigenvectors", blurb: "Fixed directions." }],
				questions: [
					{ id: "q1", question: "What is preserved by a linear map?", answer: "Addition and scaling." },
					{ id: "q2", question: "Why is the zero vector special?", answer: "Every linear map sends it to zero." },
				],
			}],
		}, NOW);
		const section = doc.sections[0]!;
		assert.equal(section.suggestions?.[0]?.id, "eigen");
		assert.deepEqual(section.questions?.map((q) => q.id), ["q1", "q2"]);
	});

	it("replaces only what the patch names, and clears with an empty list", () => {
		const doc = applyStudyDocumentEdit(undefined, {
			title: "Linear algebra",
			sections: [{
				id: "maps",
				heading: "Linear maps",
				body: "A map preserves structure.",
				suggestions: [{ id: "eigen", heading: "Eigenvectors", blurb: "Fixed directions." }],
				questions: [{ id: "q1", question: "What is preserved?", answer: "Addition and scaling." }],
			}],
		}, NOW);
		const questionsOnly = applyStudyDocumentEdit(doc, {
			sections: [{
				id: "maps",
				questions: [{ id: "q2", question: "What is the kernel?", answer: "The vectors sent to zero." }],
			}],
		}, NOW);
		assert.equal(questionsOnly.sections[0]?.body, "A map preserves structure.");
		assert.equal(questionsOnly.sections[0]?.suggestions?.[0]?.id, "eigen");
		assert.deepEqual(questionsOnly.sections[0]?.questions?.map((q) => q.id), ["q2"]);
		const cleared = applyStudyDocumentEdit(questionsOnly, {
			sections: [{ id: "maps", questions: [], suggestions: [] }],
		}, NOW);
		assert.equal(cleared.sections[0]?.questions, undefined);
		assert.equal(cleared.sections[0]?.suggestions, undefined);
	});

	it("rejects duplicate or empty questions without writing", () => {
		const doc = firstDoc();
		assert.throws(
			() => applyStudyDocumentEdit(doc, {
				sections: [{
					id: "maps",
					questions: [
						{ id: "q", question: "One?", answer: "One." },
						{ id: "q", question: "Two?", answer: "Two." },
					],
				}],
			}, NOW),
			(err) => err instanceof StudyDocumentError && /appears more than once/.test(err.message),
		);
		assert.throws(
			() => applyStudyDocumentEdit(doc, {
				sections: [{ id: "maps", questions: [{ id: "q", question: "", answer: "A." }] }],
			}, NOW),
			(err) => err instanceof StudyDocumentError && /question must not be empty/.test(err.message),
		);
	});
});

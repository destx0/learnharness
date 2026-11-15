/**
 * READ CHAT INPUTS (2026-11-12; clicks moved to background writers
 * 2026-11-15). Ordinary chat carries the document the learner is reading
 * as a hidden context marker, re-added when the open document changes.
 * The click events (suggest/go deeper, more questions) are no longer chat
 * inputs — they queue background writers — so the parser refuses them.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inputAppends, parseChatInput, ChatInputError } from "../src/core/input-events.ts";
import {
	applyStudyDocumentEdit,
	applyStudySuggestions,
	createChildStudyDocument,
} from "../src/core/study-document.ts";
import type { ChatRecord } from "../src/core/contracts/chat.ts";
import type { LhMarkerMessage } from "../src/core/native-messages.ts";

const NOW = "2026-11-12T12:00:00.000Z";

function record(): ChatRecord {
	const root = applyStudySuggestions(
		applyStudyDocumentEdit(undefined, {
			title: "Linear algebra",
			sections: [{ id: "maps", heading: "Linear maps", body: "Maps preserve structure." }],
		}, new Date(NOW)),
		"maps",
		[{ id: "eigen", heading: "Eigenvectors", blurb: "Directions a map leaves fixed." }],
		new Date(NOW),
	);
	const child = createChildStudyDocument(
		{ document: root, documents: [] },
		"root",
		"maps",
		"eigen",
		"doc_eigen",
		new Date(NOW),
	);
	return {
		id: "c_read",
		title: "Linear algebra",
		createdAt: NOW,
		updatedAt: NOW,
		messages: [],
		kind: "read",
		document: root,
		documents: [child],
		readingDocumentId: "root",
	};
}

describe("read click events are not chat inputs", () => {
	it("refuses the removed click input types", () => {
		for (const type of ["suggest-deeper", "go-deeper", "more-questions"]) {
			assert.throws(() => parseChatInput({ type, documentId: "root", sectionId: "maps", topicId: "eigen", childDocumentId: "doc_eigen" }), ChatInputError);
		}
	});
});

describe("read chat context", () => {
	it("prepends the active-document context once for ordinary chat", () => {
		const rec = record();
		const appends = inputAppends(rec, { type: "text", text: "Continue this." });
		assert.equal(appends.length, 2);
		assert.equal(appends[0]?.role, "custom");
		assert.equal(appends[0]?.customType, "read-context");
		assert.match(appends[0]?.content ?? "", /\(root\)/);
		assert.equal(appends[1]?.role, "user");
		// A second message while the same document is open does not repeat it.
		const after = { ...rec, messages: [...rec.messages, ...appends] };
		const again = inputAppends(after, { type: "text", text: "And again." });
		assert.equal(again.length, 1);
		assert.equal(again[0]?.role, "user");
	});

	it("marks a roadmap-seeded root in the active-document context", () => {
		const rec = record();
		rec.document!.sections[0]!.suggestions![0]!.roadmap = { slug: "angular", nodeId: "subtopic:maps:eigen", kind: "subtopic" };
		const appends = inputAppends(rec, { type: "text", text: "Angular" });
		const context = appends[0] as LhMarkerMessage | undefined;
		assert.match(context?.content ?? "", /seeded from a roadmap/);
		assert.match(context?.content ?? "", /background writers/);
	});

	it("re-adds the context after switching documents", () => {
		const rec = record();
		const first = inputAppends(rec, { type: "text", text: "Start." });
		const after = { ...rec, messages: [...rec.messages, ...first], readingDocumentId: "doc_eigen" };
		const appends = inputAppends(after, { type: "text", text: "Now here." });
		const context = appends[0] as LhMarkerMessage | undefined;
		assert.equal(context?.customType, "read-context");
		assert.match(context?.content ?? "", /\(doc_eigen\)/);
	});
});

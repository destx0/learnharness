/**
 * READ DEEPER INPUTS (2026-11-12): the learner's clicks are hidden session
 * markers, not chat speech. These pins hold the contract the read pane and
 * the read prompt rely on: "suggest deeper" names a real chapter, "go
 * deeper" names a real suggestion and its pending child, and ordinary chat
 * carries the document the learner is reading.
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

describe("read deeper input parsing", () => {
	it("accepts the two click events and rejects missing ids", () => {
		assert.deepEqual(parseChatInput({ type: "suggest-deeper", documentId: "root", sectionId: "maps" }), {
			type: "suggest-deeper",
			documentId: "root",
			sectionId: "maps",
		});
		assert.deepEqual(parseChatInput({
			type: "go-deeper",
			documentId: "root",
			sectionId: "maps",
			topicId: "eigen",
			childDocumentId: "doc_eigen",
		}), {
			type: "go-deeper",
			documentId: "root",
			sectionId: "maps",
			topicId: "eigen",
			childDocumentId: "doc_eigen",
		});
		assert.throws(() => parseChatInput({ type: "suggest-deeper", documentId: "root" }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "go-deeper", documentId: "root", sectionId: "maps", topicId: "eigen" }), ChatInputError);
	});
});

describe("read deeper input appends", () => {
	it("writes a hidden suggest marker naming the chapter", () => {
		const [marker] = inputAppends(record(), { type: "suggest-deeper", documentId: "root", sectionId: "maps" }) as [LhMarkerMessage | undefined];
		assert.equal(marker?.role, "custom");
		assert.equal(marker?.customType, "read-suggest");
		assert.equal(marker?.display, false);
		assert.match(marker?.content ?? "", /Linear maps/);
		assert.match(marker?.content ?? "", /suggest_deeper/);
		assert.doesNotMatch(marker?.content ?? "", /write a child document now/i);
	});

	it("writes a hidden deeper marker naming the pending child", () => {
		const [marker] = inputAppends(record(), {
			type: "go-deeper",
			documentId: "root",
			sectionId: "maps",
			topicId: "eigen",
			childDocumentId: "doc_eigen",
		}) as [LhMarkerMessage | undefined];
		assert.equal(marker?.customType, "read-deeper");
		assert.equal(marker?.display, false);
		assert.match(marker?.content ?? "", /Eigenvectors/);
		assert.match(marker?.content ?? "", /documentId="doc_eigen"/);
	});

	it("refuses a suggestion that does not exist or a mismatched child", () => {
		assert.throws(
			() => inputAppends(record(), { type: "suggest-deeper", documentId: "root", sectionId: "nope" }),
			(err) => err instanceof ChatInputError && /targets no chapter/.test(err.message),
		);
		assert.throws(
			() => inputAppends(record(), {
				type: "go-deeper",
				documentId: "root",
				sectionId: "maps",
				topicId: "eigen",
				childDocumentId: "doc_other",
			}),
			(err) => err instanceof ChatInputError && /pending child/.test(err.message),
		);
	});

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

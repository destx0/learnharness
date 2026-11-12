import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ReadDocumentView, documentWriteInFlight, readMinutes } from "../components/read-pane.tsx";
import type { StudyDocument } from "../src/core/contracts.ts";

/**
 * THE READING PANE (read sessions, 2026-11-04): the pure reading surface —
 * title, TOC, section prose, empty/writing states — and the live-write
 * predicate that drives the header's "Writing…" line.
 */

const DOC: StudyDocument = {
	title: "Linear algebra — a working overview",
	sections: [
		{ id: "overview", heading: "Overview", body: "Vectors are the **nouns** of the subject." },
		{ id: "maps", heading: "Linear maps", body: "A map preserves addition and scaling." },
	],
	revision: 3,
	updatedAt: "2026-11-04T12:00:00.000Z",
};

function render(doc: StudyDocument | null, writing = false) {
	return renderToStaticMarkup(
		<ReadDocumentView
			document={doc}
			sessionTitle="Linear algebra"
			writing={writing}
			onClose={() => {}}
		/>,
	);
}

describe("ReadDocumentView — the reading surface", () => {
	it("renders the title, TOC, sections and the reading estimate", () => {
		const html = render(DOC);
		assert.ok(html.includes('data-testid="read-pane"'));
		assert.ok(html.includes("Linear algebra — a working overview"));
		assert.ok(html.includes('data-testid="read-pane-toc"'));
		assert.ok(html.includes(">Overview<"));
		assert.ok(html.includes(">Linear maps<"));
		assert.ok(html.includes("Vectors are the"));
		assert.ok(html.includes("A map preserves addition and scaling."));
		assert.ok(html.includes("2 sections"));
		assert.ok(html.includes('data-testid="read-pane-close"'));
	});

	it("falls back to the session title before the agent names the document", () => {
		const html = render({ ...DOC, title: "" });
		assert.ok(html.includes("Linear algebra"));
	});

	it("shows the preparing state while the first write streams", () => {
		const html = render(null, true);
		assert.ok(html.includes('data-testid="read-pane-empty"'));
		assert.ok(html.includes("Preparing your guide…"));
		assert.ok(html.includes("writing the first summary"));
	});

	it("shows the quiet empty state when no write is running", () => {
		const html = render(null, false);
		assert.ok(html.includes("No document yet"));
		assert.ok(html.includes("The guide will appear here"));
	});
});

describe("documentWriteInFlight — the live-write predicate", () => {
	it("is true only while the newest assistant message carries a streaming edit_document part", () => {
		assert.equal(
			documentWriteInFlight([
				{ role: "assistant", parts: [{ type: "tool-edit_document", state: "input-streaming" }] },
			]),
			true,
		);
		assert.equal(
			documentWriteInFlight([
				{ role: "assistant", parts: [{ type: "tool-edit_document", state: "output-available" }] },
			]),
			false,
		);
	});

	it("ignores a dangling streaming part in an older assistant message", () => {
		assert.equal(
			documentWriteInFlight([
				{ role: "assistant", parts: [{ type: "tool-edit_document", state: "input-streaming" }] },
				{ role: "assistant", parts: [{ type: "text" }] },
			]),
			false,
		);
	});
});

describe("readMinutes", () => {
	it("never reports less than a minute", () => {
		assert.equal(readMinutes(0), 1);
		assert.equal(readMinutes(220), 1);
		assert.equal(readMinutes(440), 2);
	});
});

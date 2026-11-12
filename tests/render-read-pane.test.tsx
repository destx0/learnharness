import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ReadDocumentView, documentWriteInFlight, readMinutes } from "../components/read-pane.tsx";
import type { StudyDocument } from "../src/core/contracts.ts";

/**
 * THE READING PANE (read sessions, 2026-11-04; deeper tree 2026-11-12):
 * the pure reading surface — header, breadcrumb, tree drawer, section prose,
 * inline deeper directions, related links, the graph toggle, and the
 * empty/writing/failed states.
 */

const ROOT: StudyDocument = {
	id: "root",
	title: "Linear algebra — a working overview",
	sections: [
		{
			id: "overview",
			heading: "Overview",
			body: "Vectors are the **nouns** of the subject.",
			suggestions: [
				{ id: "why", heading: "Why vectors?", blurb: "The geometry behind the abstraction." },
			],
		},
		{ id: "maps", heading: "Linear maps", body: "A map preserves addition and scaling." },
	],
	revision: 3,
	updatedAt: "2026-11-04T12:00:00.000Z",
};

const CHILD: StudyDocument = {
	id: "doc_child",
	title: "Eigenvectors",
	sections: [{ id: "idea", heading: "The idea", body: "A vector that only scales." }],
	revision: 1,
	updatedAt: "2026-11-12T12:00:00.000Z",
	parent: { documentId: "root", sectionId: "maps", topicId: "eigen" },
	status: "ready",
	related: [{ documentId: "root", sectionId: "overview", reason: "The overview sets up the notation." }],
};

function render(
	documents: StudyDocument[],
	activeDocumentId = "root",
	extra: Partial<React.ComponentProps<typeof ReadDocumentView>> = {},
) {
	return renderToStaticMarkup(
		<ReadDocumentView
			documents={documents}
			activeDocumentId={activeDocumentId}
			sessionTitle="Linear algebra"
			{...extra}
		/>,
	);
}

describe("ReadDocumentView — the reading surface", () => {
	it("renders the title, chapter prose, deeper affordance and reading estimate", () => {
		const html = render([ROOT]);
		assert.ok(html.includes('data-testid="read-pane"'));
		assert.ok(html.includes("Linear algebra — a working overview"));
		assert.ok(html.includes(">Overview<"));
		assert.ok(html.includes(">Linear maps<"));
		assert.ok(html.includes("Vectors are the"));
		assert.ok(html.includes("A map preserves addition and scaling."));
		assert.ok(html.includes("2 sections"));
		assert.ok(html.includes("Suggest deeper topics"));
		assert.ok(html.includes(">Why vectors?<"));
		assert.ok(html.includes("Go deeper"));
		// The document is the main view: no close affordance unless the host
		// explicitly asks for one.
		assert.equal(html.includes('data-testid="read-pane-close"'), false);
		assert.ok(render([ROOT], "root", { onClose: () => {} }).includes('data-testid="read-pane-close"'));
	});

	it("falls back to the session title before the agent names the document", () => {
		const html = render([{ ...ROOT, title: "" }]);
		assert.ok(html.includes("Linear algebra"));
	});

	it("shows the preparing state while the first write streams", () => {
		const html = render([], "root", { writing: true });
		assert.ok(html.includes('data-testid="read-pane-empty"'));
		assert.ok(html.includes("Preparing your topic…"));
		assert.ok(html.includes("writing the first summary") === false);
	});

	it("shows the quiet empty state when no write is running", () => {
		const html = render([]);
		assert.ok(html.includes("No document yet"));
		assert.ok(html.includes("The guide will appear here"));
	});

	it("renders a child document with its breadcrumb, back button and related links", () => {
		const html = render([ROOT, CHILD], CHILD.id);
		assert.ok(html.includes('data-testid="read-pane-breadcrumb"'));
		assert.ok(html.includes("Linear algebra — a working overview"));
		assert.ok(html.includes("Eigenvectors"));
		assert.ok(html.includes('data-testid="read-pane-back"'));
		assert.ok(html.includes('data-testid="read-pane-related"'));
		assert.ok(html.includes("The overview sets up the notation."));
	});

	it("shows the failed state with a retry for an empty child", () => {
		const failed: StudyDocument = {
			...CHILD,
			id: "doc_failed",
			sections: [],
			status: "failed",
			parent: { documentId: "root", sectionId: "maps", topicId: "failed-topic" },
		};
		const html = render([ROOT, failed], failed.id);
		assert.ok(html.includes("This topic could not be written"));
		assert.ok(html.includes("Retry this topic"));
		assert.ok(html.includes("Back to the chapter"));
	});

	it("opens the contents drawer with documents, chapters and spawned topics", () => {
		const html = render([ROOT, CHILD], "root", { treeOpen: true });
		assert.ok(html.includes('data-testid="read-pane-toc"'));
		assert.ok(html.includes("Contents"));
		assert.ok(html.includes(">Eigenvectors<"));
	});

	it("renders the topic graph with document and chapter nodes", () => {
		const html = render([ROOT, CHILD], "root", { view: "graph" });
		assert.ok(html.includes('data-testid="read-graph"'));
		assert.ok(html.includes("Topic graph"));
		assert.ok(html.includes(">Eigenvectors<"));
		assert.ok(html.includes(">Linear maps<"));
	});
});

describe("documentWriteInFlight — the live-write predicate", () => {
	it("is true only while the newest assistant message carries a streaming document part", () => {
		assert.equal(
			documentWriteInFlight([
				{ role: "assistant", parts: [{ type: "tool-edit_document", state: "input-streaming" }] },
			]),
			true,
		);
		assert.equal(
			documentWriteInFlight([
				{ role: "assistant", parts: [{ type: "tool-suggest_deeper", state: "input-available" }] },
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

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ReadDocumentView, documentWriteInFlight, isSkeletonDocument, mergeReadDocuments, readMinutes } from "../components/read-pane.tsx";
import type { StudyDocument, StudyWriterView } from "../src/core/contracts.ts";
import { studyDocumentSkeleton } from "../src/core/study-document.ts";

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
			questions: [
				{ id: "q1", question: "What makes a space a vector space?", answer: "It is closed under addition and scaling." },
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

const ROADMAP_ROOT: StudyDocument = {
	id: "root",
	title: "Angular",
	revision: 1,
	updatedAt: "2026-11-13T12:00:00.000Z",
	status: "ready",
	roadmap: {
		slug: "angular",
		title: "Angular",
		source: "https://roadmap.sh/angular",
		tracks: [{ id: "foundations", title: "Foundations", topicIds: ["components"] }],
	},
	sections: [
		{ id: "overview", heading: "Overview", body: "The whole subject at a glance." },
		{
			id: "components",
			heading: "Components",
			body: "The roadmap's Components topic covers Selector and Template.",
			suggestions: [
				{ id: "selector", heading: "Selector", blurb: "Components roadmap subtopic.", roadmap: { slug: "angular", nodeId: "subtopic:components:selector", kind: "subtopic" } },
				{ id: "template", heading: "Template", blurb: "Components roadmap subtopic.", roadmap: { slug: "angular", nodeId: "subtopic:components:template", kind: "subtopic" } },
			],
		},
	],
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
		assert.ok(html.includes('data-testid="read-section-questions"'));
		assert.ok(html.includes("Check yourself"));
		assert.ok(html.includes("What makes a space a vector space?"));
		assert.ok(html.includes("It is closed under addition and scaling."));
		assert.ok(html.includes("Generate more questions"));
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

	it("renders the roadmap-style map for a seeded root", () => {
		const html = render([ROADMAP_ROOT], "root", { view: "graph" });
		assert.ok(html.includes('data-testid="read-roadmap-graph"'));
		assert.ok(html.includes("Topic map"));
		assert.ok(html.includes("Foundations"));
		assert.ok(html.includes(">Components<"));
		assert.ok(html.includes(">Selector<"));
	});

	it("collapses roadmap subtopics in the reading view", () => {
		const html = render([ROADMAP_ROOT]);
		assert.ok(html.includes('data-testid="read-roadmap-subtopics"'));
		assert.ok(html.includes("Roadmap subtopics"));
		assert.ok(html.includes("Selector"));
	});

	it("renders the topic graph with document and chapter nodes", () => {
		const html = render([ROOT, CHILD], "root", { view: "graph" });
		assert.ok(html.includes('data-testid="read-graph"'));
		assert.ok(html.includes("Topic graph"));
		assert.ok(html.includes(">Eigenvectors<"));
		assert.ok(html.includes(">Linear maps<"));
	});
});

const SEEDED: StudyDocument = {
	...ROADMAP_ROOT,
	sections: [
		ROADMAP_ROOT.sections[0]!,
		{ ...ROADMAP_ROOT.sections[1]!, body: "Summary not written yet.", seed: true },
	],
};

function writer(kind: StudyWriterView["kind"], status: StudyWriterView["status"], sectionId?: string, error?: string): StudyWriterView {
	return { id: `w_${kind}`, key: `k_${kind}`, kind, documentId: "root", ...(sectionId ? { sectionId } : {}), status, label: kind, ...(error ? { error } : {}) };
}

describe("ReadDocumentView — lazy summaries, writers and handoffs (2026-11-15)", () => {
	it("renders a seed topic as its waiting state, never its placeholder body", () => {
		const html = render([SEEDED]);
		assert.ok(html.includes('data-state="seed"'));
		assert.ok(html.includes("The summary is written when you open this topic."));
		assert.ok(!html.includes("Summary not written yet."));
		assert.ok(html.includes("Selector"), "the subtopic cards stay");
	});

	it("shows a running summary writer and a failed one with Retry", () => {
		const writing = render([SEEDED], "root", { writers: [writer("summary", "running", "components")] });
		assert.ok(writing.includes('data-state="writing"'));
		assert.ok(writing.includes("Writing the summary…"));
		const failed = render([SEEDED], "root", { writers: [writer("summary", "failed", "components", "The writer stopped before writing the summary.")] });
		assert.ok(failed.includes('data-state="failed"'));
		assert.ok(failed.includes("The writer stopped before writing the summary."));
		assert.ok(failed.includes(">Retry<"));
	});

	it("lists the open document's sections in a desktop contents rail", () => {
		const html = render([ROOT]);
		assert.ok(html.includes('data-testid="read-pane-rail"'));
		assert.ok(html.includes("lg:block"));
	});

	it("offers Teach me on written chapters only, and save-to-graph for a written document", () => {
		const html = render([SEEDED]);
		assert.equal((html.match(/data-testid="read-section-teach"/g) ?? []).length, 1, "the Overview only — not the seed topic");
		assert.ok(html.includes('data-testid="read-pane-save-graph"'));
		const empty = render([{ ...ROOT, sections: [{ ...ROOT.sections[0]!, seed: true }] }]);
		assert.ok(!empty.includes('data-testid="read-pane-save-graph"'), "nothing written yet: nothing to save");
	});

	it("lets a chapter without questions ask for some, and shows a questions writer", () => {
		const html = render([ROOT]);
		assert.ok(html.includes('data-testid="read-section-questions-empty"'));
		assert.ok(html.includes("Add self-check questions"));
		const busy = render([ROOT], "root", { writers: [writer("questions", "running", "maps")] });
		assert.ok(busy.includes("Writing questions…"));
	});

	it("shows the writer count in the header while several write the open document", () => {
		const html = render([SEEDED], "root", { writers: [writer("summary", "running", "components"), { ...writer("subtopics", "running", "components"), id: "w_2", key: "k_2" }] });
		assert.ok(html.includes("Writing 2…"));
	});
});

describe("skeleton merging", () => {
	it("keeps a cached full document while its revision is current", () => {
		const cache = new Map<string, StudyDocument>();
		const [first] = mergeReadDocuments([ROOT], cache);
		assert.equal(first, ROOT);
		const skeleton = studyDocumentSkeleton(ROOT);
		assert.ok(isSkeletonDocument(skeleton));
		assert.equal(mergeReadDocuments([skeleton], cache)[0], ROOT, "same revision: the full copy stays");
		const newer = studyDocumentSkeleton({ ...ROOT, revision: ROOT.revision + 1 });
		assert.ok(isSkeletonDocument(mergeReadDocuments([newer], cache)[0]!), "a newer revision drops the stale full copy");
		assert.equal(cache.has("root"), false);
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

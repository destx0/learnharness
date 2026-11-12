/**
 * THE TOPIC GRAPH PROJECTION (2026-11-12): documents become nodes, chapters
 * become nodes, a chapter→child document edge is the deeper branch, and
 * agent-authored related links are dashed cross-links. The layout stays a
 * deterministic tree; related links must not be able to bend it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildReadGraph, layoutReadGraph, readGraphNodeId } from "../components/read-graph.tsx";
import type { StudyDocument } from "../src/core/contracts.ts";

const ROOT: StudyDocument = {
	id: "root",
	title: "Linear algebra",
	sections: [
		{ id: "overview", heading: "Overview", body: "Start here." },
		{ id: "maps", heading: "Linear maps", body: "Maps preserve structure." },
	],
	revision: 2,
	updatedAt: "2026-11-12T12:00:00.000Z",
};

const CHILD: StudyDocument = {
	id: "doc_eigen",
	title: "Eigenvectors",
	sections: [{ id: "idea", heading: "The idea", body: "A vector that only scales." }],
	revision: 1,
	updatedAt: "2026-11-12T12:00:00.000Z",
	parent: { documentId: "root", sectionId: "maps", topicId: "eigen" },
	status: "ready",
	related: [{ documentId: "root", sectionId: "overview", reason: "Sets up the notation." }],
};

describe("buildReadGraph", () => {
	it("builds document, chapter, deeper and related edges", () => {
		const graph = buildReadGraph([ROOT, CHILD]);
		assert.equal(graph.nodes.filter((node) => node.kind === "document").length, 2);
		assert.equal(graph.nodes.filter((node) => node.kind === "section").length, 3);
		const deeper = graph.edges.find((edge) => edge.kind === "deeper");
		assert.equal(deeper?.from, readGraphNodeId("root", "maps"));
		assert.equal(deeper?.to, readGraphNodeId("doc_eigen"));
		const related = graph.edges.find((edge) => edge.kind === "related");
		assert.equal(related?.from, readGraphNodeId("doc_eigen"));
		assert.equal(related?.to, readGraphNodeId("root", "overview"));
		assert.equal(related?.reason, "Sets up the notation.");
		assert.equal(graph.edges.filter((edge) => edge.kind === "contains").length, 3);
	});

	it("drops links whose target document or chapter no longer exists", () => {
		const graph = buildReadGraph([{ ...CHILD, related: [{ documentId: "doc_missing", reason: "Gone." }] }]);
		assert.equal(graph.edges.some((edge) => edge.kind === "related"), false);
	});
});

describe("layoutReadGraph", () => {
	it("places every node with a positive extent and routes every edge", () => {
		const placed = layoutReadGraph(buildReadGraph([ROOT, CHILD]));
		assert.equal(placed.nodes.length, 5);
		assert.ok(placed.width > 0);
		assert.ok(placed.height > 0);
		assert.equal(placed.edges.length, 5);
		for (const node of placed.nodes) {
			assert.ok(node.x >= 0);
			assert.ok(node.y >= 0);
			assert.ok(node.width > 0);
			assert.ok(node.height > 0);
			assert.ok(node.x + node.width <= placed.width);
			assert.ok(node.y + node.height <= placed.height);
		}
		for (const edge of placed.edges) assert.match(edge.path, /^M /);
	});
});

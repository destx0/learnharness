/**
 * THE ROADMAP MAP (2026-11-13): the roadmap.sh-style projection of a seeded
 * root. Every main topic is a spine node; its roadmap subtopics sit in a
 * side box; generated children carry a status; the layout is deterministic
 * and tall enough for the whole subject.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildRoadmapGraph, isRoadmapDocument } from "../components/read-roadmap-graph.tsx";
import type { StudyDocument } from "../src/core/contracts.ts";

const ROOT: StudyDocument = {
	id: "root",
	title: "Angular",
	revision: 1,
	updatedAt: "2026-11-13T00:00:00.000Z",
	status: "ready",
	roadmap: {
		slug: "angular",
		title: "Angular",
		source: "https://roadmap.sh/angular",
		tracks: [
			{ id: "foundations", title: "Foundations", topicIds: ["introduction", "components"] },
			{ id: "templates", title: "Templates & UI", topicIds: ["templates"] },
		],
	},
	sections: [
		{ id: "overview", heading: "Overview", body: "Start here." },
		{
			id: "introduction",
			heading: "Introduction to Angular",
			body: "Seed.",
			suggestions: [
				{ id: "architecture", heading: "Architecture", blurb: "Roadmap subtopic." },
				{ id: "history", heading: "History", blurb: "Roadmap subtopic." },
			],
		},
		{
			id: "components",
			heading: "Components",
			body: "Seed.",
			suggestions: [
				{ id: "selector", heading: "Selector", blurb: "Roadmap subtopic." },
				{ id: "template", heading: "Template", blurb: "Roadmap subtopic." },
			],
		},
		{
			id: "templates",
			heading: "Templates",
			body: "Seed.",
			suggestions: [{ id: "binding", heading: "Data Binding", blurb: "Roadmap subtopic." }],
		},
	],
};

const CHILD: StudyDocument = {
	id: "doc_selector",
	title: "Selector",
	sections: [{ id: "idea", heading: "The idea", body: "A selector picks elements." }],
	revision: 1,
	updatedAt: "2026-11-13T00:00:00.000Z",
	parent: { documentId: "root", sectionId: "components", topicId: "selector" },
	status: "ready",
};

describe("buildRoadmapGraph", () => {
	it("lays out every main topic on the spine and its subtopics in side boxes", () => {
		const layout = buildRoadmapGraph(ROOT, [CHILD]);
		assert.equal(layout.mainTopics, 3);
		assert.equal(layout.subtopics, 5);
		assert.equal(layout.nodes.filter((node) => node.kind === "topic").length, 3);
		assert.equal(layout.nodes.filter((node) => node.kind === "subtopic").length, 5);
		assert.equal(layout.boxes.length, 3);
		assert.equal(layout.trackLabels.length, 2);
		assert.deepEqual(layout.trackLabels.map((label) => label.text), ["Foundations", "Templates & UI"]);
		assert.ok(layout.width > 0);
		assert.ok(layout.height > 500);
		// The generated child is attached to its subtopic node.
		const selector = layout.nodes.find((node) => node.kind === "subtopic" && node.topicId === "selector");
		assert.equal(selector?.kind === "subtopic" ? selector.childDocumentId : null, "doc_selector");
		assert.equal(selector?.kind === "subtopic" ? selector.status : null, "ready");
	});

	it("alternates the side boxes and routes the spine", () => {
		const layout = buildRoadmapGraph(ROOT, []);
		assert.equal(layout.boxes[0]?.side, "left");
		assert.equal(layout.boxes[1]?.side, "right");
		assert.equal(layout.boxes[2]?.side, "left");
		assert.equal(layout.lines.filter((line) => line.kind === "spine").length, 2);
		assert.equal(layout.lines.filter((line) => line.kind === "branch").length, 3);
	});

	it("splits a big topic into left and right group boxes", () => {
		const big: StudyDocument = {
			...ROOT,
			sections: [
				{ id: "overview", heading: "Overview", body: "Start." },
				{
					id: "components",
					heading: "Components",
					body: "Seed.",
					suggestions: Array.from({ length: 12 }, (_, i) => ({
						id: `sub-${i}`,
						heading: `Subtopic ${i}`,
						blurb: "Roadmap subtopic.",
					})),
				},
			],
			roadmap: {
				slug: "angular",
				title: "Angular",
				source: "https://roadmap.sh/angular",
				tracks: [{ id: "foundations", title: "Foundations", topicIds: ["components"] }],
			},
		};
		const layout = buildRoadmapGraph(big, []);
		assert.equal(layout.boxes.length, 2);
		assert.deepEqual(layout.boxes.map((box) => box.side), ["left", "right"]);
		assert.equal(layout.nodes.filter((node) => node.kind === "subtopic").length, 12);
	});

	it("recognizes only the roadmap root", () => {
		assert.equal(isRoadmapDocument(ROOT), true);
		assert.equal(isRoadmapDocument(CHILD), false);
		assert.equal(isRoadmapDocument(null), false);
	});
});

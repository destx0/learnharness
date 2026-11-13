/**
 * IMPORTED ROADMAP PRESETS (2026-11-13): a read session whose topic names an
 * imported roadmap starts with the root graph already seeded. The preset is
 * labels + hierarchy only; the read agent writes the guide. These pins hold
 * the title match, the track seed (suggestions), the topic seed (roadmap
 * context for the writer) and the no-overwrite rule.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-roadmap-"));
process.env.LH_DATA_DIR = TMP_DATA;
fs.mkdirSync(path.join(TMP_DATA, "roadmaps"), { recursive: true });
fs.writeFileSync(path.join(TMP_DATA, "roadmaps", "angular.json"), JSON.stringify({
	slug: "angular",
	title: "Angular",
	source: "https://roadmap.sh/angular",
	importedAt: "2026-11-13T00:00:00.000Z",
	tracks: [{
		id: "foundations",
		title: "Foundations",
		topics: [
			{ id: "introduction", title: "Introduction", subtopics: [{ id: "architecture", title: "Architecture" }] },
			{ id: "components", title: "Components", subtopics: [{ id: "selector", title: "Selector" }, { id: "template", title: "Template" }] },
		],
	}],
}));

const { chatStore } = await import("../src/store/chats.ts");
const { readRoadmap, roadmapChildSeed, roadmapForTitle, roadmapRootSeed, seedRoadmapForChat } = await import("../src/server/roadmaps.ts");
const { studyDocumentChildForTopic } = await import("../src/core/study-document.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("roadmap presets", () => {
	it("matches a session topic to the imported roadmap", () => {
		assert.equal(readRoadmap("angular")?.title, "Angular");
		assert.equal(roadmapForTitle("Angular")?.slug, "angular");
		assert.equal(roadmapForTitle("Can you teach me Angular?")?.slug, "angular");
		assert.equal(roadmapForTitle("Rust"), null);
	});

	it("seeds a read session's root with every main topic", () => {
		const chat = chatStore.createChat("Angular", "read");
		assert.equal(seedRoadmapForChat(chatStore, chat.id, chat.title), true);
		const record = chatStore.getChat(chat.id);
		assert.equal(record?.document?.title, "Angular");
		assert.deepEqual(record?.document?.sections.map((section) => section.id), ["overview", "introduction", "components"]);
		assert.equal(record?.document?.sections[1]?.suggestions?.[0]?.roadmap?.nodeId, "subtopic:introduction:architecture");
		assert.equal(record?.document?.roadmap?.tracks[0]?.title, "Foundations");
		assert.equal(record?.readingDocumentId, "root");
		// Never overwrite an existing document; never seed a teach session.
		assert.equal(seedRoadmapForChat(chatStore, chat.id, "Angular"), false);
		const teach = chatStore.createChat("Angular");
		assert.equal(seedRoadmapForChat(chatStore, teach.id, "Angular"), false);
	});

	it("seeds from the chat-creation route (the real read-draft path)", async () => {
		const { POST } = await import("../app/api/chats/route.ts");
		const response = await POST(new Request("http://localhost/api/chats", {
			method: "POST",
			body: JSON.stringify({ title: "Angular", kind: "read" }),
		}));
		const body = (await response.json()) as { id: string };
		const record = chatStore.getChat(body.id);
		assert.equal(record?.kind, "read");
		assert.equal(record?.document?.title, "Angular");
		assert.equal(record?.document?.sections[1]?.suggestions?.[0]?.roadmap?.nodeId, "subtopic:introduction:architecture");
	});

	it("seeds legacy track/topic children and a subtopic deep dive", () => {
		const roadmap = readRoadmap("angular")!;
		const base = {
			id: "doc_track",
			title: "Foundations",
			sections: [],
			revision: 0,
			updatedAt: "2026-11-13T00:00:00.000Z",
			parent: { documentId: "root", sectionId: "overview", topicId: "foundations" },
			status: "writing" as const,
		};
		const track = roadmapChildSeed(roadmap, "track:foundations", base);
		assert.equal(track.document.sections.length, 1);
		assert.deepEqual(track.document.sections[0]?.suggestions?.map((topic) => topic.id), ["introduction", "components"]);
		assert.match(track.context, /Roadmap track: Foundations/);

		const topic = roadmapChildSeed(roadmap, "topic:components", { ...base, id: "doc_topic", parent: { documentId: "doc_track", sectionId: "overview", topicId: "components" } });
		assert.equal(topic.document.sections.length, 0);
		assert.match(topic.context, /Subtopics in roadmap order: Selector; Template/);

		const subtopic = roadmapChildSeed(roadmap, "subtopic:components:selector", { ...base, id: "doc_selector", parent: { documentId: "root", sectionId: "components", topicId: "selector" } });
		assert.equal(subtopic.document.title, "Selector");
		assert.equal(subtopic.document.sections.length, 0);
		assert.match(subtopic.context, /Roadmap subtopic: Selector \(topic: Components/);
	});

	it("the generated child is discoverable by its parent topic", () => {
		const chat = chatStore.createChat("roadmap child", "read");
		const root = roadmapRootSeed(readRoadmap("angular")!);
		chatStore.saveDocument(chat.id, root);
		const child = {
			id: "doc_track",
			title: "Foundations",
			sections: [],
			revision: 0,
			updatedAt: "2026-11-13T00:00:00.000Z",
			parent: { documentId: "root", sectionId: "overview", topicId: "foundations" },
			status: "writing" as const,
		};
		chatStore.saveDocument(chat.id, child);
		const record = chatStore.getChat(chat.id)!;
		assert.equal(studyDocumentChildForTopic(record, "root", "overview", "foundations")?.id, "doc_track");
	});
});

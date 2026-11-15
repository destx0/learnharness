/**
 * IMPORTED ROADMAP PRESETS (2026-11-13; lazy summaries 2026-11-15): a read
 * session started from a roadmap card begins with the root seeded — every
 * main topic a lazy seed section, its subtopics as suggestions with pending
 * overviews. The preset is labels + hierarchy only; the agent and the
 * background writers write the guide. These pins hold:
 *   - only an explicit slug seeds (a typed topic never does);
 *   - seeds pass the edit engine's whole-document rules, including on the
 *     real imported data (duplicate headings, glyph labels, huge topics);
 *   - the opening queues every pending subtopic overview, in batches;
 *   - the subtopic deep-dive context and the no-overwrite rule.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-roadmap-"));
const REAL_ROADMAPS = path.resolve("data", "roadmaps");
process.env.LH_DATA_DIR = TMP_DATA;
fs.mkdirSync(path.join(TMP_DATA, "roadmaps"), { recursive: true });
fs.writeFileSync(path.join(TMP_DATA, "roadmaps", "catalog.json"), JSON.stringify({
	source: "https://roadmap.sh/roadmaps",
	importedAt: "2026-11-13T00:00:00.000Z",
	categories: [],
	roadmaps: [{ slug: "angular", title: "Angular", type: "skill", category: "Frameworks", subcategory: "Frameworks" }],
}));
fs.writeFileSync(path.join(TMP_DATA, "roadmaps", "angular.json"), JSON.stringify({
	slug: "angular",
	title: "Angular",
	source: "https://roadmap.sh/angular",
	importedAt: "2026-11-13T00:00:00.000Z",
	tracks: [{
		id: "foundations",
		title: "Foundations",
		topics: [
			{ id: "introduction", title: "Introduction", subtopics: [{ id: "architecture", title: "Architecture" }, { id: "topic", title: "@" }] },
			{ id: "components", title: "Components", subtopics: [{ id: "selector", title: "Selector" }, { id: "template", title: "Template" }] },
			{ id: "components-2", title: "Components", subtopics: [] },
		],
	}],
}));

const { chatStore } = await import("../src/store/chats.ts");
const { readRoadmap, roadmapRootSeed, roadmapSubtopicContext, sanitizeRoadmap, seedRoadmapForChat } = await import("../src/server/roadmaps.ts");
const writers = await import("../src/server/read-writers.ts");
const { studyDocumentProblems, studySubtopicPending, applyStudyDocumentEdit, STUDY_SUBTOPIC_PLACEHOLDER } = await import("../src/core/study-document.ts");
type RoadmapDataset = import("../src/server/roadmaps.ts").RoadmapDataset;

after(() => {
	writers.setReadWriterExecutor(undefined);
	writers.resetReadWriters();
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("roadmap presets", () => {
	it("seeds only from an explicit roadmap slug", async () => {
		const { POST } = await import("../app/api/chats/route.ts");
		const typed = await POST(new Request("http://localhost/api/chats", {
			method: "POST",
			body: JSON.stringify({ title: "Explain how Angular change detection works", kind: "read" }),
		}));
		const typedId = ((await typed.json()) as { id: string }).id;
		assert.equal(chatStore.getDocument(typedId, "root"), null, "a typed topic is never hijacked into a roadmap");

		const picked = await POST(new Request("http://localhost/api/chats", {
			method: "POST",
			body: JSON.stringify({ title: "Angular", kind: "read", roadmapSlug: "angular" }),
		}));
		const pickedId = ((await picked.json()) as { id: string }).id;
		const root = chatStore.getDocument(pickedId, "root");
		assert.equal(root?.title, "Angular");
		assert.equal(chatStore.getChat(pickedId)?.roadmapSlug, "angular");
		assert.equal(chatStore.getChat(pickedId)?.readingDocumentId, "root");
	});

	it("seeds every main topic as a lazy section with pending subtopic overviews", () => {
		const chat = chatStore.createChat("Angular", "read");
		assert.equal(seedRoadmapForChat(chatStore, chat.id, "angular"), true);
		const root = chatStore.getDocument(chat.id, "root")!;
		assert.deepEqual(root.sections.map((section) => section.id), ["overview", "introduction", "components", "components-2"]);
		assert.equal(root.sections[0]?.seed, undefined, "the Overview is the opening turn's to write");
		assert.equal(root.sections[1]?.seed, true);
		assert.deepEqual(root.sections[1]?.suggestions?.map((t) => t.id), ["architecture"], "glyph-only labels are dropped");
		assert.equal(root.sections[1]?.suggestions?.[0]?.blurb, STUDY_SUBTOPIC_PLACEHOLDER);
		assert.equal(root.sections[3]?.heading, "Components (2)", "repeated topic titles get distinct headings");
		assert.deepEqual(studyDocumentProblems(root), []);
		// Never overwrite an existing document; never seed a teach session.
		assert.equal(seedRoadmapForChat(chatStore, chat.id, "angular"), false);
		const teach = chatStore.createChat("Angular");
		assert.equal(seedRoadmapForChat(chatStore, teach.id, "angular"), false);
	});

	it("keeps roadmap subtopics through edits, and a written body ends the seed", () => {
		const root = roadmapRootSeed(readRoadmap("angular")!);
		const next = applyStudyDocumentEdit(root, {
			sections: [{ id: "components", body: "Components are the building blocks.", suggestions: [{ id: "lifecycle", heading: "Lifecycle hooks", blurb: "When Angular calls your code." }] }],
		});
		const section = next.sections.find((s) => s.id === "components")!;
		assert.equal(section.seed, undefined);
		assert.deepEqual(section.suggestions?.map((t) => t.id), ["selector", "template", "lifecycle"]);
		assert.ok(section.suggestions?.[0]?.roadmap, "the roadmap pointer survives");
	});

	it("every imported roadmap seeds a document the edit engine accepts", { skip: !fs.existsSync(REAL_ROADMAPS) && "no imported roadmaps on this machine" }, () => {
		let checked = 0;
		for (const file of fs.readdirSync(REAL_ROADMAPS)) {
			if (!file.endsWith(".json") || file === "catalog.json") continue;
			const roadmap = JSON.parse(fs.readFileSync(path.join(REAL_ROADMAPS, file), "utf-8")) as RoadmapDataset;
			const seed = roadmapRootSeed(roadmap);
			assert.deepEqual(studyDocumentProblems(seed), [], roadmap.slug);
			// The first real agent edit must succeed on every roadmap.
			const target = seed.sections[1] ?? seed.sections[0]!;
			assert.doesNotThrow(() => applyStudyDocumentEdit(seed, { sections: [{ id: target.id, body: "A real summary." }] }), roadmap.slug);
			for (const section of seed.sections) {
				for (const sub of section.suggestions ?? []) assert.match(sub.heading, /[\p{L}\p{N}]/u, `${roadmap.slug}: ${sub.heading}`);
			}
			checked++;
		}
		assert.ok(checked > 0);
	});

	it("sanitizing is idempotent and keeps unique subtopic ids", () => {
		const roadmap = readRoadmap("angular")!;
		const once = sanitizeRoadmap(roadmap);
		assert.deepEqual(sanitizeRoadmap(once).tracks.map((t) => t.topics.map((topic) => topic.title)), [["Introduction", "Components", "Components (2)"]]);
	});

	it("queues every pending subtopic overview at the opening, in batches", async () => {
		const chat = chatStore.createChat("Angular", "read");
		seedRoadmapForChat(chatStore, chat.id, "angular");
		const started: string[] = [];
		writers.setReadWriterExecutor(async ({ chatId, assignment }) => {
			started.push(`${assignment.sectionId}:${assignment.subtopicIds?.join(",")}`);
			const { applyStudySubtopicBlurbs } = await import("../src/core/study-document.ts");
			const doc = chatStore.getDocument(chatId, "root")!;
			chatStore.saveDocument(chatId, applyStudySubtopicBlurbs(doc, assignment.sectionId!, (assignment.subtopicIds ?? []).map((id) => ({ id, blurb: `About ${id}.` }))));
		});
		assert.equal(writers.enqueueRoadmapSubtopicWriters(chat.id), 2);
		assert.equal(writers.enqueueRoadmapSubtopicWriters(chat.id), 0, "re-queueing joins the running writers");
		for (let i = 0; i < 200 && writers.readWriterStatus(chat.id).length > 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.deepEqual(started.sort(), ["components:selector,template", "introduction:architecture"]);
		const root = chatStore.getDocument(chat.id, "root")!;
		assert.equal(root.sections.flatMap((s) => s.suggestions ?? []).filter(studySubtopicPending).length, 0);
	});

	it("builds the deep-dive context for a roadmap subtopic", () => {
		const roadmap = readRoadmap("angular")!;
		assert.match(roadmapSubtopicContext(roadmap, "subtopic:components:selector"), /Roadmap subtopic: Selector \(topic: Components, track: Foundations\)/);
		assert.equal(roadmapSubtopicContext(roadmap, "subtopic:components:missing"), "");
		assert.equal(roadmapSubtopicContext(roadmap, "track:foundations"), "");
	});

	it("serves the catalog with preset and existing-session badges", async () => {
		const { GET } = await import("../app/api/roadmaps/route.ts");
		const chat = chatStore.createChat("Angular", "read");
		seedRoadmapForChat(chatStore, chat.id, "angular");
		const body = (await (await GET()).json()) as {
			roadmaps?: Array<{ slug: string; preset?: boolean; existingChatId?: string | null }>;
			missing?: boolean;
		};
		assert.equal(body.missing, undefined);
		const angular = body.roadmaps?.find((item) => item.slug === "angular");
		assert.equal(angular?.preset, true);
		assert.ok(angular?.existingChatId);
	});
});

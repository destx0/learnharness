import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { ChatStore } from "../core/ports.ts";
import type { StudyDocument } from "../core/contracts/chat.ts";
import { STUDY_ROOT_DOCUMENT_ID, STUDY_SUBTOPIC_PLACEHOLDER, studyDocumentProblems } from "../core/study-document.ts";

/**
 * Imported roadmap presets (roadmap.sh, 2026-11-13).
 *
 * The import script writes a compact tree under the mutable data dir:
 * tracks → roadmap topics → roadmap subtopics (Angular has a curated
 * six-track mapping; every other roadmap is one track in visual order).
 * Nothing here copies the roadmap's prose; only the labels and the
 * hierarchy are stored, and the read agent writes the guides. A read
 * session started from a roadmap card begins with the root document
 * seeded: every main topic is a section, its subtopics are suggestions.
 * Everything stays a normal StudyDocument, so the pane, graph, chat
 * steering and compaction need no special case.
 */

export interface RoadmapSubtopic {
	id: string;
	title: string;
}

export interface RoadmapTopic {
	id: string;
	title: string;
	subtopics: RoadmapSubtopic[];
}

export interface RoadmapTrack {
	id: string;
	title: string;
	topics: RoadmapTopic[];
}

export interface RoadmapDataset {
	slug: string;
	title: string;
	source: string;
	importedAt: string;
	tracks: RoadmapTrack[];
}

export interface RoadmapCatalogItem {
	slug: string;
	title: string;
	type: string;
	category: string;
	subcategory: string;
}

export interface RoadmapCatalog {
	source: string;
	importedAt: string;
	categories: Array<{
		title: string;
		subCategories: Array<{
			title: string;
			roadmaps: Array<{ slug: string; title: string; type: string }>;
		}>;
	}>;
	roadmaps: RoadmapCatalogItem[];
}

function roadmapFile(slug: string): string {
	return path.join(/* turbopackIgnore: true */ PATHS.data, "roadmaps", `${slug}.json`);
}

function readDataset(file: string): RoadmapDataset | null {
	try {
		const data = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf-8")) as RoadmapDataset;
		if (typeof data.slug !== "string" || !Array.isArray(data.tracks)) return null;
		return data;
	} catch {
		return null;
	}
}

export function readRoadmap(slug: string): RoadmapDataset | null {
	if (!/^[a-z0-9-]+$/.test(slug)) return null;
	return readDataset(roadmapFile(slug));
}

/** The imported roadmap catalog for the read quick start. */
export function readRoadmapCatalog(): RoadmapCatalog | null {
	try {
		const data = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ path.join(PATHS.data, "roadmaps", "catalog.json"), "utf-8")) as RoadmapCatalog;
		if (!Array.isArray(data.roadmaps) || !Array.isArray(data.categories)) return null;
		return data;
	} catch {
		return null;
	}
}

/** Slugs with a seeded graph preset available. */
export function roadmapPresetSlugs(): Set<string> {
	try {
		const dir = path.join(/* turbopackIgnore: true */ PATHS.data, "roadmaps");
		return new Set(fs.readdirSync(/* turbopackIgnore: true */ dir)
			.filter((file) => file.endsWith(".json") && file !== "catalog.json")
			.map((file) => file.slice(0, -".json".length)));
	} catch {
		return new Set();
	}
}

/** Is a label worth showing? roadmap.sh's visual graphs carry stray glyph
 *  nodes ("@", "!", "\\") that the import picks up as subtopics. */
function meaningfulLabel(title: string): boolean {
	return /[\p{L}\p{N}]/u.test(title);
}

/** Make an imported dataset safe to seed: drop glyph-only labels and give
 *  repeated topic titles a distinct heading (a section's heading is its
 *  TOC label, and the edit engine requires them unique). roadmap.sh can
 *  list the same topic in two places of one poster (iOS: "UIKit" twice);
 *  the occurrence number is the only honest distinguisher the import
 *  carries, so the second becomes "UIKit (2)". Pure. */
export function sanitizeRoadmap(roadmap: RoadmapDataset): RoadmapDataset {
	const seen = new Map<string, number>();
	return {
		...roadmap,
		tracks: roadmap.tracks.map((track) => ({
			...track,
			topics: track.topics
				.filter((topic) => meaningfulLabel(topic.title))
				.map((topic) => {
					const key = topic.title.trim().toLowerCase();
					const count = (seen.get(key) ?? 0) + 1;
					seen.set(key, count);
					const subIds = new Set<string>();
					return {
						...topic,
						title: count > 1 ? `${topic.title.trim()} (${count})` : topic.title.trim(),
						subtopics: topic.subtopics.filter((sub) => {
							if (!meaningfulLabel(sub.title) || subIds.has(sub.id)) return false;
							subIds.add(sub.id);
							return true;
						}),
					};
				}),
		})),
	};
}

/** The placeholder body of a topic whose summary is not written yet. The
 *  pane does not render it (a seed section shows its subtopics and a
 *  writing state); it is what the agent sees in read_document. */
export function roadmapSeedBody(topic: RoadmapTopic): string {
	return topic.subtopics.length > 0
		? `Summary not written yet. Roadmap subtopics: ${topic.subtopics.map((sub) => sub.title).join(" · ")}.`
		: "Summary not written yet.";
}

/** The root document a roadmap read session starts with (lazy summaries,
 *  2026-11-15). Every roadmap main topic is a section from the start, so
 *  the contents and the map show the whole subject, but each topic is a
 *  SEED: a placeholder body plus its subtopics as suggestions. The opening
 *  chat turn writes only the Overview; background writers fill every
 *  subtopic overview up front and each topic's summary when the learner
 *  opens it. The seed passes the edit engine's whole-document rules. */
export function roadmapRootSeed(input: RoadmapDataset, now = new Date()): StudyDocument {
	const roadmap = sanitizeRoadmap(input);
	const topicCount = roadmap.tracks.reduce((n, track) => n + track.topics.length, 0);
	const sections: StudyDocument["sections"] = [{
		id: "overview",
		heading: "Overview",
		body: [
			`This guide follows the [${roadmap.title} roadmap](${roadmap.source}) on roadmap.sh.`,
			`The ${topicCount} ${topicCount === 1 ? "section" : "sections"} below are its main topics. Each topic's summary is written when you open it; open a subtopic to go deeper.`,
			"The guide is living: ask in the conversation to expand, simplify, or redirect anything.",
		].join("\n\n"),
	}];
	const used = new Set(["overview"]);
	for (const track of roadmap.tracks) {
		for (const topic of track.topics) {
			// Section ids must stay unique even if two roadmap topics share
			// an id; the roadmap pointer keeps the original.
			let id = topic.id;
			for (let n = 2; used.has(id); n++) id = `${topic.id}-${n}`;
			used.add(id);
			sections.push({
				id,
				heading: topic.title,
				body: roadmapSeedBody(topic),
				seed: true,
				...(topic.subtopics.length > 0
					? {
						suggestions: topic.subtopics.map((sub) => ({
							id: sub.id,
							heading: sub.title,
							blurb: STUDY_SUBTOPIC_PLACEHOLDER,
							roadmap: { slug: roadmap.slug, nodeId: `subtopic:${topic.id}:${sub.id}`, kind: "subtopic" as const },
						})),
					}
					: {}),
			});
		}
	}
	const document: StudyDocument = {
		id: STUDY_ROOT_DOCUMENT_ID,
		title: roadmap.title,
		revision: 1,
		updatedAt: now.toISOString(),
		status: "ready",
		roadmap: {
			slug: roadmap.slug,
			title: roadmap.title,
			source: roadmap.source,
			tracks: roadmap.tracks.map((track) => ({
				id: track.id,
				title: track.title,
				topicIds: track.topics.map((topic) => sections.find((section) => section.heading === topic.title)?.id ?? topic.id),
			})),
		},
		sections,
	};
	const problems = studyDocumentProblems(document);
	if (problems.length > 0) throw new Error(`roadmap "${roadmap.slug}" seed is invalid:\n${problems.join("\n")}`);
	return document;
}

function findTopic(roadmap: RoadmapDataset, topicId: string): { track: RoadmapTrack; topic: RoadmapTopic } | null {
	for (const track of roadmap.tracks) {
		const topic = track.topics.find((candidate) => candidate.id === topicId);
		if (topic) return { track, topic };
	}
	return null;
}

/** The hidden writer context for a roadmap subtopic deep dive (the only
 *  roadmap pointer kind the root seed creates). Empty when the pointer no
 *  longer resolves (a re-import renamed it): the writer still has the
 *  suggestion's own heading and blurb. */
export function roadmapSubtopicContext(roadmap: RoadmapDataset, nodeId: string): string {
	if (!nodeId.startsWith("subtopic:")) return "";
	const rest = nodeId.slice("subtopic:".length);
	const split = rest.indexOf(":");
	const topicId = split >= 0 ? rest.slice(0, split) : "";
	const subtopicId = split >= 0 ? rest.slice(split + 1) : "";
	const found = findTopic(roadmap, topicId);
	const subtopic = found?.topic.subtopics.find((sub) => sub.id === subtopicId);
	if (!found || !subtopic) return "";
	return `Roadmap subtopic: ${subtopic.title} (topic: ${found.topic.title}, track: ${found.track.title}). Write a focused deep dive on this subtopic: one level deeper than the ${found.topic.title} summary, not a repeat of it. Start from what the reader already learned in that topic.`;
}

/** Seed a read session's root document from an imported roadmap. Only an
 *  explicit roadmap choice (a catalog card's slug) seeds: matching the
 *  learner's typed topic against roadmap names turned questions like
 *  "Explain how Python decorators work" into the whole Python roadmap.
 *  Called once, at session creation. */
export function seedRoadmapForChat(chatStore: ChatStore, chatId: string, slug: string): boolean {
	const roadmap = readRoadmap(slug);
	if (!roadmap) return false;
	const record = chatStore.getChat(chatId);
	if (!record || record.kind !== "read" || chatStore.getDocument(chatId, STUDY_ROOT_DOCUMENT_ID)) return false;
	chatStore.saveDocument(chatId, roadmapRootSeed(roadmap));
	chatStore.saveReadingDocumentId(chatId, STUDY_ROOT_DOCUMENT_ID);
	chatStore.saveRoadmapSlug(chatId, roadmap.slug);
	return true;
}

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { ChatStore } from "../core/ports.ts";
import type { StudyDocument, StudyTopicSuggestion } from "../core/contracts/chat.ts";
import { STUDY_ROOT_DOCUMENT_ID } from "../core/study-document.ts";

/**
 * Imported roadmap presets (roadmap.sh, 2026-11-13).
 *
 * The import script writes a compact tree under the mutable data dir:
 * six tracks → roadmap topics → roadmap subtopics. Nothing here copies the
 * roadmap's prose; only the labels and the hierarchy are stored, and the
 * read agent writes the guides. A read session whose opening topic matches
 * an imported roadmap starts with the root document already seeded: the
 * tracks are its suggestions, and each track/topic child is seeded with the
 * next level. Everything stays a normal StudyDocument, so the pane, graph,
 * chat steering and compaction need no special case.
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

function roadmapFile(slug: string): string {
	return path.join(/* turbopackIgnore: true */ PATHS.data, "roadmaps", `${slug}.json`);
}

function normalize(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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

/** The imported roadmap whose title/slug the session topic names, if any. */
export function roadmapForTitle(title: string): RoadmapDataset | null {
	const needle = normalize(title);
	if (!needle) return null;
	try {
		const dir = path.join(/* turbopackIgnore: true */ PATHS.data, "roadmaps");
		for (const file of fs.readdirSync(/* turbopackIgnore: true */ dir)) {
			if (!file.endsWith(".json")) continue;
			const roadmap = readDataset(path.join(dir, file));
			if (!roadmap) continue;
			const names = [roadmap.slug, roadmap.title].map(normalize);
			if (names.some((name) => name && needle.includes(name))) return roadmap;
		}
	} catch {
		/* no imported roadmaps — normal read sessions still work */
	}
	return null;
}

function truncate(value: string, max: number): string {
	const text = value.trim();
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function topicBlurb(topic: RoadmapTopic): string {
	return truncate(`Roadmap subtopics: ${topic.subtopics.map((sub) => sub.title).join(" · ")}`, 240);
}

function trackBlurb(track: RoadmapTrack): string {
	return truncate(`Roadmap topics: ${track.topics.map((topic) => topic.title).join(" · ")}`, 240);
}

function trackSuggestion(roadmap: RoadmapDataset, track: RoadmapTrack): StudyTopicSuggestion {
	return {
		id: track.id,
		heading: track.title,
		blurb: trackBlurb(track),
		roadmap: { slug: roadmap.slug, nodeId: `track:${track.id}`, kind: "track" },
	};
}

function topicSuggestion(roadmap: RoadmapDataset, topic: RoadmapTopic): StudyTopicSuggestion {
	return {
		id: topic.id,
		heading: topic.title,
		blurb: topicBlurb(topic),
		roadmap: { slug: roadmap.slug, nodeId: `topic:${topic.id}`, kind: "topic" },
	};
}

/** The root document a read session starts with. The tracks are ordinary
 *  suggestions, so the existing inline cards, tree ghosts and graph work. */
export function roadmapRootSeed(roadmap: RoadmapDataset, now = new Date()): StudyDocument {
	return {
		id: STUDY_ROOT_DOCUMENT_ID,
		title: roadmap.title,
		revision: 1,
		updatedAt: now.toISOString(),
		status: "ready",
		sections: [{
			id: "overview",
			heading: "Overview",
			body: [
				`This reading path is built from the [${roadmap.title} roadmap](${roadmap.source}) on roadmap.sh.`,
				`The ${roadmap.tracks.length} tracks below follow its topics. Open a track to see the topics inside it, then open a topic to read the roadmap's subtopics in depth.`,
				"The guide is living: ask in the conversation to expand, simplify, or redirect anything.",
			].join("\n\n"),
			suggestions: roadmap.tracks.map((track) => trackSuggestion(roadmap, track)),
		}],
	};
}

function findTrack(roadmap: RoadmapDataset, trackId: string): RoadmapTrack | null {
	return roadmap.tracks.find((track) => track.id === trackId) ?? null;
}

function findTopic(roadmap: RoadmapDataset, topicId: string): { track: RoadmapTrack; topic: RoadmapTopic } | null {
	for (const track of roadmap.tracks) {
		const topic = track.topics.find((candidate) => candidate.id === topicId);
		if (topic) return { track, topic };
	}
	return null;
}

/** Build the seeded child for a track/topic pointer and the hidden context
 *  the writer turn needs. Unknown pointers leave the pending child alone. */
export function roadmapChildSeed(
	roadmap: RoadmapDataset,
	nodeId: string,
	child: StudyDocument,
	now = new Date(),
): { document: StudyDocument; context: string } {
	if (nodeId.startsWith("track:")) {
		const track = findTrack(roadmap, nodeId.slice("track:".length));
		if (!track) return { document: child, context: "" };
		const topics = track.topics.map((topic) => topic.title).join(" · ");
		return {
			document: {
				...child,
				title: track.title,
				updatedAt: now.toISOString(),
				sections: [{
					id: "overview",
					heading: "Overview",
					body: `This track follows the ${roadmap.title} roadmap: ${topics}. Open a topic below to read it in depth.`,
					suggestions: track.topics.map((topic) => topicSuggestion(roadmap, topic)),
				}],
			},
			context: `Roadmap track: ${track.title}. Topics: ${track.topics.map((topic) => topic.title).join("; ")}. The child document is seeded with these topics as its suggestions — keep them and build the track around them.`,
		};
	}
	if (nodeId.startsWith("topic:")) {
		const found = findTopic(roadmap, nodeId.slice("topic:".length));
		if (!found) return { document: child, context: "" };
		const subtopics = found.topic.subtopics.map((sub) => sub.title);
		return {
			document: { ...child, title: found.topic.title, updatedAt: now.toISOString(), sections: [] },
			context: `Roadmap topic: ${found.topic.title} (track: ${found.track.title}). Subtopics in roadmap order: ${subtopics.join("; ")}. Write one section per subtopic, in this order (group only closely related ones that read better together). Give every section its own deeper directions and self-check questions. This is the content the learner chose; do not replace it with a generic survey.`,
		};
	}
	return { document: child, context: "" };
}

/** Seed a read session's root document when its opening topic names an
 *  imported roadmap. Called once, at session creation. */
export function seedRoadmapForChat(chatStore: ChatStore, chatId: string, title: string): boolean {
	const roadmap = roadmapForTitle(title);
	if (!roadmap) return false;
	const record = chatStore.getChat(chatId);
	if (!record || record.kind !== "read" || record.document) return false;
	chatStore.saveDocument(chatId, roadmapRootSeed(roadmap));
	chatStore.saveReadingDocumentId(chatId, STUDY_ROOT_DOCUMENT_ID);
	return true;
}

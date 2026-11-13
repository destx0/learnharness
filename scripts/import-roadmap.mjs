#!/usr/bin/env node
/**
 * Import a roadmap.sh roadmap into a local read-mode preset.
 *
 *   node scripts/import-roadmap.mjs angular
 *
 * roadmap.sh exposes the official roadmap graph at
 * /api/v1-official-roadmap/<slug> (the same data its page renders). The
 * graph is visual, not a tree: this script imposes the read-mode tree —
 * six tracks for the root, the roadmap topics inside each track, and the
 * roadmap subtopics inside each topic. Only labels and hierarchy are
 * stored; the guide prose is written by the read agent.
 *
 * The output lives under the mutable data dir (data/roadmaps/, gitignored),
 * never in the source tree. Re-run to refresh from roadmap.sh.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const slug = (process.argv[2] || "angular").toLowerCase();
if (slug !== "angular") throw new Error("Only the Angular roadmap is mapped so far.");

const response = await fetch(`https://roadmap.sh/api/v1-official-roadmap/${slug}`);
if (!response.ok) throw new Error(`roadmap.sh returned ${response.status}`);
const roadmap = await response.json();
const nodes = Array.isArray(roadmap.nodes) ? roadmap.nodes : [];

const topics = nodes.filter((node) => node.type === "topic" && node.data?.label);
const subtopics = nodes.filter((node) => node.type === "subtopic" && node.data?.label);
const sections = nodes.filter((node) => node.type === "section");

/** The ten visual section boxes map to these roadmap topics. */
const SECTION_TOPIC = {
	"VBjI-LQstODfimbRlHUFi": "Components",
	"HLnq8xMeb0NwnkVUtcFMj": "Communication",
	"t6zZwKzPHXT57Uqj4R2aI": "Understand Binding",
	"FTLS0mwJhuqsEHen7mqbk": "Template Syntax",
	"CshWtCCFHbYXtztr-2iU1": "Pipes",
	"Ew6DgOvx6gtifE9v4YPkP": "RxJS Basics",
	"1OFkZp8kqo_f_pTrDqNoe": "Developer Tools",
	"ol_HobKV3LkBYvgVYWoGB": "Security",
	"rikJUpXHGXAEC74Szwj7s": "Security",
	"dnM44vvHZW3dSpsVi546w": "SSG",
};

/** Box assignment plus nearest-topic is mostly right; these labels sit
 *  across a visual gap and need the human correction. */
const MOVES = {
	"Component Anatomy": "Components",
	"Creating Components": "Components",
	"Metadata": "Components",
	"Router Events": "Routing",
	"Guards": "Routing",
	"Observable Lifecycle": "RxJS Basics",
	"RxJS vs Promises": "RxJS Basics",
	"Operators": "RxJS Basics",
	"RxJS Interop": "RxJS Basics",
	"Queries as Signals": "Signals",
	"Model Inputs": "Signals",
	"Writing Interceptors": "HTTP Client",
	"NgRx": "State Management",
	"Hydration": "SSR",
	"AnalogJS": "SSR",
	"Routing": "Accessibility",
	"Link Identification": "Accessibility",
	"Transitions & Triggers": "Animation",
	"Complex Sequences": "Animation",
	"Control Flow": "Template Syntax",
	"@Input & @Output": "Communication",
	"Template Ref Vars": "Templates",
};

/** Six root tracks; each stays within the six-suggestion cap. */
const TRACKS = [
	{ id: "foundations", title: "Foundations", topics: ["Introduction to Angular", "Components", "Communication", "Understand Binding"] },
	{ id: "templates-ui", title: "Templates & UI", topics: ["Templates", "Template Syntax", "Pipes", "Directives"] },
	{ id: "architecture-data", title: "Architecture & Data", topics: ["Modules", "Routing", "Services  & Remote Data", "Forms", "HTTP Client"] },
	{ id: "reactivity-state", title: "Reactivity & State", topics: ["RxJS Basics", "Signals", "State Management", "Zones"] },
	{ id: "platform-tooling", title: "Platform & Tooling", topics: ["Developer Tools", "SSR", "SSG"] },
	{ id: "quality-security", title: "Quality & Security", topics: ["Security", "Accessibility", "Performance", "Testing", "Internationalization", "Animation"] },
];

const slugify = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "topic";
const inside = (node, section) => {
	const x = node.position?.x ?? 0;
	const y = node.position?.y ?? 0;
	return x >= section.position?.x && y >= section.position?.y &&
		x <= section.position.x + section.width && y <= section.position.y + section.height;
};
const distance = (a, b) => Math.hypot((a.position?.x ?? 0) - (b.position?.x ?? 0), (a.position?.y ?? 0) - (b.position?.y ?? 0));

const byLabel = new Map();
for (const topic of topics) byLabel.set(topic.data.label, []);
for (const sub of subtopics) {
	let parent = null;
	for (const box of sections) {
		if (inside(sub, box) && SECTION_TOPIC[box.id]) { parent = SECTION_TOPIC[box.id]; break; }
	}
	if (!parent) {
		let best = null;
		let bestDistance = Infinity;
		for (const topic of topics) {
			const d = distance(sub, topic);
			if (d < bestDistance) { bestDistance = d; best = topic; }
		}
		parent = best?.data.label;
	}
	if (MOVES[sub.data.label]) parent = MOVES[sub.data.label];
	if (parent && byLabel.has(parent)) byLabel.get(parent).push(sub.data.label);
}

const usedTopicIds = new Set();
const topicRecords = new Map();
for (const topic of topics) {
	let id = slugify(topic.data.label);
	while (usedTopicIds.has(id)) id = `${id}-2`;
	usedTopicIds.add(id);
	const children = [...new Set(byLabel.get(topic.data.label) ?? [])];
	const usedChildIds = new Set();
	const childRecords = children.map((label) => {
		let childId = slugify(label);
		while (usedChildIds.has(childId)) childId = `${childId}-2`;
		usedChildIds.add(childId);
		return { id: childId, title: label };
	});
	topicRecords.set(topic.data.label, { id, title: topic.data.label, subtopics: childRecords });
}

const knownTopics = new Set(topics.map((topic) => topic.data.label));
const usedTrackIds = new Set();
const tracks = TRACKS.map((track) => {
	if (usedTrackIds.has(track.id)) throw new Error(`duplicate track id ${track.id}`);
	usedTrackIds.add(track.id);
	const mapped = track.topics.map((title) => {
		if (!knownTopics.has(title)) throw new Error(`track topic not in the roadmap: ${title}`);
		return topicRecords.get(title);
	});
	return {
		id: track.id,
		title: track.title,
		topics: mapped,
	};
});

const dataDir = process.env.LH_DATA_DIR ? path.resolve(process.env.LH_DATA_DIR) : path.join(ROOT, "data");
const output = path.join(dataDir, "roadmaps", `${slug}.json`);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify({
	slug,
	title: roadmap.title?.card ?? roadmap.title?.page ?? slug,
	source: `https://roadmap.sh/${slug}`,
	importedAt: new Date().toISOString(),
	tracks,
}, null, 2)}\n`);

const topicCount = tracks.reduce((n, track) => n + track.topics.length, 0);
const subtopicCount = tracks.reduce((n, track) => n + track.topics.reduce((m, topic) => m + topic.subtopics.length, 0), 0);
console.log(`[roadmap] ${roadmap.title?.card ?? slug}: ${tracks.length} tracks, ${topicCount} topics, ${subtopicCount} subtopics -> ${output}`);

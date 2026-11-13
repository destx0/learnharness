#!/usr/bin/env node
/**
 * Import roadmap.sh roadmaps into local read-mode presets.
 *
 *   node scripts/import-roadmap.mjs angular   # one roadmap
 *   node scripts/import-roadmap.mjs all       # every catalog roadmap
 *
 * roadmap.sh exposes the official roadmap graph at
 * /api/v1-official-roadmap/<slug> (the same data its page renders). The
 * graph is visual, not a tree: this script imposes the read-mode tree. The
 * Angular roadmap has a curated track/subtopic mapping; every other roadmap
 * uses the visual group boxes + nearest-topic fallback. Only labels and
 * hierarchy are stored; the guide prose is written by the read agent.
 *
 * `all` reads data/roadmaps/catalog.json (run
 * scripts/import-roadmap-catalog.mjs first). The output lives under the
 * mutable data dir (data/roadmaps/, gitignored), never in the source tree.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const requested = (process.argv[2] || "angular").toLowerCase();
const dataDir = process.env.LH_DATA_DIR ? path.resolve(process.env.LH_DATA_DIR) : path.join(ROOT, "data");
const catalogFile = path.join(dataDir, "roadmaps", "catalog.json");

function readCatalog() {
	try {
		const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf-8"));
		if (!Array.isArray(catalog.roadmaps)) throw new Error("no roadmaps array");
		return catalog;
	} catch (err) {
		throw new Error(`Cannot read ${catalogFile}: ${err instanceof Error ? err.message : err}. Run: npm run roadmap:catalog`);
	}
}

const slugify = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "topic";
const distance = (a, b) => Math.hypot((a.position?.x ?? 0) - (b.position?.x ?? 0), (a.position?.y ?? 0) - (b.position?.y ?? 0));

/** Curated Angular mapping (2026-11-12). */
const ANGULAR_SECTION_TOPIC = {
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
const ANGULAR_MOVES = {
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
const ANGULAR_TRACKS = [
	{ id: "foundations", title: "Foundations", topics: ["Introduction to Angular", "Components", "Communication", "Understand Binding"] },
	{ id: "templates-ui", title: "Templates & UI", topics: ["Templates", "Template Syntax", "Pipes", "Directives"] },
	{ id: "architecture-data", title: "Architecture & Data", topics: ["Modules", "Routing", "Services  & Remote Data", "Forms", "HTTP Client"] },
	{ id: "reactivity-state", title: "Reactivity & State", topics: ["RxJS Basics", "Signals", "State Management", "Zones"] },
	{ id: "platform-tooling", title: "Platform & Tooling", topics: ["Developer Tools", "SSR", "SSG"] },
	{ id: "quality-security", title: "Quality & Security", topics: ["Security", "Accessibility", "Performance", "Testing", "Internationalization", "Animation"] },
];

function uniqueId(base, used) {
	let id = slugify(base);
	while (used.has(id)) id = `${id}-2`;
	used.add(id);
	return id;
}

function childRecords(labels, used) {
	return [...new Set(labels)].map((label) => ({ id: uniqueId(label, used), title: label }));
}

function curatedAngular(nodes) {
	const topics = nodes.filter((node) => node.type === "topic" && node.data?.label);
	const subtopics = nodes.filter((node) => node.type === "subtopic" && node.data?.label);
	const sections = nodes.filter((node) => node.type === "section");
	const inside = (node, section) => {
		const x = node.position?.x ?? 0;
		const y = node.position?.y ?? 0;
		return x >= section.position?.x && y >= section.position?.y &&
			x <= section.position.x + section.width && y <= section.position.y + section.height;
	};
	const byLabel = new Map(topics.map((topic) => [topic.data.label, []]));
	for (const sub of subtopics) {
		let parent = null;
		for (const box of sections) {
			if (inside(sub, box) && ANGULAR_SECTION_TOPIC[box.id]) { parent = ANGULAR_SECTION_TOPIC[box.id]; break; }
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
		if (ANGULAR_MOVES[sub.data.label]) parent = ANGULAR_MOVES[sub.data.label];
		if (parent && byLabel.has(parent)) byLabel.get(parent).push(sub.data.label);
	}
	const usedTopicIds = new Set();
	const records = new Map();
	for (const topic of topics) {
		const id = uniqueId(topic.data.label, usedTopicIds);
		records.set(topic.data.label, {
			id,
			title: topic.data.label,
			subtopics: childRecords(byLabel.get(topic.data.label) ?? [], new Set()),
		});
	}
	const known = new Set(records.keys());
	const usedTrackIds = new Set();
	return ANGULAR_TRACKS.map((track) => {
		const id = uniqueId(track.id, usedTrackIds);
		const mapped = track.topics.map((title) => {
			if (!known.has(title)) throw new Error(`curated track topic not in the roadmap: ${title}`);
			return records.get(title);
		});
		return { id, title: track.title, topics: mapped };
	});
}

/** Generic mapping for every other roadmap: sort topics by the visual flow
 *  and attach each subtopic to its nearest topic. One track; the map's
 *  track label is the roadmap title. */
function genericTracks(nodes, roadmap, slug) {
	const topics = nodes.filter((node) => node.type === "topic" && node.data?.label);
	const subtopics = nodes.filter((node) => node.type === "subtopic" && node.data?.label);
	const orderedTopics = [...topics].sort((a, b) =>
		(a.position?.y ?? 0) - (b.position?.y ?? 0) || (a.position?.x ?? 0) - (b.position?.x ?? 0),
	);
	const synthetic = orderedTopics.length === 0;
	const topicNodes = synthetic
		? [{ data: { label: roadmap.title?.card ?? slug }, position: { x: 0, y: 0 } }]
		: orderedTopics;
	const usedTopicIds = new Set();
	const groups = new Map(topicNodes.map((topic) => [topic.data.label, []]));
	for (const sub of subtopics) {
		if (synthetic) {
			groups.get(topicNodes[0].data.label).push(sub.data.label);
			continue;
		}
		let best = null;
		let bestDistance = Infinity;
		for (const topic of topicNodes) {
			const d = distance(sub, topic);
			if (d < bestDistance) { bestDistance = d; best = topic; }
		}
		if (best) groups.get(best.data.label).push(sub.data.label);
	}
	const usedSubIds = new Map();
	const mapped = topicNodes.map((topic) => {
		const id = uniqueId(topic.data.label, usedTopicIds);
		if (!usedSubIds.has(id)) usedSubIds.set(id, new Set());
		return {
			id,
			title: topic.data.label,
			subtopics: childRecords(groups.get(topic.data.label) ?? [], usedSubIds.get(id)),
		};
	});
	return [{ id: "roadmap", title: roadmap.title?.card ?? slug, topics: mapped }];
}

function dataset(slug, roadmap) {
	const nodes = Array.isArray(roadmap.nodes) ? roadmap.nodes : [];
	const tracks = slug === "angular" ? curatedAngular(nodes) : genericTracks(nodes, roadmap, slug);
	return {
		slug,
		title: roadmap.title?.card ?? roadmap.title?.page ?? slug,
		source: `https://roadmap.sh/${slug}`,
		importedAt: new Date().toISOString(),
		tracks,
	};
}

async function importOne(slug) {
	const response = await fetch(`https://roadmap.sh/api/v1-official-roadmap/${slug}`);
	if (!response.ok) throw new Error(`roadmap.sh returned ${response.status}`);
	const roadmap = await response.json();
	const data = dataset(slug, roadmap);
	const output = path.join(dataDir, "roadmaps", `${slug}.json`);
	fs.mkdirSync(path.dirname(output), { recursive: true });
	fs.writeFileSync(output, `${JSON.stringify(data, null, 2)}\n`);
	const topicCount = data.tracks.reduce((n, track) => n + track.topics.length, 0);
	const subtopicCount = data.tracks.reduce((n, track) => n + track.topics.reduce((m, topic) => m + topic.subtopics.length, 0), 0);
	return { slug, title: data.title, tracks: data.tracks.length, topicCount, subtopicCount, output };
}

const catalog = requested === "all" ? readCatalog() : null;
const slugs = catalog ? catalog.roadmaps.map((roadmap) => roadmap.slug) : [requested];
const failures = [];
for (const slug of slugs) {
	try {
		const result = await importOne(slug);
		console.log(`[roadmap] ${result.title}: ${result.tracks} tracks, ${result.topicCount} topics, ${result.subtopicCount} subtopics -> ${result.output}`);
	} catch (err) {
		failures.push({ slug, message: err instanceof Error ? err.message : String(err) });
		console.error(`[roadmap] ${slug}: ${failures.at(-1).message}`);
	}
}
if (catalog) {
	console.log(`[roadmap] imported ${slugs.length - failures.length}/${slugs.length} catalog roadmaps`);
	if (failures.length > 0) {
		console.error(`[roadmap] ${failures.length} failed: ${failures.map((failure) => failure.slug).join(", ")}`);
		process.exitCode = 1;
	}
}

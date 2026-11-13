#!/usr/bin/env node
/**
 * Import roadmap.sh's roadmap catalog (labels only) for the read-mode quick
 * start / jump surface. Writes data/roadmaps/catalog.json under the mutable
 * data dir; never commit the generated data.
 *
 *   node scripts/import-roadmap-catalog.mjs
 *
 * The /roadmaps page carries a single React Router single-fetch stream. The
 * decoder below is the small reference resolver for that JSON-like stream
 * (keys `_N` point at the value table; negative indexes count from the end).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const response = await fetch("https://roadmap.sh/roadmaps");
if (!response.ok) throw new Error(`roadmap.sh returned ${response.status}`);
const html = await response.text();
const match = /streamController\.enqueue\(("(?:[^"\\]|\\.)*")\)/.exec(html);
if (!match) throw new Error("roadmap.sh catalog payload not found");

const table = JSON.parse(JSON.parse(match[1]));
const memo = new Map();
function resolve(ref, depth = 0) {
	if (depth > 300) throw new Error("catalog payload too deep");
	if (typeof ref !== "number") return ref;
	const index = ref < 0 ? table.length + ref : ref;
	if (index < 0 || index >= table.length) return ref;
	if (memo.has(index)) return memo.get(index);
	const value = table[index];
	let out;
	if (Array.isArray(value)) {
		out = value.map((entry) => resolve(entry, depth + 1));
	} else if (value && typeof value === "object") {
		out = {};
		for (const [key, entry] of Object.entries(value)) {
			const name = key.startsWith("_") && /^\d+$/.test(key.slice(1))
				? resolve(Number(key.slice(1)), depth + 1)
				: key;
			out[name] = resolve(entry, depth + 1);
		}
	} else {
		out = value;
	}
	memo.set(index, out);
	return out;
}

const root = resolve(0);
const loader = root.loaderData?.["routes/roadmaps._index"] ?? Object.values(root.loaderData ?? {})[0];
if (!loader || !Array.isArray(loader.categories)) throw new Error("roadmap.sh catalog categories not found");

const categories = loader.categories
	.filter((category) => category && typeof category.title === "string" && Array.isArray(category.subCategories))
	.map((category) => ({
		title: category.title,
		subCategories: category.subCategories
			.filter((sub) => sub && typeof sub.title === "string" && Array.isArray(sub.roadmaps))
			.map((sub) => ({
				title: sub.title,
				roadmaps: sub.roadmaps
					.filter((roadmap) => roadmap && typeof roadmap.slug === "string" && typeof roadmap.title === "string")
					.map((roadmap) => ({
						slug: roadmap.slug,
						title: roadmap.title,
						type: typeof roadmap.type === "string" ? roadmap.type : "skill",
					})),
			})),
	}));

const flat = new Map();
// Prefer a specific category badge; the first "All Roadmaps" bucket would
// otherwise label nearly every card with the catch-all.
const ordered = [
	...categories.filter((category) => category.title !== "All Roadmaps"),
	...categories.filter((category) => category.title === "All Roadmaps"),
];
for (const category of ordered) {
	for (const sub of category.subCategories) {
		for (const roadmap of sub.roadmaps) {
			if (!flat.has(roadmap.slug)) {
				flat.set(roadmap.slug, {
					...roadmap,
					category: category.title,
					subcategory: sub.title,
				});
			}
		}
	}
}

const dataDir = process.env.LH_DATA_DIR ? path.resolve(process.env.LH_DATA_DIR) : path.join(ROOT, "data");
const output = path.join(dataDir, "roadmaps", "catalog.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify({
	source: "https://roadmap.sh/roadmaps",
	importedAt: new Date().toISOString(),
	categories,
	roadmaps: [...flat.values()].sort((a, b) => a.title.localeCompare(b.title)),
}, null, 2)}\n`);

console.log(`[roadmap-catalog] ${flat.size} roadmaps -> ${output}`);

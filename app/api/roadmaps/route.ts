import { listChats, readRoadmapCatalog, roadmapPresetSlugs } from "@/src/server";

export const dynamic = "force-dynamic";

/** roadmap.sh's catalog for the read quick start / jump surface. Each row
 *  also says whether a graph preset is imported and whether a read session
 *  already exists for it (newest first, so the first match wins). */
export async function GET() {
	const catalog = readRoadmapCatalog();
	if (!catalog) {
		return Response.json({ roadmaps: [], categories: [], missing: true });
	}
	const presets = roadmapPresetSlugs();
	const existing = new Map<string, string>();
	for (const chat of listChats()) {
		if (chat.kind !== "read" || !chat.roadmapSlug || existing.has(chat.roadmapSlug)) continue;
		existing.set(chat.roadmapSlug, chat.id);
	}
	return Response.json({
		source: catalog.source,
		importedAt: catalog.importedAt,
		categories: catalog.categories,
		roadmaps: catalog.roadmaps.map((roadmap) => ({
			...roadmap,
			preset: presets.has(roadmap.slug),
			existingChatId: existing.get(roadmap.slug) ?? null,
		})),
	});
}

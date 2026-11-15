import { bodyString, enqueueReadWriter, readRouteChapter, readRouteContext } from "@/src/server";

/** "Refresh directions" on a chapter: a background writer replaces its
 *  agent-authored deeper directions (roadmap subtopics are kept). Never a
 *  chat turn, so it runs beside whatever else is writing. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const ctx = await readRouteContext(req, id);
	if (ctx instanceof Response) return ctx;
	const chapter = readRouteChapter(ctx.docs, bodyString(ctx.body, "documentId"), bodyString(ctx.body, "sectionId"));
	if (!chapter) return Response.json({ error: "No such chapter" }, { status: 400 });
	const queued = enqueueReadWriter(
		id,
		{ kind: "directions", documentId: chapter.document.id, sectionId: chapter.section.id },
		`Directions · ${chapter.section.heading}`,
		{ retry: true },
	);
	return Response.json({ ok: true, ...queued });
}

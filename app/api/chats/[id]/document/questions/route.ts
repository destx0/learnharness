import { bodyString, enqueueReadWriter, readRouteChapter, readRouteContext } from "@/src/server";

/** "Generate more questions" / "Add questions": a background writer appends
 *  2–3 new self-check questions to the chapter, keeping the existing set. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const ctx = await readRouteContext(req, id);
	if (ctx instanceof Response) return ctx;
	const chapter = readRouteChapter(ctx.docs, bodyString(ctx.body, "documentId"), bodyString(ctx.body, "sectionId"));
	if (!chapter) return Response.json({ error: "No such chapter" }, { status: 400 });
	const queued = enqueueReadWriter(
		id,
		{ kind: "questions", documentId: chapter.document.id, sectionId: chapter.section.id },
		`Questions · ${chapter.section.heading}`,
		{ retry: true },
	);
	return Response.json({ ok: true, ...queued });
}

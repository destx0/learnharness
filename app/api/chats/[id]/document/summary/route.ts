import { bodyString, enqueueReadWriter, readRouteChapter, readRouteContext } from "@/src/server";

/** A roadmap topic's lazy summary (2026-11-15): the pane asks for it when
 *  the learner opens a seed section. Idempotent — a section already
 *  written, or already being written, answers without queueing. A recent
 *  failure is reported instead of re-firing unless `retry` is set (the
 *  learner's explicit Retry). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const ctx = await readRouteContext(req, id);
	if (ctx instanceof Response) return ctx;
	const chapter = readRouteChapter(ctx.docs, bodyString(ctx.body, "documentId"), bodyString(ctx.body, "sectionId"));
	if (!chapter) return Response.json({ error: "No such chapter" }, { status: 400 });
	if (!chapter.section.seed) return Response.json({ ok: true, written: true });
	const queued = enqueueReadWriter(
		id,
		{ kind: "summary", documentId: chapter.document.id, sectionId: chapter.section.id },
		`Summary · ${chapter.section.heading}`,
		{ retry: ctx.body.retry === true },
	);
	return Response.json({ ok: true, ...queued });
}

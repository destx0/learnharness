import { bodyString, readRouteContext, stores } from "@/src/server";
import { studyDocumentById } from "@/src/core";

/** Remember which document the learner has open (read sessions). The next
 *  chat turn pins it as its edit target. View state only: no turn, no
 *  document event, no updatedAt bump. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const ctx = await readRouteContext(req, id);
	if (ctx instanceof Response) return ctx;
	const documentId = bodyString(ctx.body, "documentId");
	if (!documentId || !studyDocumentById(ctx.docs, documentId)) {
		return Response.json({ error: "No such study document" }, { status: 400 });
	}
	try {
		stores.chatStore.saveReadingDocumentId(id, documentId);
	} catch {
		return Response.json({ error: "No such study document" }, { status: 400 });
	}
	return Response.json({ ok: true, documentId });
}

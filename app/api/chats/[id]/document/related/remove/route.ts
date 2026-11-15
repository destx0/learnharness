import { bodyString, readRouteContext, stores, withDocumentLock } from "@/src/server";
import { emit, removeStudyRelatedLink, studyDocumentById } from "@/src/core";

/** Remove one agent-authored related-topic link from the reading footer.
 *  A direct store edit (no model call): cross-links are navigation, not
 *  prose, and a wrong link should not cost a turn. Serialized with the
 *  session's document writers so a concurrent write cannot undo it. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const ctx = await readRouteContext(req, id);
	if (ctx instanceof Response) return ctx;
	const documentId = bodyString(ctx.body, "documentId");
	const targetDocumentId = bodyString(ctx.body, "targetDocumentId");
	const targetSectionId = bodyString(ctx.body, "targetSectionId") || undefined;
	if (!targetDocumentId) return Response.json({ error: "No such related link" }, { status: 400 });
	return withDocumentLock(id, async () => {
		const document = studyDocumentById(stores.chatStore.readDocuments(id), documentId);
		if (!document) return Response.json({ error: "No such related link" }, { status: 400 });
		const next = removeStudyRelatedLink(document, targetDocumentId, targetSectionId);
		if (next === document) return Response.json({ error: "No such related link" }, { status: 400 });
		stores.chatStore.saveDocument(id, next);
		emit("document-changed", { chatId: id, documentId: next.id });
		return Response.json({ ok: true });
	});
}

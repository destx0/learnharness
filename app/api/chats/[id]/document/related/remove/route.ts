import { stores } from "@/src/server";
import { emit, removeStudyRelatedLink, studyDocumentById } from "@/src/core";

/** Remove one agent-authored related-topic link from the reading footer.
 *  A direct store edit (no model call): cross-links are navigation, not
 *  prose, and a wrong link should not cost a turn. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	let body: { documentId?: unknown; targetDocumentId?: unknown; targetSectionId?: unknown };
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const record = stores.chatStore.getChat(id);
	if (!record) return Response.json({ error: "Not found" }, { status: 404 });
	if (record.kind !== "read") return Response.json({ error: "Not a reading session" }, { status: 400 });
	const documentId = typeof body.documentId === "string" ? body.documentId : "";
	const targetDocumentId = typeof body.targetDocumentId === "string" ? body.targetDocumentId : "";
	const targetSectionId = typeof body.targetSectionId === "string" ? body.targetSectionId : undefined;
	const document = studyDocumentById(record, documentId);
	if (!document || !targetDocumentId) return Response.json({ error: "No such related link" }, { status: 400 });
	const next = removeStudyRelatedLink(document, targetDocumentId, targetSectionId);
	if (next === document) return Response.json({ error: "No such related link" }, { status: 400 });
	stores.chatStore.saveDocument(id, next);
	emit("document-changed", { chatId: id, documentId: next.id });
	return Response.json({ ok: true });
}

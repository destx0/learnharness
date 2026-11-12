import { stores } from "@/src/server";
import { studyDocumentById } from "@/src/core";

/** Remember which document the floating chat steers (read sessions). View
 *  state only: no turn, no document event, no updatedAt bump. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	let body: { documentId?: unknown };
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const documentId = typeof body.documentId === "string" ? body.documentId : "";
	const record = stores.chatStore.getChat(id);
	if (!record) return Response.json({ error: "Not found" }, { status: 404 });
	if (record.kind !== "read") return Response.json({ error: "Not a reading session" }, { status: 400 });
	if (!documentId || !studyDocumentById(record, documentId)) {
		return Response.json({ error: "No such study document" }, { status: 400 });
	}
	try {
		stores.chatStore.saveReadingDocumentId(id, documentId);
	} catch {
		return Response.json({ error: "No such study document" }, { status: 400 });
	}
	return Response.json({ ok: true, documentId });
}

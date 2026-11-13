import { handleChatInput, stores } from "@/src/server";
import { studyDocumentById } from "@/src/core";

/** "Generate more questions" in a chapter's self-check accordion: start the
 *  read turn that appends 2–3 new questions to the existing set. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	let body: { documentId?: unknown; sectionId?: unknown };
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const record = stores.chatStore.getChat(id);
	if (!record) return Response.json({ error: "Not found" }, { status: 404 });
	if (record.kind !== "read") return Response.json({ error: "Not a reading session" }, { status: 400 });
	const documentId = typeof body.documentId === "string" ? body.documentId : "";
	const sectionId = typeof body.sectionId === "string" ? body.sectionId : "";
	const document = studyDocumentById(record, documentId);
	if (!document || !document.sections.some((section) => section.id === sectionId)) {
		return Response.json({ error: "No such chapter" }, { status: 400 });
	}
	return handleChatInput(id, { type: "more-questions", documentId: document.id, sectionId });
}

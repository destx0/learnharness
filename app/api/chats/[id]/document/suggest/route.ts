import { handleChatInput, stores } from "@/src/server";
import { studyDocumentById } from "@/src/core";

/** "Go deeper" pressed on a chapter: start the agent turn that proposes
 *  directions. Suggestions are generated on click (owner 2026-11-12), not
 *  authored with every chapter, so this is the one model call that makes
 *  the chips appear. The turn runs as the usual background object. */
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
	return handleChatInput(id, { type: "suggest-deeper", documentId: document.id, sectionId });
}

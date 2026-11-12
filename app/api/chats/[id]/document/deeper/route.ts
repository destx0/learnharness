import { handleChatInput, stores } from "@/src/server";
import {
	createChildStudyDocument,
	emit,
	StudyDocumentError,
	studyDocumentById,
	studyDocumentChildForTopic,
	studyDocumentTopic,
	type ChatRecord,
	type StudyDocument,
} from "@/src/core";

function childState(record: ChatRecord | null, childId: string): StudyDocument | null {
	return record ? studyDocumentById(record, childId) : null;
}

/** A deeper topic was chosen. Create (or reopen) the child document, make
 *  it the active document immediately, then start the writer turn. The
 *  child opens in the pane before its first section lands; the turn fills
 *  it through edit_document, and settlement marks it ready/failed. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	let body: { documentId?: unknown; sectionId?: unknown; topicId?: unknown };
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
	const topicId = typeof body.topicId === "string" ? body.topicId : "";
	const parent = studyDocumentById(record, documentId);
	const found = parent ? studyDocumentTopic(parent, sectionId, topicId) : null;
	if (!parent || !found) return Response.json({ error: "No such deeper-topic suggestion" }, { status: 400 });

	let child = studyDocumentChildForTopic(record, documentId, sectionId, topicId);
	if (child) {
		stores.chatStore.saveReadingDocumentId(id, child.id);
		if (child.status === "writing" || child.status === "ready") {
			return Response.json({ childDocument: child, started: false });
		}
		// Retry a failed (empty) child with the same id.
		child = { ...child, status: "writing", updatedAt: new Date().toISOString() };
		stores.chatStore.saveDocument(id, child);
		emit("document-changed", { chatId: id, documentId: child.id });
	} else {
		try {
			child = createChildStudyDocument(
				record,
				parent.id,
				sectionId,
				topicId,
				`doc_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
			);
		} catch (err) {
			if (err instanceof StudyDocumentError) return Response.json({ error: err.message }, { status: 400 });
			throw err;
		}
		stores.chatStore.saveDocument(id, child);
		stores.chatStore.saveReadingDocumentId(id, child.id);
		emit("document-changed", { chatId: id, documentId: child.id });
	}

	const response = await handleChatInput(id, {
		type: "go-deeper",
		documentId: parent.id,
		sectionId,
		topicId,
		childDocumentId: child.id,
	});
	if (!response.ok) {
		// The turn never started (busy/refused): never leave a phantom writer.
		const current = childState(stores.chatStore.getChat(id), child.id) ?? child;
		const failed: StudyDocument = {
			...current,
			status: current.sections.length > 0 ? "ready" : "failed",
			updatedAt: new Date().toISOString(),
		};
		stores.chatStore.saveDocument(id, failed);
		emit("document-changed", { chatId: id, documentId: failed.id });
		return response;
	}
	return Response.json({ childDocument: childState(stores.chatStore.getChat(id), child.id), started: true });
}

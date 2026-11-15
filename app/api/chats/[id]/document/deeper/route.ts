import {
	bodyString,
	enqueueReadWriter,
	readRoadmap,
	readRouteContext,
	roadmapSubtopicContext,
	stores,
	withDocumentLock,
} from "@/src/server";
import {
	createChildStudyDocument,
	emit,
	StudyDocumentError,
	studyDocumentById,
	studyDocumentChildForTopic,
	studyDocumentTopic,
	type StudyDocument,
} from "@/src/core";

/** A deeper topic was chosen (2026-11-12; parallel writers 2026-11-15).
 *  Create (or reopen) the child document, make it the reading document
 *  immediately, and queue a background writer for it. Never a chat turn:
 *  any number of deep dives can be requested while the conversation (or
 *  other writers) are busy; the queue runs up to eight per session. The
 *  child opens in the pane in its writing state and its sections stream
 *  in as the writer's edits land. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const ctx = await readRouteContext(req, id);
	if (ctx instanceof Response) return ctx;
	const documentId = bodyString(ctx.body, "documentId");
	const sectionId = bodyString(ctx.body, "sectionId");
	const topicId = bodyString(ctx.body, "topicId");

	const outcome = await withDocumentLock(id, async (): Promise<{ child: StudyDocument; start: boolean } | Response> => {
		const docs = stores.chatStore.readDocuments(id);
		const parent = studyDocumentById(docs, documentId);
		const found = parent ? studyDocumentTopic(parent, sectionId, topicId) : null;
		if (!parent || !found) return Response.json({ error: "No such deeper-topic suggestion" }, { status: 400 });
		const existing = studyDocumentChildForTopic(docs, documentId, sectionId, topicId);
		if (existing && existing.status !== "failed") return { child: existing, start: existing.status === "writing" };
		let child: StudyDocument;
		if (existing) {
			// Retry a failed (empty) child under the same id.
			child = { ...existing, status: "writing", updatedAt: new Date().toISOString() };
		} else {
			try {
				child = createChildStudyDocument(
					docs,
					parent.id,
					sectionId,
					topicId,
					`doc_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
				);
			} catch (err) {
				if (err instanceof StudyDocumentError) return Response.json({ error: err.message }, { status: 400 });
				throw err;
			}
		}
		stores.chatStore.saveDocument(id, child);
		emit("document-changed", { chatId: id, documentId: child.id });
		return { child, start: true };
	});
	if (outcome instanceof Response) return outcome;

	const { child } = outcome;
	stores.chatStore.saveReadingDocumentId(id, child.id);
	if (outcome.start && child.parent) {
		const parent = studyDocumentById(stores.chatStore.readDocuments(id), child.parent.documentId);
		const topic = parent ? studyDocumentTopic(parent, child.parent.sectionId, child.parent.topicId)?.topic : undefined;
		const roadmap = topic?.roadmap ? readRoadmap(topic.roadmap.slug) : null;
		const roadmapContext = roadmap && topic?.roadmap ? roadmapSubtopicContext(roadmap, topic.roadmap.nodeId) : "";
		enqueueReadWriter(
			id,
			{
				kind: "deep-dive",
				documentId: child.id,
				parent: child.parent,
				...(roadmapContext ? { roadmapContext } : {}),
			},
			`Deep dive · ${child.title}`,
			{ retry: true },
		);
	}
	return Response.json({ childDocument: stores.chatStore.getDocument(id, child.id) ?? child, started: outcome.start });
}

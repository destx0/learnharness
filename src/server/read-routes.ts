import type { ChatRecord, StudyDocument, StudyDocumentSet } from "../core/contracts.ts";
import { STUDY_ROOT_DOCUMENT_ID, studyDocumentById, studyDocumentList, studyDocumentSkeleton } from "../core/study-document.ts";
import { readWriterStatus } from "./read-writers.ts";
import { stores } from "./stores.ts";

export { withDocumentLock } from "../agent/tools/document.ts";

/**
 * The read routes' shared preamble (2026-11-15): parse the JSON body, load
 * the session, insist it is a reading session, and load its documents.
 * Returns a ready Response on any refusal so each route stays a few lines.
 */
export async function readRouteContext(
	req: Request,
	chatId: string,
): Promise<{ record: ChatRecord; docs: StudyDocumentSet; body: Record<string, unknown> } | Response> {
	let body: Record<string, unknown>;
	try {
		const parsed = await req.json();
		body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const record = stores.chatStore.getChat(chatId);
	if (!record) return Response.json({ error: "Not found" }, { status: 404 });
	if (record.kind !== "read") return Response.json({ error: "Not a reading session" }, { status: 400 });
	return { record, docs: stores.chatStore.readDocuments(chatId), body };
}

export function bodyString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	return typeof value === "string" ? value : "";
}

/** The chapter a click names, or null. */
export function readRouteChapter(docs: StudyDocumentSet, documentId: string, sectionId: string): { document: StudyDocument; section: StudyDocument["sections"][number] } | null {
	const document = studyDocumentById(docs, documentId);
	const section = document?.sections.find((candidate) => candidate.id === sectionId);
	return document && section ? { document, section } : null;
}

/** What the reading pane loads: every document as a skeleton, the shown
 *  document in full (the requested one, else the reading document, else
 *  the root), and the session's writer state. Shared by the page's first
 *  render and GET /api/chats/[id]/document. */
export function readPaneSnapshot(chatId: string, requested?: string | null) {
	const record = stores.chatStore.getChat(chatId);
	const docs = stores.chatStore.readDocuments(chatId);
	const all = studyDocumentList(docs);
	const fullId = [requested, record?.readingDocumentId, STUDY_ROOT_DOCUMENT_ID]
		.find((candidate) => candidate && all.some((doc) => doc.id === candidate)) ?? all[0]?.id;
	return {
		documents: all.map((doc) => doc.id === fullId ? doc : studyDocumentSkeleton(doc)),
		fullDocumentId: fullId ?? null,
		readingDocumentId: record?.readingDocumentId ?? null,
		writers: readWriterStatus(chatId),
	};
}

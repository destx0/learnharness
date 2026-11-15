import type { ChatStore } from "../core/ports.ts";
import type { StudyDocumentStatus } from "../core/contracts/chat.ts";
import { studyDocumentList } from "../core/study-document.ts";
import { emit } from "../core/events.ts";
import { readWriterActive } from "./read-writers.ts";

/**
 * Deep-document crash recovery (read sessions, 2026-11-12; writers
 * 2026-11-15).
 *
 * A child document is created with status "writing" when the learner picks
 * a suggestion, and a background writer fills it; the writer queue settles
 * it ready/failed when the writer stops. A process that died mid-write
 * leaves the child "writing" with no writer behind it. The pane's document
 * read is the honest moment to finalize such orphans: content means ready,
 * nothing means failed (the pane offers Retry). A document a writer is
 * still queued or running on is never touched, and a just-created child
 * gets a short grace period (its writer is queued synchronously, but the
 * age guard keeps a racing read honest).
 */
export function finalizeReadDocuments(chatStore: ChatStore, chatId: string): void {
	const record = chatStore.getChat(chatId);
	if (!record || record.kind !== "read") return;
	for (const doc of studyDocumentList(chatStore.readDocuments(chatId))) {
		if (doc.status !== "writing") continue;
		if (readWriterActive(chatId, doc.id)) continue;
		const age = Date.now() - Date.parse(doc.updatedAt);
		if (Number.isFinite(age) && age < 30_000) continue;
		const status: StudyDocumentStatus = doc.sections.length > 0 ? "ready" : "failed";
		chatStore.saveDocument(chatId, { ...doc, status, updatedAt: new Date().toISOString() });
		emit("document-changed", { chatId, documentId: doc.id });
	}
}

import type { ChatStore } from "../core/ports.ts";
import type { StudyDocumentStatus } from "../core/contracts/chat.ts";
import { studyDocumentList } from "../core/study-document.ts";
import { emit } from "../core/events.ts";

/**
 * Deep-document settlement (read sessions, 2026-11-12).
 *
 * A child document is created with status "writing" when the learner picks
 * a suggestion; the turn then fills it through edit_document. Turn
 * settlement is the only honest "the writer stopped" signal this process
 * has, so finalize there: content means ready, nothing means failed (the
 * pane offers Retry). Runs before endTurn's turn-settled event, so a pane
 * refetch on that event reads the final status.
 */
export function finalizeReadDocuments(chatStore: ChatStore, chatId: string): void {
	const record = chatStore.getChat(chatId);
	if (!record || record.kind !== "read") return;
	for (const doc of studyDocumentList(record)) {
		if (doc.status !== "writing") continue;
		const status: StudyDocumentStatus = doc.sections.length > 0 ? "ready" : "failed";
		const next = { ...doc, status, updatedAt: new Date().toISOString() };
		chatStore.saveDocument(chatId, next);
		emit("document-changed", { chatId, documentId: next.id });
	}
}

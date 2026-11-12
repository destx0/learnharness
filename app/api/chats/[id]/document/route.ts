import { finalizeReadDocuments, getChat, isTurnRunning, stores } from "@/src/server";

/** The read pane's document read (read sessions, 2026-11-04; deeper tree
 *  2026-11-12). A tiny dedicated route on purpose: document-changed fires
 *  after every edit, and the pane needs the documents WITHOUT refetching
 *  the whole transcript (which the chat view owns and guards against
 *  mid-stream adoption). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	// Crash recovery: a child created "writing" when the process died has no
	// turn left to settle it. A read with nothing running is the honest
	// moment to mark it ready/failed, before the pane decides what to show.
	if (!isTurnRunning(id)) finalizeReadDocuments(stores.chatStore, id, { staleOnly: true });
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({
		document: chat.document ?? null,
		documents: chat.documents ?? [],
		readingDocumentId: chat.readingDocumentId ?? null,
	});
}

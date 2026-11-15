import { finalizeReadDocuments, getChat, readPaneSnapshot, stores } from "@/src/server";

/** The read pane's document read (read sessions, 2026-11-04; deeper tree
 *  2026-11-12; per-document files and writers 2026-11-15).
 *
 *  Returns every document as a SKELETON (structure, suggestions, question
 *  prompts — no bodies or answers) plus the one document the pane shows in
 *  full: `?documentId=` when given, else the learner's reading document.
 *  `writers` is the session's background-writer state (queued, running,
 *  recently failed) so the pane can show per-chapter writing and Retry.
 *  document-changed fires after every write, so this stays small: a
 *  500-document session never ships 500 bodies per refresh. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	// Crash recovery: a child left "writing" by a dead process has no writer
	// behind it; finalize it before the pane decides what to show.
	finalizeReadDocuments(stores.chatStore, id);
	return Response.json(readPaneSnapshot(id, new URL(req.url).searchParams.get("documentId")));
}

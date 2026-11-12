import { getChat } from "@/src/server";

/** The read pane's document read (read sessions, 2026-11-04). A tiny
 *  dedicated route on purpose: document-changed fires after every edit, and
 *  the pane needs the document WITHOUT refetching the whole transcript
 *  (which the chat view owns and guards against mid-stream adoption). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ document: chat.document ?? null });
}

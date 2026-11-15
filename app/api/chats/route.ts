import { chainsForSelection, formatChainLine } from "@/src/core";
import { newGraphContextMessage, newReadChapterMessage, studyDocumentById, type GraphContextPick, type LhMessage } from "@/src/core";
import { compactionInFlight, createChat, isTurnRunning, listChats, readSettingsRecord, seedRoadmapForChat, stores, titleFromPrompt } from "@/src/server";
import type { ChatListItem } from "@/src/core";

/** The session picker's list: record-derived summaries (phase, pending
 *  question) + live liveness — a running turn marks the session busy
 *  (contracts.ts ChatListItem; the store can't see liveness, the route is
 *  the merge point). Owner, minimal-color round: background jobs NO LONGER
 *  count — the sidebar's Background agents section is their channel now
 *  (a running spinner per row would double-signal them), so busy means
 *  exactly "a teach turn is in flight". */
export async function GET() {
	const chats: ChatListItem[] = listChats().map((c) => ({
		...c,
		busy: isTurnRunning(c.id),
		compacting: compactionInFlight(c.id),
	}));
	return Response.json({ chats });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { title?: unknown; kind?: unknown; graphContext?: unknown; roadmapSlug?: unknown; readChapter?: unknown };
	const title = typeof body.title === "string" ? body.title : "";
	const roadmapSlug = typeof body.roadmapSlug === "string" && /^[a-z0-9-]+$/.test(body.roadmapSlug) ? body.roadmapSlug : undefined;
	// Practice sessions (owner, 2026-10-04) and read sessions (2026-11-04):
	// the kind marks the record — each builds its own agent from turn 1.
	// "teach" stays ABSENT (absence reads as teach, no migration).
	const kind =
		body.kind === "practice"
			? ("practice" as const)
			: body.kind === "read"
				? ("read" as const)
				: undefined;
	const chat = createChat(titleFromPrompt(title || "Untitled session"), kind);
	// A read session started from a roadmap card (an explicit slug) begins
	// with the root seeded from the imported roadmap: every main topic as a
	// lazy section, its subtopics as suggestions. Typed topics never seed —
	// matching them against roadmap names hijacked specific questions into
	// whole-subject roadmaps (2026-11-15).
	if (kind === "read" && roadmapSlug) seedRoadmapForChat(stores.chatStore, chat.id, roadmapSlug);
	// PER-SESSION MODELS (owner, 2026-09-28): a session owns its model +
	// thinking level from birth — stamped verbatim from the STRONG slot,
	// the new-session default. From here the strong slot never reaches
	// this session again: in-session picks write the session's own record
	// (PUT /api/chats/:id/settings). No strong slot configured (fresh BYOK
	// boot) → no stamp; the turn gate's 503 models_not_configured envelope
	// refuses honestly until the setup flow fills the slot.
	const strong = readSettingsRecord()?.models?.strong;
	if (strong?.model) {
		stores.chatStore.saveSettings(chat.id, {
			model: { provider: strong.model.provider, id: strong.model.id },
			thinkingLevel: strong.thinkingLevel,
		});
	}
	// The session's map context (owner, 2026-10-04): the picked
	// propositions ride the CREATION — message[0] is a graph-context
	// marker (a separate custom message BEFORE the learner's first user
	// message), carrying the picks plus the reasoning chains among them.
	// The picks carry their own name/statement (what the learner saw at
	// pick time); the chains derive from the CURRENT graph snapshot.
	const rawPicks = (body.graphContext as { propositions?: unknown } | undefined)?.propositions;
	const picks: GraphContextPick[] = Array.isArray(rawPicks)
		? rawPicks
				.filter(
						(p): p is GraphContextPick =>
							typeof p === "object" &&
							p !== null &&
							typeof (p as GraphContextPick).id === "string" &&
							typeof (p as GraphContextPick).name === "string" &&
							typeof (p as GraphContextPick).statement === "string",
					)
					.slice(0, 64)
			: [];
	const opening: LhMessage[] = [];
	if (picks.length > 0) {
		const byId = new Map(stores.graphStore.readNodes().map((n) => [n.id, n]));
		const pickedNodes = picks.map((p) => byId.get(p.id)).filter((n) => n !== undefined);
		const chainLines = chainsForSelection(pickedNodes, stores.graphStore.readChains()).map((c) =>
			formatChainLine(c, Object.fromEntries(byId)),
		);
		opening.push(newGraphContextMessage(picks, chainLines));
	}
	// "Teach this chapter" (2026-11-15): a teach session started from a read
	// chapter carries the chapter as hidden context before the opening
	// message. Only teach sessions take it; an unknown chapter is ignored
	// (the session still opens on its typed prompt).
	const chapterRef = body.readChapter as { chatId?: unknown; documentId?: unknown; sectionId?: unknown } | undefined;
	if (kind === undefined && chapterRef && typeof chapterRef.chatId === "string" && typeof chapterRef.documentId === "string" && typeof chapterRef.sectionId === "string") {
		const source = /^[A-Za-z0-9_-]+$/.test(chapterRef.chatId) ? stores.chatStore.getChat(chapterRef.chatId) : null;
		const document = source?.kind === "read" ? studyDocumentById(stores.chatStore.readDocuments(source.id), chapterRef.documentId) : null;
		const section = document?.sections.find((candidate) => candidate.id === chapterRef.sectionId);
		if (source && document && section && !section.seed) {
			opening.push(newReadChapterMessage({
				chatId: source.id,
				documentId: document.id,
				sectionId: section.id,
				documentTitle: document.title,
				heading: section.heading,
				body: section.body,
			}));
		}
	}
	if (opening.length > 0) stores.chatStore.saveMessages(chat.id, opening);
	return Response.json({ id: chat.id, title: chat.title });
}

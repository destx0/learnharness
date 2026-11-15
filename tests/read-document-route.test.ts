/**
 * The reading pane's routes (read sessions, 2026-11-04; per-document files
 * and background writers 2026-11-15).
 *
 *   - GET /api/chats/[id]/document returns every document as a skeleton
 *     plus the shown one in full, and the session's writer state.
 *   - Clicks (deep dive, lazy summary, more questions, directions) queue
 *     parallel background writers — never chat turns — and settle their
 *     targets when the writer stops.
 *   - Documents live in per-document files; version 3–4 records migrate.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-read-doc-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const writers = await import("../src/server/read-writers.ts");
const { GET } = await import("../app/api/chats/[id]/document/route.ts");
const { POST: setActive } = await import("../app/api/chats/[id]/document/active/route.ts");
const { POST: suggest } = await import("../app/api/chats/[id]/document/suggest/route.ts");
const { POST: deeper } = await import("../app/api/chats/[id]/document/deeper/route.ts");
const { POST: moreQuestions } = await import("../app/api/chats/[id]/document/questions/route.ts");
const { POST: summary } = await import("../app/api/chats/[id]/document/summary/route.ts");
const { POST: createChat } = await import("../app/api/chats/route.ts");
const { applyStudyDocumentEdit } = await import("../src/core/study-document.ts");
type StudyDocument = import("../src/core/contracts.ts").StudyDocument;

after(() => {
	writers.setReadWriterExecutor(undefined);
	writers.resetReadWriters();
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});
afterEach(() => {
	writers.setReadWriterExecutor(undefined);
	writers.resetReadWriters();
});

function get(id: string, documentId?: string) {
	return GET(new Request(`http://localhost/api/chats/${id}/document${documentId ? `?documentId=${documentId}` : ""}`), {
		params: Promise.resolve({ id }),
	});
}

function post(handler: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>, id: string, body: unknown) {
	return handler(new Request("http://localhost", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}

const now = () => new Date().toISOString();

function rootWith(sections: StudyDocument["sections"], extra: Partial<StudyDocument> = {}): StudyDocument {
	return { id: "root", title: "Root", sections, revision: 1, updatedAt: now(), ...extra };
}

/** Resolve once `predicate` holds (writers settle on microtasks/timers). */
async function until(predicate: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(`timed out waiting for ${label}`);
}

describe("GET /api/chats/[id]/document", () => {
	it("returns skeletons of every document and the reading document in full", async () => {
		const chat = chatStore.createChat("linear algebra", "read");
		chatStore.saveDocument(chat.id, rootWith([{ id: "maps", heading: "Maps", body: "Root body.", questions: [{ id: "q1", question: "Q?", answer: "A." }], suggestions: [{ id: "eigen", heading: "Eigen", blurb: "Fixed." }] }]));
		chatStore.saveDocument(chat.id, {
			id: "doc_a", title: "Eigen", sections: [{ id: "idea", heading: "Idea", body: "Child body." }],
			revision: 1, updatedAt: now(), parent: { documentId: "root", sectionId: "maps", topicId: "eigen" }, status: "ready",
		});
		const res = await get(chat.id);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { documents: StudyDocument[]; fullDocumentId: string; writers: unknown[] };
		assert.equal(body.fullDocumentId, "root");
		const root = body.documents.find((doc) => doc.id === "root")!;
		const child = body.documents.find((doc) => doc.id === "doc_a")!;
		assert.equal(root.sections[0]?.body, "Root body.");
		assert.equal(root.sections[0]?.questions?.[0]?.answer, "A.");
		assert.equal(child.sections[0]?.body, "", "non-shown documents ship as skeletons");
		assert.equal(child.sections[0]?.heading, "Idea");
		assert.deepEqual(body.writers, []);
		const second = (await (await get(chat.id, "doc_a")).json()) as { documents: StudyDocument[] };
		assert.equal(second.documents.find((doc) => doc.id === "doc_a")?.sections[0]?.body, "Child body.");
		assert.equal(second.documents.find((doc) => doc.id === "root")?.sections[0]?.body, "");
	});

	it("returns no documents before the first write", async () => {
		const chat = chatStore.createChat("empty read", "read");
		const body = (await (await get(chat.id)).json()) as { documents: unknown[]; fullDocumentId: string | null };
		assert.deepEqual(body.documents, []);
		assert.equal(body.fullDocumentId, null);
	});

	it("remembers the active document and rejects unknown ids", async () => {
		const chat = chatStore.createChat("active document", "read");
		chatStore.saveDocument(chat.id, rootWith([{ id: "maps", heading: "Maps", body: "Body." }]));
		assert.equal((await post(setActive, chat.id, { documentId: "root" })).status, 200);
		assert.equal(chatStore.getChat(chat.id)?.readingDocumentId, "root");
		assert.equal((await post(setActive, chat.id, { documentId: "doc_missing" })).status, 400);
	});

	it("settles an orphaned writing child on read but leaves one with a live writer alone", async () => {
		const chat = chatStore.createChat("crash recovery", "read");
		chatStore.saveDocument(chat.id, rootWith([{ id: "maps", heading: "Maps", body: "Body." }]));
		chatStore.saveDocument(chat.id, {
			id: "doc_stale", title: "Stale topic", sections: [], revision: 0,
			updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
			parent: { documentId: "root", sectionId: "maps", topicId: "stale" }, status: "writing",
		});
		const body = (await (await get(chat.id)).json()) as { documents: StudyDocument[] };
		assert.equal(body.documents.find((doc) => doc.id === "doc_stale")?.status, "failed");

		let release!: () => void;
		writers.setReadWriterExecutor(() => new Promise<void>((resolve) => { release = resolve; }));
		chatStore.saveDocument(chat.id, {
			id: "doc_live", title: "Live topic", sections: [], revision: 0,
			updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
			parent: { documentId: "root", sectionId: "maps", topicId: "live" }, status: "writing",
		});
		writers.enqueueReadWriter(chat.id, { kind: "deep-dive", documentId: "doc_live" }, "Deep dive · Live");
		const body2 = (await (await get(chat.id)).json()) as { documents: StudyDocument[] };
		assert.equal(body2.documents.find((doc) => doc.id === "doc_live")?.status, "writing");
		release();
		await until(() => chatStore.getDocument(chat.id, "doc_live")?.status === "failed", "the empty live child to fail at settlement");
	});

	it("404s for an unknown session", async () => {
		assert.equal((await get("chat_missing")).status, 404);
	});
});

describe("click routes queue parallel background writers", () => {
	it("validates chapter and suggestion targets", async () => {
		const chat = chatStore.createChat("validation", "read");
		chatStore.saveDocument(chat.id, rootWith([{ id: "maps", heading: "Maps", body: "Body." }]));
		assert.equal((await post(suggest, chat.id, { documentId: "root", sectionId: "nope" })).status, 400);
		assert.equal((await post(deeper, chat.id, { documentId: "root", sectionId: "maps", topicId: "nope" })).status, 400);
		assert.equal((await post(moreQuestions, chat.id, { documentId: "root", sectionId: "nope" })).status, 400);
		assert.equal((await post(summary, chat.id, { documentId: "root", sectionId: "nope" })).status, 400);
	});

	it("starts several deep dives at once, each written by its own writer", async () => {
		const chat = chatStore.createChat("parallel", "read");
		chatStore.saveDocument(chat.id, rootWith([{
			id: "maps", heading: "Maps", body: "Body.",
			suggestions: ["a", "b", "c"].map((id) => ({ id, heading: `Topic ${id}`, blurb: `About ${id}.` })),
		}]));
		const releases: Array<() => void> = [];
		const started: string[] = [];
		writers.setReadWriterExecutor(async ({ chatId, assignment }) => {
			started.push(assignment.documentId);
			await new Promise<void>((resolve) => releases.push(resolve));
			const doc = chatStore.getDocument(chatId, assignment.documentId)!;
			chatStore.saveDocument(chatId, applyStudyDocumentEdit(doc, { sections: [{ id: "idea", heading: "Idea", body: `Written for ${doc.title}.` }] }));
		});
		const responses = await Promise.all(["a", "b", "c"].map((topicId) => post(deeper, chat.id, { documentId: "root", sectionId: "maps", topicId })));
		for (const res of responses) assert.equal(res.status, 200);
		const children = await Promise.all(responses.map(async (res) => ((await res.json()) as { childDocument: StudyDocument }).childDocument));
		assert.equal(new Set(children.map((child) => child.id)).size, 3);
		await until(() => started.length === 3, "all three writers to start together");
		const status = writers.readWriterStatus(chat.id);
		assert.equal(status.filter((writer) => writer.status === "running").length, 3);
		// A second click on a topic that is already being written joins it.
		const again = (await (await post(deeper, chat.id, { documentId: "root", sectionId: "maps", topicId: "a" })).json()) as { childDocument: StudyDocument; started: boolean };
		assert.equal(again.childDocument.id, children[0]!.id);
		assert.equal(writers.readWriterStatus(chat.id).length, 3);
		for (const release of releases) release();
		await until(() => children.every((child) => chatStore.getDocument(chat.id, child.id)?.status === "ready"), "every child to become ready");
		assert.equal(chatStore.getDocument(chat.id, children[1]!.id)?.sections[0]?.body, "Written for Topic b.");
	});

	it("caps running writers per session and queues the rest", async () => {
		const chat = chatStore.createChat("cap", "read");
		const ids = Array.from({ length: writers.READ_WRITERS_PER_SESSION + 3 }, (_, i) => `t${i}`);
		chatStore.saveDocument(chat.id, rootWith(ids.map((id) => ({ id, heading: `Topic ${id}`, body: "Placeholder.", seed: true }))));
		const releases: Array<() => void> = [];
		writers.setReadWriterExecutor(() => new Promise<void>((resolve) => releases.push(resolve)));
		for (const id of ids) assert.equal((await post(summary, chat.id, { documentId: "root", sectionId: id })).status, 200);
		await until(() => releases.length === writers.READ_WRITERS_PER_SESSION, "the cap to fill");
		const status = writers.readWriterStatus(chat.id);
		assert.equal(status.filter((writer) => writer.status === "running").length, writers.READ_WRITERS_PER_SESSION);
		assert.equal(status.filter((writer) => writer.status === "queued").length, 3);
		releases.shift()!();
		await until(() => releases.length === writers.READ_WRITERS_PER_SESSION, "a queued writer to take the freed slot");
		for (const release of releases.splice(0)) release();
		await until(() => releases.length > 0, "the remaining writers to start");
		for (const release of releases.splice(0)) release();
	});

	it("writes a lazy summary once, remembers a failure, and retries only when asked", async () => {
		const chat = chatStore.createChat("lazy", "read");
		chatStore.saveDocument(chat.id, rootWith([
			{ id: "overview", heading: "Overview", body: "Orientation." },
			{ id: "signals", heading: "Signals", body: "Summary not written yet.", seed: true },
		]));
		let attempts = 0;
		writers.setReadWriterExecutor(async ({ chatId, assignment }) => {
			attempts++;
			if (attempts === 1) return; // ends without writing: a delivery failure
			const doc = chatStore.getDocument(chatId, assignment.documentId)!;
			chatStore.saveDocument(chatId, applyStudyDocumentEdit(doc, { sections: [{ id: "signals", body: "Signals are reactive values." }] }));
		});
		await post(summary, chat.id, { documentId: "root", sectionId: "signals" });
		await until(() => writers.readWriterStatus(chat.id).some((writer) => writer.status === "failed"), "the failed summary to be remembered");
		// The automatic request does not re-fire a remembered failure...
		const auto = (await (await post(summary, chat.id, { documentId: "root", sectionId: "signals" })).json()) as { failed?: string };
		assert.match(auto.failed ?? "", /summary/);
		assert.equal(attempts, 1);
		// ...an explicit Retry does.
		await post(summary, chat.id, { documentId: "root", sectionId: "signals", retry: true });
		await until(() => chatStore.getDocument(chat.id, "root")?.sections[1]?.seed === undefined, "the summary to land");
		assert.equal(chatStore.getDocument(chat.id, "root")?.sections[1]?.body, "Signals are reactive values.");
		const written = (await (await post(summary, chat.id, { documentId: "root", sectionId: "signals" })).json()) as { written?: boolean };
		assert.equal(written.written, true);
		assert.equal(attempts, 2);
	});

	it("queues more-questions and directions writers beside each other", async () => {
		const chat = chatStore.createChat("side by side", "read");
		chatStore.saveDocument(chat.id, rootWith([{ id: "maps", heading: "Maps", body: "Body." }]));
		const kinds: string[] = [];
		const releases: Array<() => void> = [];
		writers.setReadWriterExecutor(({ assignment }) => {
			kinds.push(assignment.kind);
			return new Promise<void>((resolve) => releases.push(resolve));
		});
		await post(moreQuestions, chat.id, { documentId: "root", sectionId: "maps" });
		await post(suggest, chat.id, { documentId: "root", sectionId: "maps" });
		await until(() => kinds.length === 2, "both writers to run");
		assert.deepEqual(kinds.sort(), ["directions", "questions"]);
		for (const release of releases) release();
	});
});

describe("per-document storage", () => {
	it("migrates inline documents out of a version-4 record", async () => {
		const chat = chatStore.createChat("legacy", "read");
		const file = path.join(TMP_DATA, "chats", `${chat.id}.json`);
		const legacy = JSON.parse(fs.readFileSync(file, "utf-8"));
		legacy.version = 4;
		legacy.document = { title: "Legacy", sections: [{ id: "a", heading: "A", body: "Inline." }], revision: 2, updatedAt: now() };
		legacy.documents = [{ id: "doc_old", title: "Old child", sections: [], revision: 0, updatedAt: now(), parent: { documentId: "root", sectionId: "a", topicId: "x" } }];
		fs.writeFileSync(file, JSON.stringify(legacy));
		const record = chatStore.getChat(chat.id)!;
		assert.equal(record.document, undefined);
		assert.equal(record.documents, undefined);
		assert.equal(chatStore.getDocument(chat.id, "root")?.title, "Legacy");
		assert.equal(chatStore.getDocument(chat.id, "doc_old")?.title, "Old child");
		const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
		assert.equal(onDisk.document, undefined);
		assert.equal(onDisk.version, 5);
	});

	it("deletes a session's document files with the session", () => {
		const chat = chatStore.createChat("delete", "read");
		chatStore.saveDocument(chat.id, rootWith([{ id: "a", heading: "A", body: "B." }]));
		assert.ok(fs.existsSync(path.join(TMP_DATA, "chats", `${chat.id}.docs`)));
		assert.equal(chatStore.deleteChat(chat.id), true);
		assert.equal(fs.existsSync(path.join(TMP_DATA, "chats", `${chat.id}.docs`)), false);
	});
});

describe("Teach this chapter", () => {
	it("opens a teach session carrying the chapter as hidden context", async () => {
		const read = chatStore.createChat("reading", "read");
		chatStore.saveDocument(read.id, rootWith([
			{ id: "maps", heading: "Linear maps", body: "A linear map preserves addition and scaling." },
			{ id: "seeded", heading: "Seeded", body: "Summary not written yet.", seed: true },
		]));
		const res = await createChat(new Request("http://localhost/api/chats", {
			method: "POST",
			body: JSON.stringify({ title: "Linear maps", readChapter: { chatId: read.id, documentId: "root", sectionId: "maps" } }),
		}));
		const { id } = (await res.json()) as { id: string };
		const teach = chatStore.getChat(id)!;
		assert.equal(teach.kind, undefined, "a teach session");
		const marker = teach.messages[0] as { role: string; customType?: string; content?: string; display?: boolean };
		assert.equal(marker.customType, "read-chapter");
		assert.equal(marker.display, false);
		assert.match(marker.content ?? "", /preserves addition and scaling/);
		// A seed (unwritten) chapter carries nothing.
		const seededRes = await createChat(new Request("http://localhost/api/chats", {
			method: "POST",
			body: JSON.stringify({ title: "Seeded", readChapter: { chatId: read.id, documentId: "root", sectionId: "seeded" } }),
		}));
		const seeded = chatStore.getChat(((await seededRes.json()) as { id: string }).id)!;
		assert.equal(seeded.messages.length, 0);
	});
});

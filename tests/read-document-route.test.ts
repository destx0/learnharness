/**
 * GET /api/chats/[id]/document (read sessions, 2026-11-04): the reading
 * pane's tiny read channel. The canonical document rides the chat record;
 * this route is what document-changed tells the pane to refetch.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-read-doc-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { GET } = await import("../app/api/chats/[id]/document/route.ts");
const { POST: setActive } = await import("../app/api/chats/[id]/document/active/route.ts");
const { POST: suggest } = await import("../app/api/chats/[id]/document/suggest/route.ts");
const { POST: deeper } = await import("../app/api/chats/[id]/document/deeper/route.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function get(id: string) {
	return GET(new Request(`http://localhost/api/chats/${id}/document`), {
		params: Promise.resolve({ id }),
	});
}

describe("GET /api/chats/[id]/document", () => {
	it("returns the living document from the record", async () => {
		const chat = chatStore.createChat("linear algebra", "read");
		chatStore.saveDocument(chat.id, {
			id: "root",
			title: "Linear algebra — a working overview",
			sections: [{ id: "overview", heading: "Overview", body: "Vectors are the nouns." }],
			revision: 1,
			updatedAt: new Date().toISOString(),
		});
		const res = await get(chat.id);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { document?: { title?: string; revision?: number }; documents?: unknown[]; readingDocumentId?: string | null };
		assert.equal(body.document?.title, "Linear algebra — a working overview");
		assert.equal(body.document?.revision, 1);
		assert.deepEqual(body.documents, []);
		assert.equal(body.readingDocumentId, null);
	});

	it("returns null before the first write", async () => {
		const chat = chatStore.createChat("empty read", "read");
		const res = await get(chat.id);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { document?: unknown };
		assert.equal(body.document, null);
	});

	it("remembers the active document and rejects unknown ids", async () => {
		const chat = chatStore.createChat("active document", "read");
		chatStore.saveDocument(chat.id, {
			id: "root",
			title: "Root",
			sections: [{ id: "maps", heading: "Maps", body: "Body." }],
			revision: 1,
			updatedAt: new Date().toISOString(),
		});
		const ok = await setActive(new Request("http://localhost", {
			method: "POST",
			body: JSON.stringify({ documentId: "root" }),
		}), { params: Promise.resolve({ id: chat.id }) });
		assert.equal(ok.status, 200);
		assert.equal(chatStore.getChat(chat.id)?.readingDocumentId, "root");
		const missing = await setActive(new Request("http://localhost", {
			method: "POST",
			body: JSON.stringify({ documentId: "doc_missing" }),
		}), { params: Promise.resolve({ id: chat.id }) });
		assert.equal(missing.status, 400);
	});

	it("settles a stale writing child on read but leaves a fresh one alone", async () => {
		const chat = chatStore.createChat("crash recovery", "read");
		chatStore.saveDocument(chat.id, {
			id: "root",
			title: "Root",
			sections: [{ id: "maps", heading: "Maps", body: "Body." }],
			revision: 1,
			updatedAt: new Date().toISOString(),
		});
		const stale = {
			id: "doc_stale",
			title: "Stale topic",
			sections: [],
			revision: 0,
			updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
			parent: { documentId: "root", sectionId: "maps", topicId: "stale" },
			status: "writing" as const,
		};
		chatStore.saveDocument(chat.id, stale);
		const res = await get(chat.id);
		const body = (await res.json()) as { documents?: Array<{ id: string; status?: string }> };
		assert.equal(body.documents?.[0]?.status, "failed");
		const fresh = {
			...stale,
			id: "doc_fresh",
			updatedAt: new Date().toISOString(),
			parent: { documentId: "root", sectionId: "maps", topicId: "fresh" },
		};
		chatStore.saveDocument(chat.id, fresh);
		const res2 = await get(chat.id);
		const body2 = (await res2.json()) as { documents?: Array<{ id: string; status?: string }> };
		assert.equal(body2.documents?.find((doc) => doc.id === "doc_fresh")?.status, "writing");
	});

	it("validates suggestion and deeper targets before starting a turn", async () => {
		const chat = chatStore.createChat("validation", "read");
		chatStore.saveDocument(chat.id, {
			id: "root",
			title: "Root",
			sections: [{ id: "maps", heading: "Maps", body: "Body." }],
			revision: 1,
			updatedAt: new Date().toISOString(),
		});
		const badSuggest = await suggest(new Request("http://localhost", {
			method: "POST",
			body: JSON.stringify({ documentId: "root", sectionId: "nope" }),
		}), { params: Promise.resolve({ id: chat.id }) });
		assert.equal(badSuggest.status, 400);
		const badDeeper = await deeper(new Request("http://localhost", {
			method: "POST",
			body: JSON.stringify({ documentId: "root", sectionId: "maps", topicId: "nope" }),
		}), { params: Promise.resolve({ id: chat.id }) });
		assert.equal(badDeeper.status, 400);
	});

	it("404s for an unknown session", async () => {
		const res = await get("chat_missing");
		assert.equal(res.status, 404);
	});
});

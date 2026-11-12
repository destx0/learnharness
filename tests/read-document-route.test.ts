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
			title: "Linear algebra — a working overview",
			sections: [{ id: "overview", heading: "Overview", body: "Vectors are the nouns." }],
			revision: 1,
			updatedAt: new Date().toISOString(),
		});
		const res = await get(chat.id);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { document?: { title?: string; revision?: number } };
		assert.equal(body.document?.title, "Linear algebra — a working overview");
		assert.equal(body.document?.revision, 1);
	});

	it("returns null before the first write", async () => {
		const chat = chatStore.createChat("empty read", "read");
		const res = await get(chat.id);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { document?: unknown };
		assert.equal(body.document, null);
	});

	it("404s for an unknown session", async () => {
		const res = await get("chat_missing");
		assert.equal(res.status, 404);
	});
});

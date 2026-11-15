/**
 * THE READ AGENT (read sessions, 2026-11-04): the documentation-only mode.
 * These pins hold the three seams that make it a different mode rather than
 * a teaching variant:
 *   - the prompt composes the read base + doctrine + the curated shared
 *     appendix, and carries none of the teaching apparatus;
 *   - the tool registry is document + learner files + research/PDF ONLY —
 *     no quiz, ask, plan, probe, problem, demo, or visual tools;
 *   - a turn ending on internal document work owes NO continuation (the
 *     phantom-wake guard).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

import type { ChatRecord } from "../src/core/contracts.ts";
import type { ChatStore, JobStore } from "../src/core/ports.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { needsContinuation } from "../src/core/native-messages.ts";
import { buildCompactionPrompt } from "../src/core/compaction.ts";
import { EDIT_DOCUMENT_TOOL, READ_DOCUMENT_TOOL } from "../src/core/contracts/chat.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";
import { createReadTools } from "../src/agent/tools.ts";
import { allSegmentPaths } from "../src/agent/prompt-segments.ts";

const NOW = "2026-11-04T12:00:00.000Z";

function record(): ChatRecord {
	return {
		id: "c_read",
		title: "Linear algebra",
		createdAt: NOW,
		updatedAt: NOW,
		messages: [],
		kind: "read",
	};
}

/** The narrow store surface the document tools use. */
function fakeStore(initial: ChatRecord) {
	let current = initial;
	const store = {
		getChat: (id: string) => (id === current.id ? current : null),
		saveDocument: (_id: string, document: NonNullable<ChatRecord["document"]>) => {
			if (document.id === "root") current = { ...current, document };
			else {
				const documents = [...(current.documents ?? [])];
				const at = documents.findIndex((doc) => doc.id === document.id);
				if (at >= 0) documents[at] = document;
				else documents.push(document);
				current = { ...current, documents };
			}
		},
		readDocuments: () => ({ ...(current.document ? { document: current.document } : {}), documents: current.documents ?? [] }),
		getDocument: (_id: string, documentId: string) =>
			(documentId === "root" ? current.document : current.documents?.find((doc) => doc.id === documentId)) ?? null,
		saveReadingDocumentId: (_id: string, readingDocumentId: string) => {
			current = { ...current, readingDocumentId };
		},
	} as unknown as ChatStore;
	return { store, get: () => current };
}

const jobStore = {} as JobStore;
const spawn = () => {};

function toolsOf(store: ChatStore, defaultDocumentId?: string) {
	return createReadTools({
		chatId: "c_read",
		chatStore: store,
		jobStore,
		spawn,
		searchAvailable: () => true,
		...(defaultDocumentId ? { defaultDocumentId } : {}),
	});
}

describe("the read agent's prompt", () => {
	it("composes the documentation base + doctrine and the shared appendix", () => {
		const prompt = composeInstructions("read");
		assert.match(prompt, /living study document/);
		assert.match(prompt, /edit_document/);
		assert.match(prompt, /No graded quiz/);
		// Shared appendix: voice + learner files + formatting.
		assert.match(prompt, /No enthusiasm, praise, or performed reaction/);
		assert.match(prompt, /## Learner files/);
		assert.match(prompt, /he receives documents, not chat messages/i);
		// Teaching apparatus stays out.
		assert.doesNotMatch(prompt, /probe_done/);
		assert.doesNotMatch(prompt, /plan_init/);
		assert.match(prompt, /deeper/i);
		assert.match(prompt, /describe_subtopics/);
		assert.match(prompt, /Generate more questions/);
	});

	it("is a discoverable prompt segment set (overrides can target it)", () => {
		const paths = allSegmentPaths();
		assert.ok(paths.includes("read/00-base.md"));
		assert.ok(paths.includes("read/10-doctrine.md"));
		assert.ok(paths.includes("read/20-deeper.md"));
		assert.ok(paths.includes("shared/10-voice.md"));
	});
});

describe("the read agent's tool registry", () => {
	it("holds document + files + research/PDF only", () => {
		const { store } = fakeStore(record());
		const keys = Object.keys(toolsOf(store)).sort();
		assert.deepEqual(keys, [
			"add_questions",
			"describe_subtopics",
			"edit_document",
			"find",
			"grep",
			"list_documents",
			"ls",
			"pdf",
			"read",
			"read_document",
			"research",
			"suggest_deeper",
		]);
	});

	it("creates the living document through edit_document and reads it back", async () => {
		const { store, get } = fakeStore(record());
		const tools = toolsOf(store);
		const created = await tools[EDIT_DOCUMENT_TOOL]!.execute("call_1", {
			title: "Linear algebra — a working overview",
			sections: [
				{ id: "overview", heading: "Overview", body: "Vectors are the nouns." },
				{ id: "maps", heading: "Linear maps", body: "Maps preserve addition and scaling." },
			],
		} as never);
		const createdDetails = created.details as { ok?: boolean; revision?: number };
		assert.equal(createdDetails.ok, true);
		assert.equal(createdDetails.revision, 1);
		assert.equal(get().document?.sections.length, 2);
		assert.equal(get().document?.title, "Linear algebra — a working overview");

		const read = await tools[READ_DOCUMENT_TOOL]!.execute("call_2", { sectionId: "maps" } as never);
		const readBody = (read.details as { sections?: Array<{ id: string; body: string }> }).sections?.[0];
		assert.equal(readBody?.id, "maps");
		assert.match(readBody?.body ?? "", /preserve addition/);
	});

	it("authors directions and self-check questions in the same section edit", async () => {
		const { store, get } = fakeStore(record());
		const tools = toolsOf(store);
		const created = await tools[EDIT_DOCUMENT_TOOL]!.execute("call_1", {
			title: "Linear algebra",
			sections: [{
				id: "maps",
				heading: "Linear maps",
				body: "A map preserves structure.",
				suggestions: [{ id: "eigen", heading: "Eigenvectors", blurb: "Fixed directions." }],
				questions: [{ id: "q1", question: "What is preserved?", answer: "Addition and scaling." }],
			}],
		} as never);
		assert.equal((created.details as { ok?: boolean }).ok, true);
		const section = get().document?.sections[0];
		assert.equal(section?.suggestions?.[0]?.id, "eigen");
		assert.equal(section?.questions?.[0]?.answer, "Addition and scaling.");
	});

	it("describes roadmap subtopics by id without touching their titles", async () => {
		const { store, get } = fakeStore(record());
		const tools = toolsOf(store);
		await tools[EDIT_DOCUMENT_TOOL]!.execute("call_1", {
			title: "Linear algebra",
			sections: [{
				id: "maps",
				heading: "Linear maps",
				body: "A map preserves structure.",
				suggestions: [{ id: "eigen", heading: "Eigenvectors", blurb: "Old." }],
			}],
		} as never);
		const described = await tools.describe_subtopics!.execute("call_2", {
			sectionId: "maps",
			subtopics: [{ id: "eigen", blurb: "Directions a map leaves fixed." }],
		} as never);
		assert.equal((described.details as { ok?: boolean }).ok, true);
		const section = get().document?.sections[0];
		assert.equal(section?.suggestions?.[0]?.blurb, "Directions a map leaves fixed.");
		assert.equal(section?.suggestions?.[0]?.heading, "Eigenvectors");
	});

	it("serializes parallel edit_document calls per session", async () => {
		const { store, get } = fakeStore(record());
		const tools = toolsOf(store);
		await Promise.all([
			tools[EDIT_DOCUMENT_TOOL]!.execute("call_1", {
				title: "Parallel",
				sections: [{ id: "one", heading: "One", body: "First." }],
			} as never),
			tools[EDIT_DOCUMENT_TOOL]!.execute("call_2", {
				sections: [{ id: "two", heading: "Two", body: "Second." }],
			} as never),
		]);
		assert.deepEqual(get().document?.sections.map((section) => section.id), ["one", "two"]);
	});

	it("suggests deeper directions for one chapter and lists the tree", async () => {
		const { store, get } = fakeStore(record());
		const tools = toolsOf(store);
		await tools[EDIT_DOCUMENT_TOOL]!.execute("call_1", {
			title: "Linear algebra",
			sections: [{ id: "maps", heading: "Linear maps", body: "A map preserves structure." }],
		} as never);
		const suggested = await tools.suggest_deeper!.execute("call_2", {
			documentId: "root",
			sectionId: "maps",
			suggestions: [
				{ id: "eigen", heading: "Eigenvectors", blurb: "Directions a map leaves fixed." },
			],
		} as never);
		assert.equal((suggested.details as { ok?: boolean }).ok, true);
		assert.equal(get().document?.sections[0]?.suggestions?.[0]?.id, "eigen");
		const listed = await tools.list_documents!.execute("call_3", {} as never);
		const details = listed.details as { tree?: string; documents?: Array<{ id: string }> };
		assert.match(details.tree ?? "", /\[root\] Linear algebra/);
		assert.match(details.tree ?? "", /eigen \(Eigenvectors\)/);
		assert.deepEqual(details.documents?.map((doc) => doc.id), ["root"]);
	});

	it("targets a child document by id and leaves the root alone", async () => {
		const { store, get } = fakeStore(record());
		const tools = toolsOf(store);
		await tools[EDIT_DOCUMENT_TOOL]!.execute("call_1", {
			title: "Linear algebra",
			sections: [{ id: "maps", heading: "Linear maps", body: "A map preserves structure." }],
		} as never);
		const suggested = await tools.suggest_deeper!.execute("call_2", {
			documentId: "root",
			sectionId: "maps",
			suggestions: [{ id: "eigen", heading: "Eigenvectors", blurb: "Fixed directions." }],
		} as never);
		assert.equal((suggested.details as { ok?: boolean }).ok, true);
		const { createChildStudyDocument } = await import("../src/core/study-document.ts");
		const current = get();
		const child = createChildStudyDocument(
			{ document: current.document, documents: current.documents ?? [] },
			"root",
			"maps",
			"eigen",
			"doc_eigen",
		);
		store.saveDocument("c_read", child);
		store.saveReadingDocumentId("c_read", "doc_eigen");
		// The next turn pins the child (the document open when it started).
		const childTurn = toolsOf(store, "doc_eigen");
		const edited = await childTurn[EDIT_DOCUMENT_TOOL]!.execute("call_3", {
			title: "Eigenvectors",
			sections: [{ id: "idea", heading: "The idea", body: "A vector that only scales." }],
		} as never);
		assert.equal((edited.details as { ok?: boolean; documentId?: string }).documentId, "doc_eigen");
		assert.equal(get().document?.sections.length, 1);
		assert.equal(get().document?.sections[0]?.id, "maps");
		assert.equal(get().documents?.[0]?.title, "Eigenvectors");
	});

	it("keeps editing the turn's pinned document when the learner navigates mid-turn", async () => {
		const { store, get } = fakeStore(record());
		const tools = toolsOf(store, "root");
		await tools[EDIT_DOCUMENT_TOOL]!.execute("call_1", {
			title: "Linear algebra",
			sections: [{ id: "maps", heading: "Linear maps", body: "A map preserves structure.", suggestions: [{ id: "eigen", heading: "Eigenvectors", blurb: "Fixed." }] }],
		} as never);
		const { createChildStudyDocument } = await import("../src/core/study-document.ts");
		store.saveDocument("c_read", createChildStudyDocument(get(), "root", "maps", "eigen", "doc_eigen"));
		// The learner opens the child while this turn is still writing.
		store.saveReadingDocumentId("c_read", "doc_eigen");
		await tools[EDIT_DOCUMENT_TOOL]!.execute("call_2", {
			sections: [{ id: "spaces", heading: "Vector spaces", body: "Where vectors live." }],
		} as never);
		assert.deepEqual(get().document?.sections.map((section) => section.id), ["maps", "spaces"]);
		assert.equal(get().documents?.[0]?.sections.length, 0);
	});

	it("appends self-check questions without resending the old ones", async () => {
		const { store, get } = fakeStore(record());
		const tools = toolsOf(store);
		await tools[EDIT_DOCUMENT_TOOL]!.execute("call_1", {
			title: "Linear algebra",
			sections: [{ id: "maps", heading: "Linear maps", body: "A map.", questions: [{ id: "q1", question: "Q1?", answer: "A1." }] }],
		} as never);
		const added = await tools.add_questions!.execute("call_2", {
			sectionId: "maps",
			questions: [{ id: "q2", question: "Q2?", answer: "A2." }, { id: "q3", question: "Q3?", answer: "A3." }],
		} as never);
		assert.equal((added.details as { ok?: boolean }).ok, true);
		assert.deepEqual(get().document?.sections[0]?.questions?.map((q) => q.id), ["q1", "q2", "q3"]);
		const duplicate = await tools.add_questions!.execute("call_3", {
			sectionId: "maps",
			questions: [{ id: "q1", question: "Again?", answer: "No." }],
		} as never);
		assert.equal((duplicate.details as { ok?: boolean }).ok, false);
		assert.equal(get().document?.sections[0]?.questions?.[0]?.question, "Q1?");
	});

	it("registers the graph-map reader only when the graph gate passes a store", () => {
		const { store } = fakeStore(record());
		const gated = createReadTools({
			chatId: "c_read",
			chatStore: store,
			jobStore,
			spawn,
			graphStore: {} as never,
		});
		assert.ok(gated.list_sessions && gated.list_propositions);
		assert.equal(toolsOf(store).list_sessions, undefined);
	});

	it("returns validation problems to the model without writing", async () => {
		const { store, get } = fakeStore(record());
		const tools = toolsOf(store);
		await tools[EDIT_DOCUMENT_TOOL]!.execute("call_1", { sections: [{ id: "x", heading: "X", body: "Y" }] } as never);
		const result = await tools[EDIT_DOCUMENT_TOOL]!.execute("call_2", {
			title: "T",
			sections: [
				{ id: "dup", heading: "Same", body: "One" },
				{ id: "dup", heading: "Else", body: "Two" },
			],
		} as never);
		assert.equal((result.details as { ok?: boolean }).ok, false);
		assert.equal(get().document, undefined);
	});
});

describe("the read session's turn boundaries", () => {
	const STAMPS = {
		api: "faux",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
	} as const;

	it("does not owe a continuation after a document edit", () => {
		const call: LhMessage & AssistantMessage = {
			id: "m1",
			role: "assistant",
			content: [{ type: "toolCall", id: "call_doc", name: EDIT_DOCUMENT_TOOL, arguments: { title: "T" } }],
			timestamp: 1,
			...STAMPS,
		};
		const result: LhMessage & ToolResultMessage = {
			id: "m2",
			role: "toolResult",
			toolCallId: "call_doc",
			toolName: EDIT_DOCUMENT_TOOL,
			content: [{ type: "text", text: '{"ok":true}' }],
			details: { ok: true },
			isError: false,
			timestamp: 2,
		};
		assert.equal(needsContinuation([call, result]), false);
	});

	it("a read compaction keeps the steering and the TOC, not the teaching arc", () => {
		const prompt = buildCompactionPrompt({
			spanText: "[LEARNER] expand the maps section",
			planTreeText: null,
			kind: "read",
			documentText: "Title: Linear algebra\nSections:\n- Overview (overview)",
		});
		assert.match(prompt, /The learner's steering/);
		assert.match(prompt, /The document's current state/);
		assert.match(prompt, /read_document/);
		assert.match(prompt, /- Overview \(overview\)/);
		assert.doesNotMatch(prompt, /The plan dependency tree/);
	});
});

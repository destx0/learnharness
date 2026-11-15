/**
 * THE BACKGROUND DOCUMENT WRITER (2026-11-15): a stateless sub-agent per
 * click. These pins hold its three seams:
 *   - the prompt is the lean writer base + the read doctrine + the shared
 *     voice/accuracy/formatting appendix — no chat mechanics;
 *   - the brief names the exact target ids and carries the text it builds on;
 *   - its tools write ONLY the target (a summary writer only its section),
 *     so parallel writers cannot clobber each other.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChatStore } from "../src/core/ports.ts";
import type { StudyDocument, StudyDocumentSet } from "../src/core/contracts.ts";
import { composeReadWriterInstructions, readWriterBrief, readWriterTools } from "../src/agent/read-writer.ts";
import { STUDY_SUBTOPIC_PLACEHOLDER } from "../src/core/study-document.ts";

const NOW = "2026-11-15T12:00:00.000Z";

function root(): StudyDocument {
	return {
		id: "root",
		title: "Angular",
		revision: 1,
		updatedAt: NOW,
		roadmap: { slug: "angular", title: "Angular", source: "https://roadmap.sh/angular", tracks: [] },
		sections: [
			{ id: "overview", heading: "Overview", body: "Angular is a web framework." },
			{
				id: "components",
				heading: "Components",
				body: "Summary not written yet.",
				seed: true,
				suggestions: [
					{ id: "selector", heading: "Selector", blurb: STUDY_SUBTOPIC_PLACEHOLDER, roadmap: { slug: "angular", nodeId: "subtopic:components:selector", kind: "subtopic" } },
					{ id: "template", heading: "Template", blurb: "Already described.", roadmap: { slug: "angular", nodeId: "subtopic:components:template", kind: "subtopic" } },
				],
			},
			{ id: "signals", heading: "Signals", body: "Signals are reactive values.", questions: [{ id: "q1", question: "What is a signal?", answer: "A reactive value." }] },
		],
	};
}

function store(initial: StudyDocumentSet) {
	let docs = initial;
	const chatStore = {
		readDocuments: () => docs,
		getDocument: (_id: string, documentId: string) => (documentId === "root" ? docs.document : docs.documents?.find((doc) => doc.id === documentId)) ?? null,
		saveDocument: (_id: string, document: StudyDocument) => {
			if (document.id === "root") docs = { ...docs, document };
			else docs = { ...docs, documents: [...(docs.documents ?? []).filter((doc) => doc.id !== document.id), document] };
		},
	} as unknown as ChatStore;
	return { chatStore, docs: () => docs };
}

describe("the writer's prompt", () => {
	it("composes the writer base, the doctrine and the shared appendix only", () => {
		const prompt = composeReadWriterInstructions();
		assert.match(prompt, /background writer/);
		assert.match(prompt, /Definitions before use/, "the read doctrine");
		assert.match(prompt, /No enthusiasm, praise, or performed reaction/, "the shared voice");
		assert.doesNotMatch(prompt, /Chat is the steering channel/, "no chat mechanics");
		assert.doesNotMatch(prompt, /probe_done|plan_init/);
	});
});

describe("the writer's brief", () => {
	it("names the target ids and carries the orientation for a topic summary", () => {
		const brief = readWriterBrief({ kind: "summary", documentId: "root", sectionId: "components" }, { document: root(), documents: [] }, "Angular");
		assert.match(brief, /TOPIC SUMMARY for section "Components" \(components\)/);
		assert.match(brief, /documentId="root"/);
		assert.match(brief, /Angular is a web framework/);
		assert.match(brief, /- Selector/);
	});

	it("lists only the pending subtopics of its batch", () => {
		const brief = readWriterBrief({ kind: "subtopics", documentId: "root", sectionId: "components" }, { document: root(), documents: [] }, "Angular");
		assert.match(brief, /- selector: Selector/);
		assert.doesNotMatch(brief, /- template: Template/);
	});

	it("shows existing questions to the more-questions writer", () => {
		const brief = readWriterBrief({ kind: "questions", documentId: "root", sectionId: "signals" }, { document: root(), documents: [] }, "Angular");
		assert.match(brief, /\[q1\] What is a signal\?/);
		assert.match(brief, /add_questions/);
	});

	it("stops cleanly when the target is gone", () => {
		assert.match(readWriterBrief({ kind: "summary", documentId: "doc_gone" }, { document: root(), documents: [] }, "Angular"), /no longer exists/);
	});
});

describe("the writer's scoped tools", () => {
	it("a summary writer may patch only its own section", async () => {
		const { chatStore, docs } = store({ document: root(), documents: [] });
		const tools = Object.fromEntries(readWriterTools({ kind: "summary", documentId: "root", sectionId: "components" }, { chatId: "c", chatStore }).map((tool) => [tool.name, tool]));
		assert.deepEqual(Object.keys(tools).sort(), ["edit_document", "read_document"]);
		const outside = await tools.edit_document!.execute("t1", { sections: [{ id: "signals", body: "Clobbered." }] } as never);
		assert.equal((outside.details as { ok?: boolean }).ok, false);
		const retitle = await tools.edit_document!.execute("t2", { title: "Other" } as never);
		assert.equal((retitle.details as { ok?: boolean }).ok, false);
		const own = await tools.edit_document!.execute("t3", {
			sections: [{ id: "components", body: "Components are the building blocks.", questions: [{ id: "q1", question: "What is a component?", answer: "A class with a template." }] }],
		} as never);
		assert.equal((own.details as { ok?: boolean }).ok, true);
		const section = docs().document!.sections.find((s) => s.id === "components")!;
		assert.equal(section.seed, undefined);
		assert.equal(section.suggestions?.length, 2, "roadmap subtopics are kept");
		assert.equal(docs().document!.sections.find((s) => s.id === "signals")?.body, "Signals are reactive values.");
	});

	it("a deep-dive writer may write only its child", async () => {
		const child: StudyDocument = { id: "doc_sel", title: "Selector", sections: [], revision: 0, updatedAt: NOW, parent: { documentId: "root", sectionId: "components", topicId: "selector" }, status: "writing" };
		const { chatStore, docs } = store({ document: root(), documents: [child] });
		const tools = Object.fromEntries(readWriterTools({ kind: "deep-dive", documentId: "doc_sel", parent: child.parent }, { chatId: "c", chatStore }).map((tool) => [tool.name, tool]));
		const intoRoot = await tools.edit_document!.execute("t1", { documentId: "root", sections: [{ id: "x", heading: "X", body: "Y." }] } as never);
		assert.equal((intoRoot.details as { ok?: boolean }).ok, false);
		const own = await tools.edit_document!.execute("t2", { sections: [{ id: "idea", heading: "The idea", body: "A selector names a component." }] } as never);
		assert.equal((own.details as { ok?: boolean; documentId?: string }).documentId, "doc_sel");
		assert.equal(docs().documents?.[0]?.sections.length, 1);
	});

	it("adds the graph-map reader to summaries and deep dives when the gate passes a store", () => {
		const { chatStore } = store({ document: root(), documents: [] });
		const names = readWriterTools({ kind: "summary", documentId: "root", sectionId: "components" }, { chatId: "c", chatStore, graphStore: {} as never }).map((tool) => tool.name);
		assert.ok(names.includes("list_sessions"));
		const questionNames = readWriterTools({ kind: "questions", documentId: "root", sectionId: "signals" }, { chatId: "c", chatStore, graphStore: {} as never }).map((tool) => tool.name);
		assert.ok(!questionNames.includes("list_sessions"));
	});
});

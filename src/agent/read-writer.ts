import fs from "node:fs";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";
import type { ChatStore, GraphStore } from "../core/ports.ts";
import type { StudyDocument, StudyDocumentSet, StudySection, StudyWriterKind } from "../core/contracts/chat.ts";
import { READ_DOCUMENT_TOOL, EDIT_DOCUMENT_TOOL } from "../core/contracts/chat.ts";
import {
	studyDocumentById,
	studyDocumentTreeText,
	studySubtopicPending,
} from "../core/study-document.ts";
import type { PiEngine } from "./models.ts";
import { readPromptOverride } from "./prompt-segments.ts";
import { runSubagent } from "./subagents/pi-run.ts";
import { healToolRecord } from "./tools/heal.ts";
import {
	addQuestionsTool,
	describeSubtopicsTool,
	editDocumentTool,
	listDocumentsTool,
	readDocumentTool,
	suggestDeeperTool,
	type DocumentToolContext,
} from "./tools/document.ts";
import { proberGraphTools } from "./tools/graph.ts";

/**
 * THE BACKGROUND DOCUMENT WRITER (read sessions, 2026-11-15).
 *
 * Every piece of a study document the learner asks for by CLICKING — a
 * deep dive, a roadmap topic's lazy summary, subtopic overviews, more
 * self-check questions, fresh directions — is written by one of these
 * instead of a chat turn. A session runs one chat turn at a time; writers
 * run in parallel (server/read-writers.ts queues them, at most eight per
 * session), so opening several topics never waits on the conversation and
 * the conversation never waits on them.
 *
 * A writer is a stateless sub-agent (pi-run.ts): its own lean prompt
 * (prompts/read-writer + the read doctrine + the shared voice/accuracy/
 * formatting appendix), a task brief carrying exactly the text it needs,
 * and document tools SCOPED to its target — a write outside the target
 * is rejected by the tool, so parallel writers cannot clobber each other.
 * It never talks to the learner; its output is the document itself.
 */

export type ReadWriterKind = StudyWriterKind;

export interface ReadWriterAssignment {
	kind: ReadWriterKind;
	documentId: string;
	sectionId?: string;
	/** deep-dive: the suggestion it was spawned from (in the parent). */
	parent?: { documentId: string; sectionId: string; topicId: string };
	/** subtopics: the batch of subtopic ids this writer describes. */
	subtopicIds?: string[];
	/** deep-dive from a roadmap subtopic: the hidden roadmap line. */
	roadmapContext?: string;
}

const PROMPTS_DIR = path.join(PATHS.root, "src", "agent", "prompts");
/** Composition order; keys are prompt-override paths. */
const WRITER_SEGMENTS = [
	"read-writer/00-writer.md",
	"read/10-doctrine.md",
	"shared/10-voice.md",
	"shared/15-accuracy.md",
	"shared/40-formatting.md",
];

function readSource(key: string): string {
	try {
		return fs.readFileSync(path.join(PROMPTS_DIR, ...key.split("/")), "utf-8");
	} catch {
		return "";
	}
}

/** The writer's system prompt, composed fresh per run so an enabled prompt
 *  override (read/10-doctrine.md, the shared fragments) lands on the next
 *  writer exactly as it does on the next chat turn. */
export function composeReadWriterInstructions(switches: Record<string, boolean> = {}): string {
	return WRITER_SEGMENTS
		.map((key) => (switches[key] === true ? readPromptOverride(key) : null) ?? readSource(key))
		.map((text) => text.trim())
		.filter(Boolean)
		.join("\n\n---\n\n");
}

function sectionText(doc: StudyDocument, section: StudySection, withQuestions = false): string {
	const lines = [`## ${section.heading} (${section.id}) — in "${doc.title}" (${doc.id})`, "", section.body.trim()];
	if (withQuestions && section.questions?.length) {
		lines.push("", "Existing self-check questions (keep them; do not repeat them):");
		for (const q of section.questions) lines.push(`- [${q.id}] ${q.question}`);
	}
	return lines.join("\n");
}

function overviewText(doc: StudyDocument): string {
	const overview = doc.sections.find((s) => !s.seed);
	return overview ? sectionText(doc, overview) : "";
}

/** The task message: the assignment, its ids, and the text it builds on.
 *  Pure, deterministic. */
export function readWriterBrief(assignment: ReadWriterAssignment, docs: StudyDocumentSet, sessionTitle: string): string {
	const doc = studyDocumentById(docs, assignment.documentId);
	if (!doc) return `The target document "${assignment.documentId}" no longer exists. Stop.`;
	const section = assignment.sectionId ? doc.sections.find((s) => s.id === assignment.sectionId) : undefined;
	const head = `Reading session: "${sessionTitle}".`;
	switch (assignment.kind) {
		case "summary": {
			if (!section) return `${head}\nThe target section no longer exists. Stop.`;
			const at = doc.sections.indexOf(section);
			const neighbors = [doc.sections[at - 1], doc.sections[at + 1]]
				.filter((s): s is StudySection => s !== undefined)
				.map((s) => s.heading);
			const subtopics = (section.suggestions ?? []).filter((t) => t.roadmap).map((t) => `- ${t.heading}`);
			return [
				head,
				`Assignment: TOPIC SUMMARY for section "${section.heading}" (${section.id}) in document "${doc.title}" (${doc.id}).`,
				`Write it with one edit_document call: documentId="${doc.id}", one section patch with id="${section.id}", a new body, and 1–3 questions. Keep the heading. Do not send suggestions — the roadmap subtopics stay as they are.`,
				"",
				"The guide's orientation:",
				overviewText(doc),
				"",
				neighbors.length ? `Neighboring topics in the guide: ${neighbors.join("; ")}.` : "",
				subtopics.length ? `This topic's roadmap subtopics (already shown as cards under the chapter):\n${subtopics.join("\n")}` : "This topic has no listed subtopics.",
			].filter((line) => line !== "").join("\n");
		}
		case "subtopics": {
			if (!section) return `${head}\nThe target section no longer exists. Stop.`;
			const wanted = new Set(assignment.subtopicIds ?? []);
			const items = (section.suggestions ?? []).filter((t) => wanted.size === 0 ? studySubtopicPending(t) : wanted.has(t.id));
			return [
				head,
				`Assignment: SUBTOPIC OVERVIEWS for the roadmap topic "${section.heading}" (${section.id}) in "${doc.title}" (${doc.id}).`,
				`Call describe_subtopics once with documentId="${doc.id}", sectionId="${section.id}", and one 1–2 sentence overview for each of these subtopic ids:`,
				...items.map((t) => `- ${t.id}: ${t.heading}`),
			].join("\n");
		}
		case "deep-dive": {
			const parentDoc = assignment.parent ? studyDocumentById(docs, assignment.parent.documentId) : null;
			const parentSection = parentDoc?.sections.find((s) => s.id === assignment.parent?.sectionId);
			const direction = parentSection?.suggestions?.find((t) => t.id === assignment.parent?.topicId);
			return [
				head,
				`Assignment: DEEP DIVE — write the pending child document "${doc.title}" (${doc.id}). It has ${doc.sections.length === 0 ? "no sections yet" : `${doc.sections.length} section(s) already`}.`,
				`Write it with edit_document and documentId="${doc.id}". Never write into any other document.`,
				direction ? `The chosen direction: "${direction.heading}" — ${direction.blurb}` : "",
				assignment.roadmapContext ?? "",
				"",
				parentDoc && parentSection ? `The chapter it comes from (the reader has just read this):\n${sectionText(parentDoc, parentSection)}` : "",
				"",
				"The session's documents (for related links and to avoid duplicates):",
				studyDocumentTreeText(docs),
			].filter((line) => line !== "").join("\n");
		}
		case "questions": {
			if (!section) return `${head}\nThe target section no longer exists. Stop.`;
			return [
				head,
				`Assignment: MORE QUESTIONS — add 2–3 new self-check questions with model answers to "${section.heading}" (${section.id}) in "${doc.title}" (${doc.id}) with add_questions (documentId="${doc.id}", sectionId="${section.id}"). Use new question ids.`,
				"",
				sectionText(doc, section, true),
			].join("\n");
		}
		case "directions": {
			if (!section) return `${head}\nThe target section no longer exists. Stop.`;
			return [
				head,
				`Assignment: FRESH DIRECTIONS — replace the deeper directions of "${section.heading}" (${section.id}) in "${doc.title}" (${doc.id}) with 2–4 better ones via suggest_deeper (documentId="${doc.id}", sectionId="${section.id}").`,
				section.suggestions?.length ? `Current directions: ${section.suggestions.filter((t) => !t.roadmap).map((t) => t.heading).join("; ") || "(none besides roadmap subtopics)"}` : "",
				"",
				sectionText(doc, section),
				"",
				"The session's documents:",
				studyDocumentTreeText(docs),
			].filter((line) => line !== "").join("\n");
		}
	}
}

/** The writer's tools: read access to every document, write access to the
 *  target only (DocumentToolContext.scope), plus the graph-map reader
 *  when the settings gate is open. */
export function readWriterTools(
	assignment: ReadWriterAssignment,
	ctx: { chatId: string; chatStore: ChatStore; graphStore?: GraphStore; onActivity?: (activity: string) => void },
): AgentTool<any>[] {
	const scope = assignment.kind === "summary" || assignment.kind === "subtopics" || assignment.kind === "questions" || assignment.kind === "directions"
		? { documentId: assignment.documentId, ...(assignment.sectionId ? { sectionId: assignment.sectionId } : {}) }
		: { documentId: assignment.documentId };
	const toolCtx: DocumentToolContext = { chatId: ctx.chatId, chatStore: ctx.chatStore, scope, onActivity: ctx.onActivity };
	const record: Record<string, AgentTool<any>> = {
		[READ_DOCUMENT_TOOL]: readDocumentTool(toolCtx),
	};
	switch (assignment.kind) {
		case "summary":
			record[EDIT_DOCUMENT_TOOL] = editDocumentTool(toolCtx);
			break;
		case "subtopics":
			record.describe_subtopics = describeSubtopicsTool(toolCtx);
			break;
		case "deep-dive":
			record[EDIT_DOCUMENT_TOOL] = editDocumentTool(toolCtx);
			record.list_documents = listDocumentsTool(toolCtx);
			break;
		case "questions":
			record.add_questions = addQuestionsTool(toolCtx);
			break;
		case "directions":
			record.suggest_deeper = suggestDeeperTool(toolCtx);
			record.list_documents = listDocumentsTool(toolCtx);
			break;
	}
	if (ctx.graphStore && (assignment.kind === "summary" || assignment.kind === "deep-dive")) {
		Object.assign(record, proberGraphTools({ chatStore: ctx.chatStore, graphStore: ctx.graphStore }));
	}
	return Object.values(healToolRecord(record));
}

/** Model-call budget per kind: a deep dive writes several sections. */
const MAX_TURNS: Record<ReadWriterKind, number> = {
	summary: 8,
	subtopics: 6,
	"deep-dive": 16,
	questions: 6,
	directions: 6,
};

export interface RunReadWriterOptions {
	assignment: ReadWriterAssignment;
	chatId: string;
	sessionTitle: string;
	chatStore: ChatStore;
	graphStore?: GraphStore;
	engine: PiEngine;
	promptSwitches?: Record<string, boolean>;
	signal?: AbortSignal;
	onUsage?: (usage: Usage) => void;
	onActivity?: (activity: string) => void;
}

/** Run one writer to completion. Throws on provider failure or abort (the
 *  queue turns that into the task's failed state). */
export async function runReadWriter(opts: RunReadWriterOptions): Promise<void> {
	const docs = opts.chatStore.readDocuments(opts.chatId);
	const tools = readWriterTools(opts.assignment, {
		chatId: opts.chatId,
		chatStore: opts.chatStore,
		graphStore: opts.graphStore,
		onActivity: opts.onActivity,
	});
	await runSubagent(tools, {
		engine: opts.engine,
		systemPrompt: composeReadWriterInstructions(opts.promptSwitches),
		prompt: readWriterBrief(opts.assignment, docs, opts.sessionTitle),
		maxTurns: MAX_TURNS[opts.assignment.kind],
		abortSignal: opts.signal,
		onUsage: opts.onUsage,
		chatId: opts.chatId,
	});
}

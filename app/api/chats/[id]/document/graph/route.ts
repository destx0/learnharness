import { bodyString, extraction, readRouteContext, sourceDirectory } from "@/src/server";
import {
	emit,
	ModelsNotConfiguredError,
	ProviderKeyMissingError,
	studyDocumentById,
	studyDocumentStatus,
	studyDocumentToMarkdown,
} from "@/src/core";

export const dynamic = "force-dynamic";

/** One path segment: the notes-path grammar refuses "/", "\\", ":" and
 *  control characters, and empty segments. */
function segment(value: string, fallback: string): string {
	const clean = value.replace(/[\\/:\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
	return clean && clean !== "." && clean !== ".." ? clean : fallback;
}

/** "Save to graph" (2026-11-15): run the knowledge-graph pipeline
 *  (extractor → auditor → merger, the notes-import front door) over one
 *  study document, so its propositions join the learner's graph with the
 *  document as their source. The source id is deterministic per session +
 *  document title, so saving again after edits re-runs against the same
 *  source (the auditor dedupes). Seed placeholders are not material: only
 *  written sections are sent.
 *
 *  The run takes minutes, so the route answers 202 once it has started; a
 *  refusal that happens before any model call (no extractor/auditor model,
 *  missing key) is reported directly. Progress shows in Background agents
 *  like any notes import. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const ctx = await readRouteContext(req, id);
	if (ctx instanceof Response) return ctx;
	const document = studyDocumentById(ctx.docs, bodyString(ctx.body, "documentId"));
	if (!document) return Response.json({ error: "No such study document" }, { status: 400 });
	if (studyDocumentStatus(document) === "writing") {
		return Response.json({ error: "This document is still being written. Save it when it is done." }, { status: 409 });
	}
	const written = { ...document, sections: document.sections.filter((section) => !section.seed) };
	if (written.sections.length === 0) {
		return Response.json({ error: "Nothing is written in this document yet." }, { status: 400 });
	}
	const filePath = `Reading/${segment(ctx.record.title, "Reading session")}/${segment(document.title, document.id)}.md`;
	sourceDirectory.registerImport(filePath);
	const run = extraction.importNotes({ filePath, text: studyDocumentToMarkdown(written) });
	run.then(() => emit("activity-changed", {})).catch((err) => {
		if (!(err instanceof ModelsNotConfiguredError) && !(err instanceof ProviderKeyMissingError)) {
			console.error(`[read ${id}] save to graph failed:`, err);
		}
	});
	// Early refusals reject before the first model call; give them a beat.
	const early = await Promise.race([
		run.then(() => null, (err: unknown) => err),
		new Promise<"started">((resolve) => setTimeout(() => resolve("started"), 400)),
	]);
	if (early instanceof ModelsNotConfiguredError || early instanceof ProviderKeyMissingError) {
		return Response.json(early.envelope, { status: 503 });
	}
	if (early instanceof Error) return Response.json({ error: early.message }, { status: 500 });
	return Response.json({ ok: true, started: early === "started", filePath }, { status: early === "started" ? 202 : 200 });
}

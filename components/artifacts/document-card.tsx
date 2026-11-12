"use client";

import { BookOpenIcon } from "lucide-react";
import type { ArtifactPartProps } from "@/src/core";

/**
 * The read session's settled document edit (read sessions, 2026-11-04).
 *
 * The document itself renders in the reading pane — NEVER here. This card is
 * the quiet transcript acknowledgment that the guide changed: one mono line
 * naming the sections touched, so the learner can see what moved without the
 * chat duplicating the prose. Failed edits render nothing (the model sees the
 * validation error and retries; the retry loop has its own line).
 */
interface DocumentEditOutput {
	ok?: boolean;
	revision?: number;
	changed?: Array<{ id: string; heading: string }>;
}

export function DocumentCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	const output = part.output as DocumentEditOutput | undefined;
	if (!output?.ok) return null;
	const changed = output.changed ?? [];
	const first = output.revision === 1;
	const label = first ? "Document created" : "Document updated";
	const names = changed.map((c) => c.heading);
	const shown = names.slice(0, 3).join(", ");
	const rest = names.length > 3 ? ` +${names.length - 3}` : "";
	return (
		<div
			data-testid="document-updated"
			className="my-2 flex items-center gap-2 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground"
		>
			<BookOpenIcon className="size-3.5 shrink-0" aria-hidden="true" />
			<span>
				{label}
				{shown ? ` · ${shown}${rest}` : ""}
			</span>
		</div>
	);
}

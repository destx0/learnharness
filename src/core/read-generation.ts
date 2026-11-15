import { emit } from "../core/events.ts";

/**
 * READ WRITER ACTIVITY (2026-11-13; one row per background writer since
 * 2026-11-15).
 *
 * Each background document writer (server/read-writers.ts) is one row in
 * the sidebar's Background agents strip: the session title, a phase
 * ("Queued" / "Writing"), and the exact work ("Deep dive · Signals",
 * "Summary · Components"). The queue owns the rows — it notes a row when
 * a writer is queued, moves it as the writer works, and clears it when
 * the writer settles. The dock's END control aborts the writer.
 *
 * Cost stays absent while running: the writer's billed usage lands in the
 * session's usage ledger when it settles, not as a live estimate.
 */

export interface ReadGenerationActivity {
	/** Row id: `read:<writer task id>` — also the abort id. */
	id: string;
	chatId: string;
	title: string;
	phase: string;
	activity: string;
	startedAt: number;
	updatedAt: number;
}

interface LhReadGenerationGlobal {
	__lhReadGenerations?: Map<string, ReadGenerationActivity>;
}

/** GlobalThis-backed so the agent tool bundles and the server activity feed
 *  share ONE registry in a Next process (the event bus's discipline). */
function active(): Map<string, ReadGenerationActivity> {
	const g = globalThis as typeof globalThis & LhReadGenerationGlobal;
	return (g.__lhReadGenerations ??= new Map());
}

/** Start or update one writer row. The first call fixes the start time;
 *  later calls move only the phase/activity. */
export function noteReadGeneration(rowId: string, chatId: string, title: string, phase: string, activity: string): void {
	const now = Date.now();
	const current = active().get(rowId);
	active().set(rowId, {
		id: rowId,
		chatId,
		title,
		phase,
		activity,
		startedAt: current?.startedAt ?? now,
		updatedAt: now,
	});
	emit("activity-changed", {});
}

/** The writer settled (or was aborted): remove its row. */
export function finishReadGeneration(rowId: string): void {
	if (active().delete(rowId)) emit("activity-changed", {});
}

export function readGenerationActivities(): ReadGenerationActivity[] {
	return [...active().values()].sort((a, b) => a.startedAt - b.startedAt);
}

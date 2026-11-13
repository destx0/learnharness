import { emit } from "../core/events.ts";

/**
 * READ GENERATION ACTIVITY (2026-11-13).
 *
 * A roadmap-seeded read turn is a bulk generation pass: main-topic
 * summaries, subtopic overviews, self-check questions. It runs inside the
 * foreground session turn, so it is not a job — but the learner asked to
 * see "what is currently generating" in the Background agents strip. This
 * tiny registry is fed by the document tools and cleared at turn
 * settlement; the activity feed joins it like any other running process.
 *
 * The title is the session title; the activity line names the exact work
 * (which sections / subtopics / questions). Cost is deliberately absent:
 * the turn's billed usage lands in the session ledger at settlement, not
 * as a live job estimate.
 */

export interface ReadGenerationActivity {
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

/** Start or update this chat's generation row. The first call fixes the
 *  start time; every later call only moves the activity/phase. */
export function noteReadGeneration(chatId: string, title: string, phase: string, activity: string): void {
	const now = Date.now();
	const current = active().get(chatId);
	active().set(chatId, {
		id: `read:${chatId}`,
		chatId,
		title,
		phase,
		activity,
		startedAt: current?.startedAt ?? now,
		updatedAt: now,
	});
	emit("activity-changed", {});
}

/** Turn settlement (or a failed start) removes the row. */
export function finishReadGeneration(chatId: string): void {
	if (active().delete(chatId)) emit("activity-changed", {});
}

export function readGenerationActivities(): ReadGenerationActivity[] {
	return [...active().values()].sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * READ GENERATION ACTIVITY (2026-11-13): the foreground guide-writing pass
 * is surfaced in the Background agents strip with its current work. The
 * registry keeps one row per chat, updates in place, and clears at turn
 * settlement.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { finishReadGeneration, noteReadGeneration, readGenerationActivities } from "../src/core/read-generation.ts";

describe("read generation activity", () => {
	it("keeps one row per chat, updates the activity, and clears on finish", () => {
		finishReadGeneration("read_a");
		noteReadGeneration("read_a", "Angular", "Writing the guide", "Writing summaries · Components");
		const first = readGenerationActivities().find((row) => row.chatId === "read_a");
		assert.equal(first?.phase, "Writing the guide");
		const startedAt = first?.startedAt;
		noteReadGeneration("read_a", "Angular", "Generating subtopics", "Subtopic overviews · Components (12)");
		const rows = readGenerationActivities().filter((row) => row.chatId === "read_a");
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.activity, "Subtopic overviews · Components (12)");
		assert.equal(rows[0]?.startedAt, startedAt);
		finishReadGeneration("read_a");
		assert.equal(readGenerationActivities().some((row) => row.chatId === "read_a"), false);
	});

	it("orders multiple sessions oldest-first", () => {
		finishReadGeneration("read_b");
		finishReadGeneration("read_c");
		noteReadGeneration("read_b", "DevOps", "Writing", "First");
		noteReadGeneration("read_c", "React", "Writing", "Second");
		const rows = readGenerationActivities();
		assert.ok(rows.findIndex((row) => row.chatId === "read_b") < rows.findIndex((row) => row.chatId === "read_c"));
		finishReadGeneration("read_b");
		finishReadGeneration("read_c");
	});
});

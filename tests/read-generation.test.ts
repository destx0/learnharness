/**
 * READ WRITER ACTIVITY (2026-11-13; one row per background writer since
 * 2026-11-15): the Background agents strip shows each document writer as
 * its own row — queued, then writing — and the row disappears when the
 * writer settles.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { finishReadGeneration, noteReadGeneration, readGenerationActivities } from "../src/core/read-generation.ts";

describe("read writer activity", () => {
	it("keeps one row per writer and moves its phase in place", () => {
		finishReadGeneration("read:w_a");
		noteReadGeneration("read:w_a", "chat_a", "Angular", "Queued", "Summary · Components");
		const first = readGenerationActivities().find((row) => row.id === "read:w_a");
		assert.equal(first?.phase, "Queued");
		noteReadGeneration("read:w_a", "chat_a", "Angular", "Writing", "Summary · Components · Wrote Components");
		const rows = readGenerationActivities().filter((row) => row.id === "read:w_a");
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.phase, "Writing");
		assert.equal(rows[0]?.startedAt, first?.startedAt, "the start time is fixed by the first note");
		finishReadGeneration("read:w_a");
		assert.equal(readGenerationActivities().some((row) => row.id === "read:w_a"), false);
	});

	it("shows parallel writers of one session as separate rows, oldest first", () => {
		noteReadGeneration("read:w_b", "chat_b", "DevOps", "Writing", "Deep dive · Docker");
		noteReadGeneration("read:w_c", "chat_b", "DevOps", "Writing", "Deep dive · Kubernetes");
		const rows = readGenerationActivities().filter((row) => row.chatId === "chat_b");
		assert.deepEqual(rows.map((row) => row.id), ["read:w_b", "read:w_c"]);
		finishReadGeneration("read:w_b");
		finishReadGeneration("read:w_c");
	});
});

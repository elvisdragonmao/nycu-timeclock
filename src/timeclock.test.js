import assert from "node:assert/strict";
import { test } from "node:test";
import { openRecord, parseTaipeiTime, planSignIn } from "./timeclock.js";

const record = (signIn, signOut = "") => ({ signIn, signOut, signInAt: parseTaipeiTime(signIn), signOutAt: parseTaipeiTime(signOut) });

test("openRecord picks the latest check-in even when the query page lists it out of order", () => {
	// Copied from the query page on 2026-10-14: 10:07 is listed before 00:13.
	const records = [record("2026-10-13 13:42", "2026-10-13 13:42"), record("2026-10-13 13:42", "2026-10-14 00:13"), record("2026-10-14 10:07"), record("2026-10-14 00:13", "2026-10-14 10:06")];
	assert.equal(openRecord(records)?.signIn, "2026-10-14 10:07");
});

test("openRecord returns null when the latest check-in is closed", () => {
	const records = [record("2026-10-14 10:07", "2026-10-14 12:01"), record("2026-10-14 00:13", "2026-10-14 10:06")];
	assert.equal(openRecord(records), null);
	assert.equal(openRecord([]), null);
});

test("planSignIn signs out an older open check-in first", () => {
	const now = parseTaipeiTime("2026-10-14 09:52");
	assert.equal(planSignIn(null, { now }), "signin");
	assert.equal(planSignIn(record("2026-10-14 00:13"), { now }), "signout-first");
	assert.equal(planSignIn(record("2026-10-14 09:00"), { now }), "signout-first");
	assert.equal(planSignIn(record("2026-10-14 09:40"), { now }), "skip");
});

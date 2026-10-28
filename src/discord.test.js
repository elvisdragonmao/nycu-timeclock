import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldNotifyDiscord } from "./discord.js";

test("successful no-op punch runs do not notify Discord", () => {
	assert.equal(shouldNotifyDiscord({ action: "signin", success: true, acted: false }), false);
	assert.equal(shouldNotifyDiscord({ action: "signout", success: true, acted: false }), false);
	assert.equal(shouldNotifyDiscord({ action: "signin", success: true, acted: true }), true);
	assert.equal(shouldNotifyDiscord({ action: "signout", success: true, acted: true }), true);
	assert.equal(shouldNotifyDiscord({ action: "signin", success: false, acted: false }), true);
	assert.equal(shouldNotifyDiscord({ action: "signout", success: false, acted: false }), true);
	assert.equal(shouldNotifyDiscord({ action: "status", success: true, acted: false }), true);
});

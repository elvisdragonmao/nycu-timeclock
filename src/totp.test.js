import assert from "node:assert/strict";
import { test } from "node:test";
import { generateTotp, parseTotpSecret } from "./totp.js";

// RFC 6238 SHA-1 test vectors, truncated to 6 digits.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("generateTotp matches RFC 6238 vectors", () => {
	assert.equal(generateTotp(RFC_SECRET, { time: 59_000 }), "287082");
	assert.equal(generateTotp(RFC_SECRET, { time: 1_111_111_109_000 }), "081804");
	assert.equal(generateTotp(RFC_SECRET, { time: 20_000_000_000_000 }), "353130");
});

test("parseTotpSecret accepts otpauth URIs", () => {
	assert.equal(parseTotpSecret(`otpauth://totp/NYCU_test?secret=${RFC_SECRET}`), RFC_SECRET);
	assert.equal(parseTotpSecret(RFC_SECRET), RFC_SECRET);
});

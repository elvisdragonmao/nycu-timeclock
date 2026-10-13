import { createHmac } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeBase32(input) {
	const clean = input.replace(/[\s=-]/g, "").toUpperCase();
	let bits = 0;
	let value = 0;
	const bytes = [];
	for (const char of clean) {
		const index = BASE32_ALPHABET.indexOf(char);
		if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(bytes);
}

/**
 * Accepts either a raw base32 secret or a full otpauth:// URI.
 */
export function parseTotpSecret(input) {
	if (input.startsWith("otpauth://")) {
		const secret = new URL(input).searchParams.get("secret");
		if (!secret) throw new Error("otpauth URI has no secret parameter");
		return secret;
	}
	return input;
}

export function generateTotp(secret, { time = Date.now(), step = 30, digits = 6 } = {}) {
	const key = decodeBase32(parseTotpSecret(secret));
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / step)));
	const hmac = createHmac("sha1", key).update(counter).digest();
	const offset = hmac[hmac.length - 1] & 0x0f;
	const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
	return code.toString().padStart(digits, "0");
}

/** Seconds left before the current code rotates. */
export function totpSecondsRemaining({ time = Date.now(), step = 30 } = {}) {
	return step - (Math.floor(time / 1000) % step);
}

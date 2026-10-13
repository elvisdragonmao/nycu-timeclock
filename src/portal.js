import { generateTotp, totpSecondsRemaining } from "./totp.js";

const PORTAL_LOGIN_URL = "https://portal.nycu.edu.tw/#/login";
const TIMECLOCK_REDIRECT_URL = "https://portal.nycu.edu.tw/#/redirect/timeclockParttime";

class TwofaError extends Error {}

/**
 * Log in to NYCU Portal. The login form is protected by reCAPTCHA v3, which is
 * why this goes through a real browser instead of calling the API directly.
 */
export async function loginPortal(page, credentials) {
	try {
		await attemptLogin(page, credentials);
	} catch (error) {
		if (!(error instanceof TwofaError)) throw error;
		// The Portal rejects a TOTP code that was already used, e.g. by a run a
		// few seconds earlier. Wait for the next code and try once more.
		await page.waitForTimeout((totpSecondsRemaining() + 1) * 1000);
		await attemptLogin(page, credentials);
	}
}

async function attemptLogin(page, { username, password, totpSecret }) {
	await page.goto(PORTAL_LOGIN_URL, { waitUntil: "networkidle" });
	await page.fill("#account", username);
	await page.fill("#password", password);

	const loginResponse = page.waitForResponse(r => r.url().endsWith("/portal/api/PortalLdapLogin"), { timeout: 60_000 });
	await page.click("button[type=submit]");
	const response = await loginResponse;
	const body = await response.json().catch(() => ({}));
	if (!body.token) throw new Error(`Portal login failed: ${body.message ?? response.status()}`);

	if (typeof body["2fa"] === "object" && body["2fa"] !== null) {
		if (!totpSecret) throw new Error("Portal asks for 2FA but NYCU_TOTP_SECRET is not set");
		const box = page.locator(".el-message-box");
		await box.waitFor({ timeout: 30_000 });
		// Avoid submitting a code that rotates before the server checks it.
		if (totpSecondsRemaining() < 5) await page.waitForTimeout(6_000);

		const twofaResponse = page.waitForResponse(r => r.url().endsWith("/portal/api/TwofaLogin"), { timeout: 60_000 });
		await box.locator("input").fill(generateTotp(totpSecret));
		await box.getByRole("button", { name: /確定|OK|Confirm/ }).click();
		const twofa = await (await twofaResponse).json().catch(() => ({}));
		if (twofa.status === "false" || !twofa.token) throw new TwofaError(`Portal 2FA failed: ${twofa.message ?? "unknown error"}`);
	}

	await page.waitForURL(url => !url.hash.startsWith("#/login"), { timeout: 30_000 });
}

/** Follow the Portal SSO relay into the part-time timeclock system. */
export async function openTimeclock(page) {
	await page.goto(TIMECLOCK_REDIRECT_URL);
	await page.waitForURL(/timeclock\.nycu\.edu\.tw\/EIP\/humanly\/BasicSetup\/OnlineProjectAttend_NYCU\.aspx/, { timeout: 60_000 });
	await page.waitForLoadState("networkidle");
}

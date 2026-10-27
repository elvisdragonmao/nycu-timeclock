const ROWS_SELECTOR = "#ContentPlaceHolder1_GridView_attend > tbody > tr";
const SIGN_IN_TEXT = /簽\s*到|Sign\s*In/i;
const SIGN_OUT_TEXT = /簽\s*退|Sign\s*Out/i;
const DEFAULT_REASON = /調課/;

export function todayInTaipei(date = new Date()) {
	return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(date);
}

/** Parse a timeclock timestamp such as "2026-10-14 08:00" as Taipei time. */
export function parseTaipeiTime(text) {
	const match = text.match(/(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})/);
	return match ? new Date(`${match[1]}T${match[2].padStart(2, "0")}:${match[3]}:00+08:00`) : null;
}

/** Read every project row and the sign-in/sign-out buttons it currently offers. */
export async function readProjects(page) {
	const rows = await page.$$eval(ROWS_SELECTOR, trs =>
		trs.map(tr => {
			const cells = tr.querySelectorAll(":scope > td");
			const info = cells[1];
			const paragraphs = info ? [...info.querySelectorAll("p")].map(p => p.innerText.trim()) : [];
			const buttons = cells[2] ? [...cells[2].querySelectorAll("a.input-button")].map(a => ({ id: a.id, text: a.innerText.replace(/\s+/g, "") })) : [];
			return {
				category: cells[0]?.innerText.trim() ?? "",
				title: paragraphs[0] ?? "",
				hours: paragraphs[1] ?? "",
				history: paragraphs[2] ?? "",
				warning: info?.querySelector("font[color=red]")?.innerText.trim() ?? "",
				queryUrl: cells[2]?.querySelector("a[id*=HyperLink_query]")?.href ?? null,
				buttons
			};
		})
	);

	return rows.map((row, index) => {
		const signInButton = row.buttons.find(b => b.id.includes("signIn") || (SIGN_IN_TEXT.test(b.text) && !SIGN_OUT_TEXT.test(b.text)));
		const signOutButton = row.buttons.find(b => b.id.includes("signOut") || SIGN_OUT_TEXT.test(b.text));
		return {
			index,
			...row,
			signInButtonId: signInButton?.id ?? null,
			signOutButtonId: signOutButton?.id ?? null
		};
	});
}

/** Projects that still accept punches show a sign-in or sign-out button. */
export function activeProjects(projects) {
	return projects.filter(p => p.signInButtonId || p.signOutButtonId);
}

/** Whether the portal says this project still needs credited hours. */
export function hasRemainingHours(hours) {
	const remaining = hours.match(/尚缺[：:]\s*(\d+(?:\.\d+)?)\s*小時/);
	if (remaining) return Number(remaining[1]) > 0;

	// If the portal changes its wording, keep the existing behavior rather than
	// silently skipping a project that may still need hours.
	return true;
}

/**
 * Read a project's attendance records from its query page. The list page's
 * "本日" summary lags behind around midnight, so this is what we trust.
 */
export async function readRecords(page, project) {
	if (!project.queryUrl) return [];
	const viewer = await page.context().newPage();
	try {
		await viewer.goto(project.queryUrl, { waitUntil: "networkidle" });
		const rows = await viewer.$$eval("tr", trs => trs.map(tr => [...tr.querySelectorAll(":scope > td")].map(td => td.innerText.trim())));
		return rows
			.filter(cells => cells.length >= 4 && /^\d{4}-\d{2}-\d{2}$/.test(cells[0]))
			.map(([date, weekday, signIn, signOut, note = ""]) => ({ date, weekday, signIn, signOut, note, signInAt: parseTaipeiTime(signIn), signOutAt: parseTaipeiTime(signOut) }));
	} finally {
		await viewer.close();
	}
}

/**
 * The latest record, if it has a check-in but no check-out yet. The query page
 * does not list records of the same day in time order, so sort them first.
 */
export function openRecord(records) {
	const latest = records
		.filter(r => r.signInAt)
		.sort((a, b) => a.signInAt - b.signInAt)
		.at(-1);
	return latest && !latest.signOutAt ? latest : null;
}

/** How long a record has been open, in hours. */
export function openHours(record, now = new Date()) {
	return (now - record.signInAt) / 3_600_000;
}

/**
 * Decide what a sign-in run should do. A check-in opened in the last few
 * minutes most likely comes from a duplicate run, so leave it running instead
 * of cutting the block short. Any older open check-in is signed out first.
 */
export function planSignIn(open, { now = new Date(), recentMinutes = 30 } = {}) {
	if (!open) return "signin";
	return now - open.signInAt < recentMinutes * 60_000 ? "skip" : "signout-first";
}

/**
 * During class hours the confirmation panel asks for a reason as a group of
 * radio buttons (調課、停課、課程已請假、其他). Pick the configured one.
 */
async function answerReasonPrompt(panel, reason, log) {
	const radios = panel.locator("input[type=radio]");
	if (!(await radios.count())) return;

	const labels = await panel.locator("label").evaluateAll(els => els.map(el => ({ text: el.innerText.trim(), for: el.htmlFor })));
	const choice = labels.find(label => reason.test(label.text));
	if (!choice) throw new Error(`確認畫面要求選擇原因，但找不到符合 ${reason} 的選項：${labels.map(l => l.text).join("、")}`);

	log(`選擇原因：${choice.text}`);
	await panel.locator(`[id="${choice.for}"]`).check();
}

/**
 * Click the sign-in/sign-out button for one project, then confirm on the
 * follow-up panel. Returns any alert messages the page showed.
 */
export async function punch(page, project, action, { reason = DEFAULT_REASON, log = () => {} } = {}) {
	const buttonId = action === "signin" ? project.signInButtonId : project.signOutButtonId;
	if (!buttonId) throw new Error(`No ${action} button for ${project.title}`);

	const dialogs = [];
	const onDialog = async dialog => {
		dialogs.push(dialog.message());
		await dialog.accept();
	};
	page.on("dialog", onDialog);
	try {
		await Promise.all([page.waitForNavigation({ waitUntil: "load", timeout: 60_000 }), page.locator(`[id="${buttonId}"]`).click()]);

		const panel = page.locator("#ContentPlaceHolder1_Panel_sign");
		await panel.waitFor({ timeout: 30_000 });
		log(`確認畫面：${(await panel.locator("#Table2").innerText()).replace(/\s+/g, " ").trim()}`);
		await answerReasonPrompt(panel, reason, log);

		await Promise.all([page.waitForNavigation({ waitUntil: "load", timeout: 60_000 }), page.locator("#ContentPlaceHolder1_Button_attend").click()]);
		await page.waitForLoadState("networkidle");
		const notice = page.locator("#ContentPlaceHolder1_Panel_sign:visible");
		if (await notice.count()) throw new Error(`確定後仍停在確認畫面：${(await notice.innerText()).replace(/\s+/g, " ").trim()}`);
		if (!(await page.locator(ROWS_SELECTOR).count())) {
			throw new Error(`確定後沒有回到計畫列表：${(await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
		}
	} finally {
		page.off("dialog", onDialog);
	}
	return dialogs;
}

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

/** The latest record that has a check-in but no check-out yet. */
export function openRecord(records) {
	const last = records.at(-1);
	return last?.signInAt && !last.signOutAt ? last : null;
}

/**
 * Signing out a check-in from an earlier day, or one open for longer than a
 * normal shift, would create a record the timeclock rules forbid (cross-day,
 * or more than 4 hours without a break). Those need a human to fix.
 */
export function isStaleCheckIn(record, { now = new Date(), maxHours = 6 } = {}) {
	if (!record?.signInAt) return false;
	return todayInTaipei(record.signInAt) !== todayInTaipei(now) || now - record.signInAt > maxHours * 3_600_000;
}

/**
 * Some sign-ins (e.g. in the afternoon) ask for a reason on the confirmation
 * panel. Pick the configured reason from any dropdown that offers it.
 */
async function answerReasonPrompt(panel, reason, log) {
	const selects = panel.locator("select");
	for (let i = 0; i < (await selects.count()); i++) {
		const select = selects.nth(i);
		const label = (await select.locator("option").allInnerTexts()).find(text => reason.test(text));
		if (!label) continue;

		log(`選擇原因：${label.trim()}`);
		const page = panel.page();
		const autoPostBack = ((await select.getAttribute("onchange")) ?? "").includes("__doPostBack");
		await Promise.all([autoPostBack ? page.waitForNavigation({ waitUntil: "load" }) : null, select.selectOption({ label })]);
		return true;
	}
	return false;
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

import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { notifyDiscord } from "./discord.js";
import { loginPortal, openTimeclock } from "./portal.js";
import { activeProjects, hasRemainingHours, openHours, openRecord, planSignIn, punch, readProjects, readRecords, todayInTaipei } from "./timeclock.js";

const USAGE = `Usage: node src/index.js <signin|signout|status> [--dry-run] [--not-before HH:MM]

  signin                簽到所有進行中的計畫；有未簽退的紀錄會先簽退
                        （30 分鐘內剛簽到的視為重複執行，略過）
  signout               簽退所有未簽退的計畫
  status                只列出計畫與目前狀態
  --dry-run             登入並判斷要做什麼，但不實際點擊
  --not-before HH:MM    等到台灣時間 HH:MM 才打卡（用來抵銷排程延遲）`;

const ACTION_LABELS = { signin: "簽到", signout: "簽退", status: "查詢" };

const { values: flags, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		"dry-run": { type: "boolean", default: false },
		"not-before": { type: "string" },
		help: { type: "boolean", short: "h", default: false }
	}
});

const action = positionals[0];
if (flags.help || !ACTION_LABELS[action]) {
	console.log(USAGE);
	process.exit(flags.help ? 0 : 2);
}

const env = process.env;
if (flags["not-before"] && !/^\d{1,2}:\d{2}$/.test(flags["not-before"])) {
	console.error(`--not-before must look like HH:MM, got ${flags["not-before"]}`);
	process.exit(2);
}

for (const name of ["NYCU_USERNAME", "NYCU_PASSWORD"]) {
	if (!env[name]) {
		console.error(`Missing environment variable ${name}`);
		process.exit(2);
	}
}

const lines = [];
const log = message => {
	console.log(message);
	lines.push(message);
};

function describe(project, open) {
	const status = open ? `未簽退：${open.signIn} 簽到` : "";
	return [project.title, project.hours, project.history.replace(/\n+/g, " / "), project.warning, status].filter(Boolean).join("\n  ");
}

async function saveDebug(page) {
	const dir = env.DEBUG_DIR ?? "debug";
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	await mkdir(dir, { recursive: true });
	await page.screenshot({ path: `${dir}/${stamp}.png`, fullPage: true }).catch(() => {});
	await writeFile(`${dir}/${stamp}.html`, await page.content()).catch(() => {});
	console.error(`Saved debug snapshot to ${dir}/${stamp}.{png,html}`);
}

/** Sleep until the given Taipei wall-clock time today, if it is still ahead. */
async function waitUntilTaipei(hhmm) {
	const [hours, minutes] = hhmm.split(":");
	const target = new Date(`${todayInTaipei()}T${hours.padStart(2, "0")}:${minutes}:00+08:00`);
	const delay = target - Date.now();
	if (delay <= 0) return;
	console.log(`Waiting until ${hhmm} Asia/Taipei (${Math.ceil(delay / 1000)}s)`);
	await new Promise(resolve => setTimeout(resolve, delay));
}

/** Long open records usually mean a punch was missed; flag them in the report. */
function warnIfLong(open) {
	const hours = openHours(open);
	if (hours > 6) log(`⚠ ${open.signIn} 的簽到已經開著 ${hours.toFixed(1)} 小時，簽退後會是一筆很長的紀錄，請確認是否需要請計畫主持人調整`);
}

/** Punch once, then confirm the result on the record viewer. */
async function punchAndVerify(page, title, action) {
	const project = (await readProjects(page)).find(p => p.title === title);
	const buttonId = action === "signin" ? project?.signInButtonId : project?.signOutButtonId;
	if (!buttonId) {
		log(`✗ 列表頁沒有${ACTION_LABELS[action]}按鈕：${title}`);
		await saveDebug(page);
		return false;
	}

	const dialogs = await punch(page, project, action, { log });
	for (const message of dialogs) log(`網頁訊息：${message}`);

	const after = openRecord(await readRecords(page, project));
	const done = action === "signin" ? Boolean(after) : !after;
	const summary = (await readProjects(page)).find(p => p.title === title) ?? project;
	log(`${done ? "✓" : "✗"} ${ACTION_LABELS[action]}${done ? "成功" : "後紀錄不符預期"}：\n  ${describe(summary, after)}`);
	if (!done) await saveDebug(page);
	return done;
}

async function run(page) {
	await loginPortal(page, { username: env.NYCU_USERNAME, password: env.NYCU_PASSWORD, totpSecret: env.NYCU_TOTP_SECRET });
	await openTimeclock(page);

	const projects = await readProjects(page);
	if (action === "status") {
		for (const project of projects) {
			const open = activeProjects([project]).length ? openRecord(await readRecords(page, project)) : null;
			log(`- ${describe(project, open)}`);
		}
		return true;
	}

	let ok = true;
	let acted = false;
	for (const project of activeProjects(await readProjects(page))) {
		const open = openRecord(await readRecords(page, project));
		const steps = [];
		if (action === "signout") {
			if (open) steps.push("signout");
			else log(`• 沒有未簽退的紀錄，略過\n  ${describe(project)}`);
		} else if (!hasRemainingHours(project.hours)) {
			if (open) {
				log(`• 工時已滿；只簽退目前未結束的紀錄，不再簽到`);
				steps.push("signout");
			} else {
				log(`• 工時已滿，略過簽到\n  ${describe(project)}`);
			}
		} else {
			const plan = planSignIn(open);
			if (plan === "skip") log(`• ${open.signIn} 剛簽到，略過\n  ${describe(project, open)}`);
			if (plan === "signout-first") {
				log(`• 發現 ${open.signIn} 的簽到尚未簽退，先簽退再簽到`);
				steps.push("signout");
			}
			if (plan !== "skip") steps.push("signin");
		}

		if (open && steps[0] === "signout") warnIfLong(open);
		for (const step of steps) {
			acted = true;
			if (flags["dry-run"]) {
				log(`(dry run) 會${ACTION_LABELS[step]}：\n  ${describe(project, open)}`);
				continue;
			}
			if (!(await punchAndVerify(page, project.title, step))) {
				ok = false;
				break;
			}
		}
	}

	if (!acted) log(`沒有需要${ACTION_LABELS[action]}的計畫`);
	return ok;
}

// Wait before logging in, so a long wait cannot outlive the Portal session.
if (flags["not-before"] && !flags["dry-run"]) await waitUntilTaipei(flags["not-before"]);

const browser = await chromium.launch({ headless: env.HEADLESS !== "false" });
const context = await browser.newContext({ locale: "zh-TW", timezoneId: "Asia/Taipei" });
const page = await context.newPage();

let ok = false;
try {
	ok = await run(page);
} catch (error) {
	log(`✗ 發生錯誤：${error.message}`);
	await saveDebug(page);
} finally {
	await browser.close();
}

await notifyDiscord(env.DISCORD_WEBHOOK_URL, {
	title: `NYCU ${ACTION_LABELS[action]}${flags["dry-run"] ? "（dry run）" : ""}${ok ? "完成" : "失敗"}`,
	description: lines.join("\n"),
	success: ok
});
process.exit(ok ? 0 : 1);

import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { notifyDiscord } from "./discord.js";
import { loginPortal, openTimeclock } from "./portal.js";
import { activeProjects, isStaleCheckIn, openRecord, punch, readProjects, readRecords, todayInTaipei } from "./timeclock.js";

const USAGE = `Usage: node src/index.js <signin|signout|status> [--dry-run] [--not-before HH:MM] [--allow-stale]

  signin                簽到所有目前可以簽到的計畫
  signout               簽退所有目前可以簽退的計畫
  status                只列出計畫與目前狀態
  --dry-run             登入並判斷要做什麼，但不實際點擊
  --not-before HH:MM    等到台灣時間 HH:MM 才打卡（用來抵銷排程延遲）
  --allow-stale         允許簽退跨日或超過 6 小時的簽到紀錄`;

const ACTION_LABELS = { signin: "簽到", signout: "簽退", status: "查詢" };

const { values: flags, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		"dry-run": { type: "boolean", default: false },
		"allow-stale": { type: "boolean", default: false },
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

	const plan = [];
	let ok = true;
	for (const project of activeProjects(projects)) {
		const open = openRecord(await readRecords(page, project));
		const stale = isStaleCheckIn(open);
		if (action === "signin") {
			if (open && stale) {
				log(`✗ 無法簽到：${open.signIn} 的簽到尚未簽退，而且已經跨日或超過 6 小時，請聯絡計畫主持人維護工時\n  ${describe(project, open)}`);
				ok = false;
			} else if (open) {
				log(`• ${open.signIn} 已簽到，略過\n  ${describe(project, open)}`);
			} else if (project.signInButtonId) {
				plan.push(project);
			}
		} else if (!open) {
			log(`• 沒有未簽退的紀錄，略過\n  ${describe(project)}`);
		} else if (stale && !flags["allow-stale"]) {
			log(`✗ 不簽退：${open.signIn} 的簽到已經跨日或超過 6 小時，簽退會產生不合規的紀錄（用 --allow-stale 強制）\n  ${describe(project, open)}`);
			ok = false;
		} else if (!project.signOutButtonId) {
			log(`✗ 有 ${open.signIn} 的未簽退紀錄，但列表頁沒有簽退按鈕\n  ${describe(project, open)}`);
			ok = false;
		} else {
			plan.push(project);
		}
	}

	if (plan.length === 0) {
		log(`沒有需要${ACTION_LABELS[action]}的計畫`);
		return ok;
	}

	if (flags["not-before"] && !flags["dry-run"]) {
		await waitUntilTaipei(flags["not-before"]);
		// The session may have been idle for a while; reload the list before clicking.
		await openTimeclock(page);
	}

	for (const planned of plan) {
		if (flags["dry-run"]) {
			log(`(dry run) 會${ACTION_LABELS[action]}：\n  ${describe(planned)}`);
			continue;
		}

		const project = (await readProjects(page)).find(p => p.title === planned.title) ?? planned;
		const dialogs = await punch(page, project, action, { log });
		for (const message of dialogs) log(`網頁訊息：${message}`);

		const after = openRecord(await readRecords(page, project));
		const done = action === "signin" ? Boolean(after) : !after;
		const summary = (await readProjects(page)).find(p => p.title === project.title) ?? project;
		log(`${done ? "✓" : "✗"} ${ACTION_LABELS[action]}${done ? "成功" : "後紀錄不符預期"}：\n  ${describe(summary, after)}`);
		if (!done) {
			ok = false;
			await saveDebug(page);
		}
	}
	return ok;
}

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

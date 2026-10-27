/** Skip routine Discord messages when a sign-in run had nothing to do. */
export function shouldNotifyDiscord({ action, success, acted }) {
	return action !== "signin" || !success || acted;
}

/** Post a message to a Discord webhook. Does nothing when no webhook is configured. */
export async function notifyDiscord(webhookUrl, { title, description, success }) {
	if (!webhookUrl) return;
	const response = await fetch(webhookUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			embeds: [
				{
					title,
					description: description.slice(0, 4000),
					color: success ? 0x2ecc71 : 0xe74c3c,
					timestamp: new Date().toISOString()
				}
			]
		})
	});
	if (!response.ok) console.error(`Discord webhook failed: ${response.status} ${await response.text()}`);
}

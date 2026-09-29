import type { PluginContext } from "emdash/plugin";

/** Discord embed limits: https://discord.com/developers/docs/resources/message#embed-object-embed-limits */
export interface Embed {
	title?: string;
	description?: string;
	url?: string;
	color?: number;
	timestamp?: string;
	fields?: Array<{ name: string; value: string; inline?: boolean }>;
	footer?: { text: string };
}

export interface WebhookPayload {
	content?: string;
	username?: string;
	avatar_url?: string;
	allowed_mentions: { parse: Array<"roles" | "users" | "everyone"> };
	embeds: Embed[];
}

const WEBHOOK_RE = /^https:\/\/(?:discord|discordapp)\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/;

export function isDiscordWebhookUrl(value: string): boolean {
	return WEBHOOK_RE.test(value.trim());
}

export function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function sanitizeEmbed(embed: Embed): Embed {
	return {
		...embed,
		title: embed.title ? truncate(embed.title, 256) : undefined,
		description: embed.description ? truncate(embed.description, 4000) : undefined,
		fields: embed.fields?.slice(0, 25).map((f) => ({
			name: truncate(f.name || "-", 256),
			value: truncate(f.value || "-", 1024),
			inline: f.inline,
		})),
		footer: embed.footer ? { text: truncate(embed.footer.text, 2048) } : undefined,
	};
}

export type SendResult = { ok: true; status: number } | { ok: false; status?: number; error: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** POST to a Discord webhook. Honors one 429 `retry_after` (max 3s), then gives up. */
export async function sendDiscord(
	ctx: PluginContext,
	url: string,
	payload: WebhookPayload,
): Promise<SendResult> {
	if (!ctx.http) return { ok: false, error: "network:request capability is not available" };
	if (!isDiscordWebhookUrl(url)) return { ok: false, error: "Not a valid Discord webhook URL" };

	const body = JSON.stringify({ ...payload, embeds: payload.embeds.map(sanitizeEmbed) });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const res = await ctx.http.fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});
			if (res.ok) return { ok: true, status: res.status };
			if (res.status === 429 && attempt === 0) {
				const data = (await res.json().catch(() => null)) as { retry_after?: number } | null;
				const wait = Math.min(3000, Math.ceil((data?.retry_after ?? 1) * 1000));
				await sleep(wait);
				continue;
			}
			return { ok: false, status: res.status, error: `Discord responded with HTTP ${res.status}` };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : "Network error" };
		}
	}
	return { ok: false, status: 429, error: "Rate limited by Discord" };
}

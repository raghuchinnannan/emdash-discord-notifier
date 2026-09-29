import type { PluginContext } from "emdash/plugin";

import { channelUrl, loadConfig, type Config } from "./config.js";
import { sendDiscord, type Embed, type SendResult, type WebhookPayload } from "./discord.js";
import { applyTemplate } from "./embeds.js";
import { EVENT_BY_ID, type EventId } from "./events.js";

export interface DeliveryRecord {
	at: string;
	event: EventId;
	title: string;
	status: "ok" | "failed";
	error?: string;
	/** JSON of the payload, kept so a failed delivery can be retried from the admin page. */
	payload: string;
}

const MAX_DELIVERIES = 200;
const PRUNE_BATCH = 50;

export interface Notice {
	event: EventId;
	embed: Embed;
	collection?: string;
	/** Values for {placeholders} in the Pro message template. */
	vars?: Record<string, string>;
}

/** Compute `allowed_mentions` so untrusted text (comment bodies, form values) can never ping anyone. */
export function allowedMentions(mention: string): WebhookPayload["allowed_mentions"] {
	const parse: Array<"roles" | "users" | "everyone"> = [];
	if (/<@&\d+>/.test(mention)) parse.push("roles");
	if (/<@!?\d+>/.test(mention)) parse.push("users");
	if (/@everyone|@here/.test(mention)) parse.push("everyone");
	return { parse };
}

export function buildPayload(config: Config, notice: Notice): WebhookPayload {
	const embed = { ...notice.embed };
	if (config.accent !== null) embed.color = config.accent;

	const parts: string[] = [];
	if (config.mention) parts.push(config.mention);
	if (config.template) {
		parts.push(applyTemplate(config.template, { event: notice.event, ...(notice.vars ?? {}) }));
	}
	return {
		content: parts.length ? parts.join(" ").slice(0, 1900) : undefined,
		username: config.username || undefined,
		avatar_url: config.avatarUrl || undefined,
		allowed_mentions: allowedMentions(config.mention),
		embeds: [embed],
	};
}

export async function recordDelivery(ctx: PluginContext, record: DeliveryRecord): Promise<void> {
	const deliveries = ctx.storage.deliveries;
	if (!deliveries) return;
	await deliveries.put(`${record.at}_${crypto.randomUUID().slice(0, 8)}`, record);
	for (;;) {
		const excess = (await deliveries.count()) - MAX_DELIVERIES;
		if (excess <= 0) return;
		const oldest = await deliveries.query({ orderBy: { at: "asc" }, limit: Math.min(excess, PRUNE_BATCH) });
		if (oldest.items.length === 0) return;
		await deliveries.deleteMany(oldest.items.map((i) => i.id));
	}
}

/** Decide whether a notice should go out, send it, and log the result. Never throws. */
export async function notify(ctx: PluginContext, notice: Notice): Promise<void> {
	try {
		const config = await loadConfig(ctx);
		const def = EVENT_BY_ID.get(notice.event);
		if (!def || !config.enabled || !config.events[notice.event]) return;
		if (def.pro && !config.pro) return;
		if (config.collections.length && notice.collection && !config.collections.includes(notice.collection)) return;

		const url = channelUrl(config, def.category);
		if (!url) return;

		const payload = buildPayload(config, notice);
		const result = await sendDiscord(ctx, url, payload);
		await logResult(ctx, notice, payload, result);
	} catch (error) {
		ctx.log.error("Discord notification failed", { event: notice.event, error: String(error) });
	}
}

async function logResult(ctx: PluginContext, notice: Notice, payload: WebhookPayload, result: SendResult) {
	if (!result.ok) ctx.log.warn("Discord delivery failed", { event: notice.event, error: result.error });
	await recordDelivery(ctx, {
		at: new Date().toISOString(),
		event: notice.event,
		title: notice.embed.title ?? notice.event,
		status: result.ok ? "ok" : "failed",
		error: result.ok ? undefined : result.error,
		payload: JSON.stringify(payload),
	}).catch(() => {});
}

/** Re-send a stored payload (used by the delivery log's Retry action and the digest). */
export async function sendStored(ctx: PluginContext, event: EventId, payloadJson: string): Promise<SendResult> {
	const config = await loadConfig(ctx);
	const def = EVENT_BY_ID.get(event);
	const url = def ? channelUrl(config, def.category) : config.webhookUrl;
	if (!url) return { ok: false, error: "No webhook URL configured for this event." };
	return sendDiscord(ctx, url, JSON.parse(payloadJson) as WebhookPayload);
}

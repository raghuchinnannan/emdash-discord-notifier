import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";

import { loadConfig, parseColor } from "./config.js";
import { isDiscordWebhookUrl, sendDiscord } from "./discord.js";
import { digestEmbed } from "./embeds.js";
import { EVENT_BY_ID, EVENTS, settingKey } from "./events.js";
import { activateLicense, deactivateLicense, getLicenseState, isPro } from "./license.js";
import { sendStored, type DeliveryRecord } from "./notify.js";

type Values = Record<string, unknown>;
type Blocks = BlockResponse;

export const PLUGIN_SLUG = "discord-notifier";
const CHANNELS = ["content", "comments", "media", "forms"] as const;

const toast = (message: string, type: "success" | "error" = "success") => ({ message, type });
const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function formsRelayPath(token: string): string {
	return `/_emdash/api/plugins/${PLUGIN_SLUG}/forms?token=${encodeURIComponent(token)}`;
}

async function ensureFormsToken(ctx: PluginContext): Promise<string> {
	let token = await ctx.settings.get<string>("formsToken");
	if (!token) {
		token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
		await ctx.settings.set("formsToken", token);
	}
	return token;
}

// ── Pages ──

export async function buildSettingsPage(ctx: PluginContext): Promise<Blocks> {
	const config = await loadConfig(ctx);
	const state = await getLicenseState(ctx);
	const hasKey = (await ctx.settings.get<string>("licenseKey")) !== null;
	const get = async <T>(key: string, fallback: T) => (await ctx.settings.get<T>(key)) ?? fallback;

	const has = async (key: string) => (await ctx.settings.get<string>(key)) !== null;
	const proNote = config.pro ? "" : " (Pro)";
	const channelHasValue = Object.fromEntries(
		await Promise.all(CHANNELS.map(async (c) => [c, await has(`${c}WebhookUrl`)] as const)),
	);

	const blocks: Block[] = [
		{ type: "header", text: "Discord Notifier" },
		config.pro
			? { type: "banner", variant: "default", description: `Pro is active${state?.variant ? ` (${state.variant})` : ""}.` }
			: {
					type: "banner",
					variant: "default",
					description: "Free plan: one webhook and the core events. Enter a Pro or Extended license key below to unlock channel routing, filters, mentions, templates, digests, form relay and the delivery log.",
				},
		{
			type: "form",
			block_id: "settings",
			fields: [
				{
					type: "secret_input",
					action_id: "webhookUrl",
					label: "Discord webhook URL",
					has_value: await has("webhookUrl"),
				},
				{ type: "toggle", action_id: "enabled", label: "Send notifications", initial_value: config.enabled },
				{ type: "text_input", action_id: "username", label: "Bot name (optional)", initial_value: config.username },
				{ type: "text_input", action_id: "avatarUrl", label: "Bot avatar URL (optional)", initial_value: config.avatarUrl },
				...EVENTS.map((e) => ({
					type: "toggle" as const,
					action_id: settingKey(e.id),
					label: e.label + (e.pro && !config.pro ? " (Pro)" : ""),
					initial_value: config.events[e.id],
				})),
				{ type: "text_input", action_id: "collections", label: `Only these collections, comma-separated${proNote}`, initial_value: (await get("collections", "")) },
				{ type: "text_input", action_id: "mention", label: `Mention on every message, e.g. <@&ROLE_ID>${proNote}`, initial_value: (await get("mention", "")) },
				{ type: "text_input", action_id: "template", label: `Message template: {event} {title} {collection} {author}${proNote}`, initial_value: (await get("template", "")) },
				{ type: "text_input", action_id: "accent", label: `Embed colour override, hex like #5865F2${proNote}`, initial_value: (await get("accent", "")) },
				...CHANNELS.map((c) => ({
					type: "secret_input" as const,
					action_id: `${c}WebhookUrl`,
					label: `Separate webhook for ${c}${proNote}`,
					has_value: channelHasValue[c],
				})),
				{
					type: "select",
					action_id: "digest",
					label: `Activity digest${proNote}`,
					options: [
						{ label: "Off", value: "off" },
						{ label: "Daily (09:00 UTC)", value: "daily" },
						{ label: "Weekly (Mon 09:00 UTC)", value: "weekly" },
					],
					initial_value: await get("digest", "off"),
				},
				{ type: "toggle", action_id: "formsIncludeData", label: `Include form field values${proNote}`, initial_value: await get("formsIncludeData", true) },
			],
			submit: { label: "Save settings", action_id: "save_settings" },
		},
		{
			type: "actions",
			elements: [{ type: "button", label: "Send test message", action_id: "test_webhook", style: "primary" }],
		},
		{ type: "divider" },
		{ type: "header", text: "License" },
		{
			type: "form",
			block_id: "license",
			fields: [{ type: "secret_input", action_id: "licenseKey", label: "Pro / Extended license key", has_value: hasKey }],
			submit: { label: "Activate license", action_id: "activate_license" },
		},
	];

	if (state) {
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "button",
					label: "Deactivate on this site",
					action_id: "deactivate_license",
					confirm: {
						title: "Deactivate license?",
						text: "This frees the activation so you can use the key on another site.",
						confirm: "Deactivate",
						deny: "Cancel",
					},
				},
			],
		});
	}

	if (config.pro) {
		const token = await ensureFormsToken(ctx);
		blocks.push(
			{ type: "divider" },
			{ type: "header", text: "Form submissions relay" },
			{
				type: "section",
				text:
					"In the Forms plugin, open a form's settings and set **Webhook URL** to the address below. Every submission is then relayed to Discord.",
			},
			{ type: "code", language: "bash", code: ctx.url(formsRelayPath(token)) },
			{
				type: "actions",
				elements: [
					{
						type: "button",
						label: "Regenerate token",
						action_id: "regenerate_token",
						confirm: {
							title: "Regenerate token?",
							text: "Existing form webhooks stop working until you update their URL.",
							confirm: "Regenerate",
							deny: "Cancel",
						},
					},
				],
			},
		);
	}
	return { blocks };
}

export async function buildLogPage(ctx: PluginContext): Promise<Blocks> {
	if (!(await isPro(ctx))) {
		return {
			blocks: [
				{ type: "header", text: "Delivery log" },
				{ type: "banner", variant: "default", description: "The delivery log with retry is part of Pro." },
			],
		};
	}
	const result = await ctx.storage.deliveries!.query({ orderBy: { at: "desc" }, limit: 50 });
	return {
		blocks: [
			{ type: "header", text: "Delivery log" },
			{
				type: "table",
				columns: [
					{ key: "at", label: "When", format: "relative_time" },
					{ key: "event", label: "Event", format: "text" },
					{ key: "title", label: "Message", format: "text" },
					{ key: "status", label: "Status", format: "badge" },
					{ key: "action", label: "", format: "element" },
				],
				rows: result.items.map((item) => {
					const d = item.data as DeliveryRecord;
					return {
						at: d.at,
						event: EVENT_BY_ID.get(d.event)?.label ?? d.event,
						title: d.title,
						status: d.status === "ok" ? "Sent" : `Failed: ${d.error ?? "unknown"}`,
						action:
							d.status === "failed"
								? { type: "button", label: "Retry", action_id: "retry_delivery", value: item.id }
								: undefined,
					};
				}),
				page_action_id: "load_page",
				empty_text: "No notifications sent yet",
			},
		],
	};
}

export async function buildWidget(ctx: PluginContext): Promise<Blocks> {
	const config = await loadConfig(ctx);
	const deliveries = ctx.storage.deliveries!;
	const [ok, failed] = await Promise.all([deliveries.count({ status: "ok" }), deliveries.count({ status: "failed" })]);
	return {
		blocks: [
			{
				type: "fields",
				fields: [
					{ label: "Status", value: config.webhookUrl && config.enabled ? "Active" : "Not configured" },
					{ label: "Plan", value: config.pro ? "Pro" : "Free" },
				],
			},
			{ type: "stats", items: [{ label: "Sent", value: String(ok) }, { label: "Failed", value: String(failed) }] },
		],
	};
}

// ── Actions ──

export async function saveSettings(ctx: PluginContext, values: Values): Promise<Blocks> {
	const secretUrls = ["webhookUrl", ...CHANNELS.map((c) => `${c}WebhookUrl`)];
	for (const key of secretUrls) {
		const value = s(values[key]);
		if (!value) continue; // masked field left untouched
		if (!isDiscordWebhookUrl(value)) {
			return { ...(await buildSettingsPage(ctx)), toast: toast(`"${key}" is not a Discord webhook URL (https://discord.com/api/webhooks/...).`, "error") };
		}
		await ctx.settings.set(key, value);
	}
	if (typeof values.enabled === "boolean") await ctx.settings.set("enabled", values.enabled);
	for (const key of ["username", "avatarUrl", "collections", "mention", "template", "accent"]) {
		if (typeof values[key] === "string") await ctx.settings.set(key, s(values[key]));
	}
	const accent = s(values.accent);
	if (accent && parseColor(accent) === null) {
		return { ...(await buildSettingsPage(ctx)), toast: toast("Colour must be a hex value like #5865F2.", "error") };
	}
	for (const e of EVENTS) {
		const v = values[settingKey(e.id)];
		if (typeof v === "boolean") await ctx.settings.set(settingKey(e.id), v);
	}
	if (typeof values.formsIncludeData === "boolean") await ctx.settings.set("formsIncludeData", values.formsIncludeData);
	if (typeof values.digest === "string") {
		await ctx.settings.set("digest", values.digest);
		await syncDigestSchedule(ctx);
	}
	return { ...(await buildSettingsPage(ctx)), toast: toast("Settings saved") };
}

export async function testWebhook(ctx: PluginContext): Promise<Blocks> {
	const config = await loadConfig(ctx);
	if (!config.webhookUrl) {
		return { ...(await buildSettingsPage(ctx)), toast: toast("Save a webhook URL first.", "error") };
	}
	const result = await sendDiscord(ctx, config.webhookUrl, {
		username: config.username || undefined,
		avatar_url: config.avatarUrl || undefined,
		allowed_mentions: { parse: [] },
		embeds: [{ title: "Discord Notifier is connected", description: "This is a test message from EmDash.", color: 0x5865f2 }],
	});
	return {
		...(await buildSettingsPage(ctx)),
		toast: result.ok ? toast("Test message sent") : toast(`Test failed: ${result.error}`, "error"),
	};
}

export async function activate(ctx: PluginContext, values: Values): Promise<Blocks> {
	const key = s(values.licenseKey);
	if (!key) return { ...(await buildSettingsPage(ctx)), toast: toast("Enter a license key.", "error") };
	const result = await activateLicense(ctx, key);
	if (result.ok) await ctx.settings.set("licenseKey", key);
	await syncDigestSchedule(ctx);
	return { ...(await buildSettingsPage(ctx)), toast: toast(result.message, result.ok ? "success" : "error") };
}

export async function deactivate(ctx: PluginContext): Promise<Blocks> {
	await deactivateLicense(ctx, await ctx.settings.get<string>("licenseKey"));
	await ctx.settings.delete("licenseKey");
	await syncDigestSchedule(ctx);
	return { ...(await buildSettingsPage(ctx)), toast: toast("License deactivated") };
}

export async function regenerateToken(ctx: PluginContext): Promise<Blocks> {
	await ctx.settings.delete("formsToken");
	await ensureFormsToken(ctx);
	return { ...(await buildSettingsPage(ctx)), toast: toast("Token regenerated") };
}

export async function retryDelivery(ctx: PluginContext, id: string): Promise<Blocks> {
	const record = (await ctx.storage.deliveries!.get(id)) as DeliveryRecord | null;
	if (!record) return { ...(await buildLogPage(ctx)), toast: toast("Entry no longer exists.", "error") };
	const result = await sendStored(ctx, record.event, record.payload);
	await ctx.storage.deliveries!.put(id, {
		...record,
		status: result.ok ? "ok" : "failed",
		error: result.ok ? undefined : result.error,
	});
	return { ...(await buildLogPage(ctx)), toast: result.ok ? toast("Delivered") : toast(`Retry failed: ${result.error}`, "error") };
}

// ── Digest (Pro) ──

const CRON_NAME = "digest";
const CRON = { daily: "0 9 * * *", weekly: "0 9 * * 1" } as const;

export async function syncDigestSchedule(ctx: PluginContext): Promise<void> {
	if (!ctx.cron) return;
	const config = await loadConfig(ctx);
	await ctx.cron.cancel(CRON_NAME).catch(() => {});
	if (config.pro && config.digest !== "off") {
		await ctx.cron.schedule(CRON_NAME, { schedule: CRON[config.digest] });
	}
}

export async function runDigest(ctx: PluginContext): Promise<void> {
	const config = await loadConfig(ctx);
	if (!config.pro || config.digest === "off" || !config.enabled) return;
	const url = config.channels.content || config.webhookUrl;
	if (!url) return;

	const since = Date.now() - (config.digest === "daily" ? 86_400_000 : 7 * 86_400_000);
	const result = await ctx.storage.deliveries!.query({ orderBy: { at: "desc" }, limit: 200 });
	const counts = new Map<string, number>();
	let failed = 0;
	for (const item of result.items) {
		const d = item.data as DeliveryRecord;
		if (Date.parse(d.at) < since) continue;
		if (d.status === "failed") failed++;
		const label = EVENT_BY_ID.get(d.event)?.label ?? d.event;
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	const payload = {
		username: config.username || undefined,
		avatar_url: config.avatarUrl || undefined,
		allowed_mentions: { parse: [] as [] },
		embeds: [digestEmbed(config.digest === "daily" ? "Daily" : "Weekly", [...counts], failed)],
	};
	const sent = await sendDiscord(ctx, url, payload);
	if (!sent.ok) ctx.log.warn("Digest delivery failed", { error: sent.error });
}

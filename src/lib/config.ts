import type { PluginContext } from "emdash/plugin";

import { EVENTS, settingKey, type Category, type EventId } from "./events.js";
import { isPro } from "./license.js";

export interface Config {
	enabled: boolean;
	pro: boolean;
	webhookUrl: string;
	username: string;
	avatarUrl: string;
	events: Record<EventId, boolean>;
	// Pro-only values; empty/neutral when the site is not licensed.
	collections: string[];
	mention: string;
	template: string;
	accent: number | null;
	channels: Partial<Record<Category, string>>;
	formsIncludeData: boolean;
	digest: "off" | "daily" | "weekly";
}

const get = async <T>(ctx: PluginContext, key: string, fallback: T): Promise<T> =>
	(await ctx.settings.get<T>(key)) ?? fallback;

export function parseColor(value: string): number | null {
	const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
	return m ? parseInt(m[1]!, 16) : null;
}

export function parseList(value: string): string[] {
	return value
		.split(/[,\n]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export async function loadConfig(ctx: PluginContext): Promise<Config> {
	const pro = await isPro(ctx);
	const events = {} as Record<EventId, boolean>;
	for (const e of EVENTS) events[e.id] = await get<boolean>(ctx, settingKey(e.id), e.defaultOn);

	const config: Config = {
		enabled: await get(ctx, "enabled", true),
		pro,
		webhookUrl: await get(ctx, "webhookUrl", ""),
		username: await get(ctx, "username", ""),
		avatarUrl: await get(ctx, "avatarUrl", ""),
		events,
		collections: [],
		mention: "",
		template: "",
		accent: null,
		channels: {},
		formsIncludeData: true,
		digest: "off",
	};
	if (!pro) return config;

	config.collections = parseList(await get(ctx, "collections", ""));
	config.mention = await get(ctx, "mention", "");
	config.template = await get(ctx, "template", "");
	config.accent = parseColor(await get(ctx, "accent", ""));
	config.formsIncludeData = await get(ctx, "formsIncludeData", true);
	const digest = await get<string>(ctx, "digest", "off");
	config.digest = digest === "daily" || digest === "weekly" ? digest : "off";
	for (const category of ["content", "comments", "media", "forms"] as const) {
		const url = await get(ctx, `${category}WebhookUrl`, "");
		if (url) config.channels[category] = url;
	}
	return config;
}

export function channelUrl(config: Config, category: Category): string {
	return config.channels[category] || config.webhookUrl;
}

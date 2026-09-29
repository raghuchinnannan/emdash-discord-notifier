import { describe, expect, it } from "vitest";

import { isDiscordWebhookUrl, sanitizeEmbed, truncate } from "../src/lib/discord.js";
import { applyTemplate, contentTitle, formatBytes } from "../src/lib/embeds.js";
import { allowedMentions } from "../src/lib/notify.js";
import { parseColor, parseList } from "../src/lib/config.js";

describe("webhook URL validation", () => {
	it("accepts Discord webhook URLs", () => {
		expect(isDiscordWebhookUrl("https://discord.com/api/webhooks/123456/abc-DEF_1")).toBe(true);
		expect(isDiscordWebhookUrl("https://discordapp.com/api/v10/webhooks/123456/abc")).toBe(true);
	});
	it("rejects everything else", () => {
		for (const url of [
			"http://discord.com/api/webhooks/1/a",
			"https://evil.com/api/webhooks/1/a",
			"https://discord.com.evil.com/api/webhooks/1/a",
			"https://discord.com/api/webhooks/abc/a",
			"https://localhost/hook",
			"",
		]) {
			expect(isDiscordWebhookUrl(url)).toBe(false);
		}
	});
});

describe("mentions", () => {
	it("parses nothing when no mention is configured", () => {
		expect(allowedMentions("")).toEqual({ parse: [] });
	});
	it("only allows the mention types the admin configured", () => {
		expect(allowedMentions("<@&123>")).toEqual({ parse: ["roles"] });
		expect(allowedMentions("<@42> <@&123>")).toEqual({ parse: ["roles", "users"] });
		expect(allowedMentions("@here")).toEqual({ parse: ["everyone"] });
	});
});

describe("helpers", () => {
	it("truncates to Discord limits", () => {
		expect(truncate("abcdef", 4)).toBe("abc…");
		const embed = sanitizeEmbed({ title: "x".repeat(400), fields: Array.from({ length: 30 }, () => ({ name: "n", value: "v".repeat(2000) })) });
		expect(embed.title).toHaveLength(256);
		expect(embed.fields).toHaveLength(25);
		expect(embed.fields![0]!.value).toHaveLength(1024);
	});
	it("applies templates and keeps unknown placeholders", () => {
		expect(applyTemplate("New {event}: {title} {nope}", { event: "published", title: "Hi" })).toBe("New published: Hi {nope}");
	});
	it("finds a content title", () => {
		expect(contentTitle({ id: "1", data: { title: "Hello" } })).toBe("Hello");
		expect(contentTitle({ id: "1", slug: "my-slug", data: {} })).toBe("my-slug");
		expect(contentTitle({ id: "9" })).toBe("9");
	});
	it("parses colours, lists and sizes", () => {
		expect(parseColor("#5865F2")).toBe(0x5865f2);
		expect(parseColor("nope")).toBeNull();
		expect(parseList("posts, pages\nnews")).toEqual(["posts", "pages", "news"]);
		expect(formatBytes(1536)).toBe("1.5 KB");
	});
});

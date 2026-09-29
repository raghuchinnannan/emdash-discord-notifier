import { afterEach, describe, expect, it, vi } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

const HOOK_URL = "https://discord.com/api/webhooks/111111/aaaa-bbbb";
const CHANNEL_URL = "https://discord.com/api/webhooks/222222/cccc-dddd";

process.env.EMDASH_ENCRYPTION_KEY = `emdash_enc_v1_${"A".repeat(43)}`;

let host: PluginRuntimeTestHost | undefined;

/** Hooks that run after the response are deferred; poll until a request lands. */
const delivered = (h: PluginRuntimeTestHost, count = 1) =>
	vi.waitFor(() => expect(h.http.requests().length).toBeGreaterThanOrEqual(count));

/** For negative assertions: give deferred hooks time to (not) fire. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 1500));

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function setup(settings: Record<string, unknown> = {}, pro = false) {
	host = await createPluginRuntimeTestHost({ site: { name: "Test", url: "https://example.com" } });
	await host.fixtures.collection({
		slug: "posts",
		label: "Posts",
		fields: [{ slug: "title", label: "Title", type: "string" }],
	});
	await host.fixtures.plugin.setting("webhookUrl", HOOK_URL);
	for (const [k, v] of Object.entries(settings)) await host.fixtures.plugin.setting(k, v);
	if (pro) {
		await host.fixtures.plugin.kv("state:license", { instanceId: "i", valid: true, checkedAt: Date.now() });
	}
	await host.http.respond(HOOK_URL, new Response(null, { status: 204 }));
	await host.http.respond(CHANNEL_URL, new Response(null, { status: 204 }));
	return host;
}

const sent = (h: PluginRuntimeTestHost) =>
	h.http.requests().map((r) => JSON.parse(new TextDecoder().decode(r.body)));

async function publishPost(h: PluginRuntimeTestHost, title = "Hello world") {
	const item = await h.fixtures.content("posts", { slug: "hello-world", data: { title } });
	const result = await h.actions.content.publish("posts", item.id);
	if (!result.success) throw new Error(result.error.message);
	return item.id;
}

describe("free plan", () => {
	it("posts an embed when content is published", async () => {
		const h = await setup();
		await publishPost(h);
		await delivered(h);
		const [msg] = sent(h);
		expect(msg.embeds[0].title).toBe("Published: Hello world");
		expect(msg.allowed_mentions).toEqual({ parse: [] });
	});

	it("does nothing without a webhook or when disabled", async () => {
		const h = await setup({ enabled: false });
		await publishPost(h);
		await settle();
		expect(h.http.requests()).toHaveLength(0);
	});

	it("respects per-event toggles", async () => {
		const h = await setup({ ev_published: false });
		await publishPost(h);
		await settle();
		expect(h.http.requests()).toHaveLength(0);
	});

	it("ignores Pro settings without a license", async () => {
		const h = await setup({ mention: "<@&999>", template: "hey", contentWebhookUrl: CHANNEL_URL });
		await publishPost(h);
		await delivered(h);
		const requests = h.http.requests();
		expect(requests).toHaveLength(1);
		expect(requests[0]!.url).toBe(HOOK_URL);
		expect(sent(h)[0].content).toBeUndefined();
	});

	it("logs deliveries", async () => {
		const h = await setup();
		await publishPost(h);
		await delivered(h);
		await vi.waitFor(async () => {
			const log = await h.inspect.storage.list<{ status: string }>("deliveries");
			expect(log.map((l) => l.data.status)).toEqual(["ok"]);
		});
	});

	it("never calls a non-Discord URL", async () => {
		const h = await setup({ webhookUrl: "https://evil.example/hook" });
		await publishPost(h);
		await vi.waitFor(async () => {
			expect((await h.inspect.storage.list("deliveries")).length).toBe(1);
		});
		expect(h.http.requests()).toHaveLength(0);
		const log = await h.inspect.storage.list<{ status: string }>("deliveries");
		expect(log[0]?.data.status).toBe("failed");
	});

	it("does not relay form submissions", async () => {
		const h = await setup({ formsToken: "tok" });
		const res = await h.actions.routes.request("forms", { body: { formName: "Contact" }, url: "https://example.com/x?token=tok" });
		expect(JSON.stringify(await res.json())).toContain("UNAUTHORIZED");
		expect(h.http.requests()).toHaveLength(0);
	});
});

describe("pro plan", () => {
	it("routes content to its own channel with mention and template", async () => {
		const h = await setup({ contentWebhookUrl: CHANNEL_URL, mention: "<@&999>", template: "New {event}: {title}", accent: "#ff0000" }, true);
		await publishPost(h);
		await delivered(h);
		const [req] = h.http.requests();
		expect(req!.url).toBe(CHANNEL_URL);
		const [msg] = sent(h);
		expect(msg.content).toBe("<@&999> New published: Hello world");
		expect(msg.allowed_mentions).toEqual({ parse: ["roles"] });
		expect(msg.embeds[0].color).toBe(0xff0000);
	});

	it("filters by collection", async () => {
		const h = await setup({ collections: "pages" }, true);
		await publishPost(h);
		await settle();
		expect(h.http.requests()).toHaveLength(0);
	});

	it("relays form submissions with a valid token", async () => {
		const h = await setup({ formsToken: "tok" }, true);
		const ok = await h.actions.routes.request("forms", {
			body: { event: "form.submission", formName: "Contact", data: { email: "a@b.co", message: "hi @everyone" } },
			url: "https://example.com/_emdash/api/plugins/discord-notifier/forms?token=tok",
		});
		expect(JSON.stringify(await ok.json())).toContain('"ok":true');
		const [msg] = sent(h);
		expect(msg.embeds[0].title).toBe("New submission: Contact");
		expect(msg.allowed_mentions).toEqual({ parse: [] });

		h.http.clear();
		const bad = await h.actions.routes.request("forms", {
			body: { formName: "Contact" },
			url: "https://example.com/_emdash/api/plugins/discord-notifier/forms?token=wrong",
		});
		expect(JSON.stringify(await bad.json())).toContain("UNAUTHORIZED");
		expect(h.http.requests()).toHaveLength(0);
	});
});

describe("admin", () => {
	it("renders the settings page, log page and widget", async () => {
		const h = await setup({}, true);
		expect((await h.admin.loadPage("/settings")).blocks.length).toBeGreaterThan(3);
		expect((await h.admin.loadPage("/log")).blocks.length).toBeGreaterThan(0);
		expect((await h.admin.loadWidget("status")).blocks.length).toBeGreaterThan(0);
	});

	it("rejects a non-Discord webhook URL on save", async () => {
		const h = await setup();
		const res = await h.admin.submit("/settings", "save_settings", { webhookUrl: "https://evil.example/x" });
		expect(JSON.stringify(res)).toContain("not a Discord webhook URL");
		expect(await h.inspect.setting("webhookUrl")).toBe(HOOK_URL);
	});

	it("sends a test message", async () => {
		const h = await setup();
		await h.admin.act("/settings", "test_webhook");
		expect(sent(h)[0].embeds[0].title).toBe("Discord Notifier is connected");
	});
});

describe("licensing", () => {
	const LS = "https://api.lemonsqueezy.com/v1/licenses";

	it("activates a valid key and unlocks Pro", async () => {
		const h = await setup();
		await h.http.respond(
			`${LS}/activate`,
			Response.json({ activated: true, instance: { id: "inst-1" }, meta: { product_id: 5, variant_id: 1397879, variant_name: "Pro" } }),
		);
		const res = await h.admin.submit("/settings", "activate_license", { licenseKey: "KEY-1234" });
		expect(JSON.stringify(res)).toContain("License activated");
		expect(await h.inspect.kv.get<{ valid: boolean; instanceId: string }>("state:license")).toMatchObject({ valid: true, instanceId: "inst-1" });
		const body = new TextDecoder().decode(h.http.requests().find((r) => r.url.endsWith("/activate"))!.body);
		expect(new URLSearchParams(body).get("instance_name")).toBe("https://example.com");
	});

	it("rejects a key from another product and frees the activation", async () => {
		const h = await setup();
		await h.http.respond(`${LS}/activate`, Response.json({ activated: true, instance: { id: "x" }, meta: { product_id: 1, variant_id: 2 } }));
		await h.http.respond(`${LS}/deactivate`, Response.json({ deactivated: true }));
		const res = await h.admin.submit("/settings", "activate_license", { licenseKey: "OTHER" });
		expect(JSON.stringify(res)).toContain("not for Discord Notifier");
		expect(await h.inspect.kv.get("state:license")).toBeNull();
	});

	it("rejects an invalid key and stays on Free", async () => {
		const h = await setup();
		await h.http.respond(`${LS}/activate`, Response.json({ activated: false, error: "license_key not found" }));
		const res = await h.admin.submit("/settings", "activate_license", { licenseKey: "nope" });
		expect(JSON.stringify(res)).toContain("license_key not found");
		expect(await h.inspect.kv.get("state:license")).toBeNull();
	});

	it("re-validates after 24h and drops Pro when the key is revoked", async () => {
		const h = await setup({ licenseKey: "KEY", contentWebhookUrl: CHANNEL_URL }, false);
		await h.fixtures.plugin.kv("state:license", { instanceId: "i", valid: true, checkedAt: Date.now() - 2 * 86_400_000 });
		await h.http.respond(`${LS}/validate`, Response.json({ valid: false }));
		await publishPost(h);
		await delivered(h, 2);
		// Falls back to the default channel because Pro was revoked.
		expect(h.http.requests().some((r) => r.url === HOOK_URL)).toBe(true);
		expect(await h.inspect.kv.get<{ valid: boolean }>("state:license")).toMatchObject({ valid: false });
	});
});


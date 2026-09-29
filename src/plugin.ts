import type { SandboxedPlugin } from "emdash/plugin";

import {
	activate,
	buildLogPage,
	buildSettingsPage,
	buildWidget,
	deactivate,
	regenerateToken,
	retryDelivery,
	runDigest,
	saveSettings,
	syncDigestSchedule,
	testWebhook,
} from "./lib/admin.js";
import {
	commentCreatedEmbed,
	commentModeratedEmbed,
	contentEmbed,
	contentTitle,
	deletedEmbed,
	formEmbed,
	mediaEmbed,
	type FormSubmissionPayload,
} from "./lib/embeds.js";
import { loadConfig } from "./lib/config.js";
import type { EventId } from "./lib/events.js";
import { notify } from "./lib/notify.js";

const HOOK = { priority: 210, timeout: 10000, errorPolicy: "continue" } as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** Constant-time string comparison for the forms relay token. */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function contentHook(event: EventId) {
	return {
		...HOOK,
		handler: async (
			e: { content: Record<string, unknown>; collection: string },
			ctx: Parameters<typeof notify>[0],
		) => {
			const id = String(e.content.id);
			const url = (await ctx.content?.getPublicUrl?.(e.collection, id).catch(() => null)) ?? null;
			await notify(ctx, {
				event,
				collection: e.collection,
				embed: contentEmbed(event, e.collection, e.content, url),
				vars: { title: contentTitle(e.content), collection: e.collection, url: url ?? "" },
			});
		},
	};
}

interface AdminInteraction {
	type?: string;
	page?: string;
	action_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
}

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:activate": {
			handler: async (_event, ctx) => {
				await syncDigestSchedule(ctx);
			},
		},

		"content:afterPublish": contentHook("published"),
		"content:afterUnpublish": contentHook("unpublished"),
		"content:afterSchedule": contentHook("scheduled"),
		"content:afterUnschedule": contentHook("unscheduled"),
		"content:afterRestore": contentHook("restored"),

		"content:afterDelete": {
			...HOOK,
			handler: async (event, ctx) => {
				await notify(ctx, {
					event: "deleted",
					collection: event.collection,
					embed: deletedEmbed(event.collection, event.id, event.permanent),
					vars: { title: event.id, collection: event.collection, url: "" },
				});
			},
		},

		"comment:afterCreate": {
			...HOOK,
			handler: async (event, ctx) => {
				if (event.comment.status === "spam") return;
				await notify(ctx, {
					event: "commentCreated",
					collection: event.content.collection,
					embed: commentCreatedEmbed(event),
					vars: {
						title: event.content.title ?? event.content.slug,
						collection: event.content.collection,
						author: event.comment.authorName,
						url: "",
					},
				});
			},
		},

		"comment:afterModerate": {
			...HOOK,
			handler: async (event, ctx) => {
				await notify(ctx, {
					event: "commentModerated",
					collection: event.comment.collection,
					embed: commentModeratedEmbed(event),
					vars: { title: "", collection: event.comment.collection, author: event.comment.authorName, url: "" },
				});
			},
		},

		"media:afterUpload": {
			...HOOK,
			handler: async (event, ctx) => {
				await notify(ctx, {
					event: "mediaUploaded",
					embed: mediaEmbed(event.media),
					vars: { title: event.media.filename, collection: "", url: "" },
				});
			},
		},

		cron: {
			handler: async (event, ctx) => {
				if (event.name === "digest") await runDigest(ctx);
			},
		},
	},

	routes: {
		/**
		 * Receives the Forms plugin's per-form webhook and relays it to Discord (Pro).
		 * Public because the Forms plugin cannot send credentials, so it authenticates
		 * with a secret `?token=` in the URL that only site admins can see.
		 */
		forms: {
			public: true,
			methods: ["POST"],
			handler: async (routeCtx, ctx) => {
				const config = await loadConfig(ctx);
				const stored = await ctx.settings.get<string>("formsToken");
				const given = new URL(routeCtx.request.url).searchParams.get("token") ?? "";
				if (!config.pro || !stored || !safeEqual(stored, given)) {
					return { ok: false, error: "UNAUTHORIZED" };
				}
				if (!isRecord(routeCtx.input)) return { ok: false, error: "INVALID_BODY" };

				const payload = routeCtx.input as FormSubmissionPayload;
				await notify(ctx, {
					event: "formSubmitted",
					embed: formEmbed(payload, config.formsIncludeData),
					vars: { title: payload.formName ?? payload.formId ?? "form", collection: "", url: "" },
				});
				return { ok: true };
			},
		},

		admin: {
			handler: async (routeCtx, ctx) => {
				const i = (isRecord(routeCtx.input) ? routeCtx.input : {}) as AdminInteraction;
				try {
					if (i.type === "page_load") {
						if (i.page === "widget:status") return await buildWidget(ctx);
						if (i.page === "/log") return await buildLogPage(ctx);
						return await buildSettingsPage(ctx);
					}
					if (i.type === "form_submit") {
						if (i.action_id === "save_settings") return await saveSettings(ctx, i.values ?? {});
						if (i.action_id === "activate_license") return await activate(ctx, i.values ?? {});
					}
					if (i.type === "block_action") {
						if (i.action_id === "test_webhook") return await testWebhook(ctx);
						if (i.action_id === "deactivate_license") return await deactivate(ctx);
						if (i.action_id === "regenerate_token") return await regenerateToken(ctx);
						if (i.action_id === "retry_delivery" && typeof i.value === "string") {
							return await retryDelivery(ctx, i.value);
						}
					}
				} catch (error) {
					ctx.log.error("Admin interaction failed", { error: String(error) });
					return { blocks: [{ type: "banner", variant: "error", description: "Something went wrong. Check the server log." }] };
				}
				return { blocks: [] };
			},
		},
	},
};

export default plugin;

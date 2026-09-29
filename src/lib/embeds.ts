import type { Embed } from "./discord.js";
import { EVENT_BY_ID, type EventId } from "./events.js";

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

export function contentTitle(content: Rec): string {
	const data = isRec(content.data) ? content.data : {};
	return (
		str(data.title) ?? str(data.name) ?? str(content.title) ?? str(content.slug) ?? String(content.id ?? "Untitled")
	);
}

function base(event: EventId, title: string): Embed {
	return {
		title,
		color: EVENT_BY_ID.get(event)?.color,
		timestamp: new Date().toISOString(),
		footer: { text: "EmDash · Discord Notifier" },
	};
}

const CONTENT_TITLES: Partial<Record<EventId, string>> = {
	published: "Published",
	unpublished: "Unpublished",
	scheduled: "Scheduled",
	unscheduled: "Schedule cancelled",
	restored: "Restored",
	deleted: "Deleted",
};

export function contentEmbed(
	event: EventId,
	collection: string,
	content: Rec,
	url: string | null,
): Embed {
	const embed = base(event, `${CONTENT_TITLES[event] ?? event}: ${contentTitle(content)}`);
	if (url) embed.url = url;
	embed.fields = [
		{ name: "Collection", value: collection, inline: true },
		...(str(content.status) ? [{ name: "Status", value: String(content.status), inline: true }] : []),
		...(str(content.scheduledAt)
			? [{ name: "Scheduled for", value: String(content.scheduledAt), inline: true }]
			: []),
	];
	return embed;
}

export function deletedEmbed(collection: string, id: string, permanent: boolean | undefined): Embed {
	const embed = base("deleted", permanent ? "Permanently deleted an entry" : "Moved an entry to trash");
	embed.fields = [
		{ name: "Collection", value: collection, inline: true },
		{ name: "ID", value: id, inline: true },
	];
	return embed;
}

export function commentCreatedEmbed(event: {
	comment: { authorName: string; body: string; status: string };
	content: { title?: string; slug: string; collection: string };
}): Embed {
	const embed = base("commentCreated", `New comment on "${event.content.title ?? event.content.slug}"`);
	embed.description = event.comment.body;
	embed.fields = [
		{ name: "Author", value: event.comment.authorName || "Anonymous", inline: true },
		{ name: "Status", value: event.comment.status, inline: true },
		{ name: "Collection", value: event.content.collection, inline: true },
	];
	return embed;
}

export function commentModeratedEmbed(event: {
	comment: { authorName: string; body: string };
	previousStatus: string;
	newStatus: string;
	moderator: { name: string | null };
}): Embed {
	const embed = base("commentModerated", `Comment ${event.previousStatus} → ${event.newStatus}`);
	embed.description = event.comment.body;
	embed.fields = [
		{ name: "Author", value: event.comment.authorName || "Anonymous", inline: true },
		{ name: "Moderator", value: event.moderator.name ?? "System", inline: true },
	];
	return embed;
}

export function mediaEmbed(media: { filename: string; mimeType: string; size: number | null }): Embed {
	const embed = base("mediaUploaded", `Media uploaded: ${media.filename}`);
	embed.fields = [
		{ name: "Type", value: media.mimeType, inline: true },
		...(media.size != null ? [{ name: "Size", value: formatBytes(media.size), inline: true }] : []),
	];
	return embed;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface FormSubmissionPayload {
	formId?: string;
	formName?: string;
	submissionId?: string;
	data?: Rec;
	submittedAt?: string;
}

export function formEmbed(payload: FormSubmissionPayload, includeData: boolean): Embed {
	const embed = base("formSubmitted", `New submission: ${payload.formName ?? payload.formId ?? "form"}`);
	if (includeData && isRec(payload.data)) {
		embed.fields = Object.entries(payload.data)
			.slice(0, 20)
			.map(([name, value]) => ({
				name,
				value: Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value ?? ""),
			}));
	} else {
		embed.description = "Field values are hidden by your Discord Notifier settings.";
	}
	if (payload.submissionId) embed.footer = { text: `Submission ${payload.submissionId}` };
	return embed;
}

export function digestEmbed(period: string, counts: Array<[string, number]>, failed: number): Embed {
	const total = counts.reduce((n, [, c]) => n + c, 0);
	const embed = base("published", `${period} digest`);
	embed.color = 0x5865f2;
	embed.description = total === 0 ? "No activity in this period." : `${total} events in this period.`;
	embed.fields = counts.map(([label, count]) => ({ name: label, value: String(count), inline: true }));
	if (failed > 0) embed.fields.push({ name: "Failed deliveries", value: String(failed), inline: true });
	return embed;
}

/** Replace {title} {collection} {url} {event} {author} placeholders. Unknown placeholders are kept. */
export function applyTemplate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

export type EventId =
	| "published"
	| "unpublished"
	| "scheduled"
	| "unscheduled"
	| "deleted"
	| "restored"
	| "commentCreated"
	| "commentModerated"
	| "mediaUploaded"
	| "formSubmitted";

export type Category = "content" | "comments" | "media" | "forms";

export interface EventDef {
	id: EventId;
	label: string;
	category: Category;
	color: number;
	defaultOn: boolean;
	pro?: boolean;
}

export const EVENTS: EventDef[] = [
	{ id: "published", label: "Content published", category: "content", color: 0x2ecc71, defaultOn: true },
	{ id: "unpublished", label: "Content unpublished", category: "content", color: 0xf39c12, defaultOn: true },
	{ id: "scheduled", label: "Content scheduled", category: "content", color: 0x3498db, defaultOn: true },
	{ id: "unscheduled", label: "Schedule cancelled", category: "content", color: 0x95a5a6, defaultOn: false },
	{ id: "deleted", label: "Content moved to trash / deleted", category: "content", color: 0xe74c3c, defaultOn: true },
	{ id: "restored", label: "Content restored", category: "content", color: 0x9b59b6, defaultOn: false },
	{ id: "commentCreated", label: "New comment", category: "comments", color: 0x5865f2, defaultOn: true },
	{ id: "commentModerated", label: "Comment moderated", category: "comments", color: 0xe67e22, defaultOn: true },
	{ id: "mediaUploaded", label: "Media uploaded", category: "media", color: 0x1abc9c, defaultOn: false },
	{ id: "formSubmitted", label: "Form submission (Forms plugin relay)", category: "forms", color: 0xeb459e, defaultOn: true, pro: true },
];

export const EVENT_BY_ID = new Map(EVENTS.map((e) => [e.id, e]));

export const settingKey = (id: EventId) => `ev_${id}`;

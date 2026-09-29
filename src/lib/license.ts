import type { PluginContext } from "emdash/plugin";

/**
 * Pro / Extended licenses are sold through LemonSqueezy and checked against its public License API.
 * Pro keys allow 1 activation (one site); Extended keys allow unlimited activations. LemonSqueezy
 * enforces the limit when a site activates, so the plugin only needs to activate with the site URL.
 *
 * Enforcement is honour-based by design: the plugin is MIT licensed and its source is public.
 */
const LS_API = "https://api.lemonsqueezy.com/v1/licenses";

/**
 * LemonSqueezy product or variant IDs whose keys unlock Pro: Pro (1397879) and Extended (1397911).
 * A key is accepted when its product_id or variant_id is listed. If the list is emptied, any active key is accepted.
 */
export const ACCEPTED_PRODUCT_IDS: number[] = [1397879, 1397911];

const REVALIDATE_MS = 24 * 60 * 60 * 1000;
const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_KEY = "state:license";

export interface LicenseState {
	instanceId: string;
	valid: boolean;
	checkedAt: number;
	variant?: string;
	/** Last 4 characters of the key, for display only. */
	keyHint?: string;
}

interface LsResponse {
	activated?: boolean;
	deactivated?: boolean;
	valid?: boolean;
	error?: string | null;
	license_key?: { status?: string };
	instance?: { id?: string } | null;
	meta?: { product_id?: number; variant_id?: number; variant_name?: string };
}

async function lsCall(ctx: PluginContext, action: string, params: Record<string, string>) {
	if (!ctx.http) throw new Error("network:request capability is not available");
	const res = await ctx.http.fetch(`${LS_API}/${action}`, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params).toString(),
	});
	const data = (await res.json().catch(() => ({}))) as LsResponse;
	return data;
}

function productAccepted(data: LsResponse): boolean {
	if (ACCEPTED_PRODUCT_IDS.length === 0) return true;
	const { product_id, variant_id } = data.meta ?? {};
	return (
		(product_id !== undefined && ACCEPTED_PRODUCT_IDS.includes(product_id)) ||
		(variant_id !== undefined && ACCEPTED_PRODUCT_IDS.includes(variant_id))
	);
}

export async function getLicenseState(ctx: PluginContext): Promise<LicenseState | null> {
	return (await ctx.kv.get<LicenseState>(STATE_KEY)) ?? null;
}

export async function activateLicense(
	ctx: PluginContext,
	key: string,
): Promise<{ ok: boolean; message: string }> {
	try {
		const data = await lsCall(ctx, "activate", {
			license_key: key,
			instance_name: ctx.site?.url || "emdash-site",
		});
		if (!data.activated || !data.instance?.id) {
			return { ok: false, message: data.error || "License could not be activated." };
		}
		if (!productAccepted(data)) {
			await lsCall(ctx, "deactivate", { license_key: key, instance_id: data.instance.id }).catch(() => {});
			return { ok: false, message: "This license key is not for Discord Notifier." };
		}
		await ctx.kv.set(STATE_KEY, {
			instanceId: data.instance.id,
			valid: true,
			checkedAt: Date.now(),
			variant: data.meta?.variant_name,
			keyHint: key.slice(-4),
		} satisfies LicenseState);
		return { ok: true, message: `License activated${data.meta?.variant_name ? ` (${data.meta.variant_name})` : ""}.` };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : "Could not reach the license server." };
	}
}

export async function deactivateLicense(ctx: PluginContext, key: string | null): Promise<void> {
	const state = await getLicenseState(ctx);
	if (state && key) {
		await lsCall(ctx, "deactivate", { license_key: key, instance_id: state.instanceId }).catch(() => {});
	}
	await ctx.kv.delete(STATE_KEY);
}

/** True when this site holds an active Pro/Extended activation. Re-validates at most daily. */
export async function isPro(ctx: PluginContext): Promise<boolean> {
	const state = await getLicenseState(ctx);
	if (!state?.valid) return false;
	const age = Date.now() - state.checkedAt;
	if (age < REVALIDATE_MS) return true;

	const key = await ctx.settings.get<string>("licenseKey");
	if (!key) return false;
	try {
		const data = await lsCall(ctx, "validate", { license_key: key, instance_id: state.instanceId });
		const valid = data.valid === true && productAccepted(data);
		await ctx.kv.set(STATE_KEY, { ...state, valid, checkedAt: Date.now() } satisfies LicenseState);
		return valid;
	} catch {
		// License server unreachable: stay Pro through a grace period rather than punishing the customer.
		return age < OFFLINE_GRACE_MS;
	}
}

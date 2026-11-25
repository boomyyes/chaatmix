import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import type { Platform } from '#lib/types.ts';

const TTL_MS = 10 * 60 * 1000;
const COOKIE = 'oauth_nonce';
const pending = new Map<string, { platform: Platform; nonce: string; exp: number }>();

/** Single-use `state` bound to this browser by a short-lived cookie (RFC 9700). */
export function issueState(platform: Platform, cookies: Cookies, now = Date.now()) {
	for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
	const state = randomBytes(24).toString('base64url');
	const nonce = randomBytes(24).toString('base64url');
	pending.set(state, { platform, nonce, exp: now + TTL_MS });
	cookies.set(COOKIE, nonce, { path: '/auth', httpOnly: true, secure: true, sameSite: 'lax', maxAge: TTL_MS / 1000 });
	return state;
}

/** True only for a state this server issued to this same browser, unexpired, never used before. */
export function consumeState(platform: Platform, state: string | null, cookies: Cookies, now = Date.now()) {
	if (!state) return false;
	const entry = pending.get(state);
	pending.delete(state);
	const nonce = cookies.get(COOKIE);
	cookies.delete(COOKIE, { path: '/auth' });
	if (!entry || !nonce || entry.exp < now || entry.platform !== platform) return false;
	const a = Buffer.from(entry.nonce);
	const b = Buffer.from(nonce);
	return a.length === b.length && timingSafeEqual(a, b);
}

export function safeEqual(a: string, b: string) {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

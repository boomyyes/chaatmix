import { env } from '#lib/server/env.ts';
import type { ChatEvent } from '#lib/types.ts';
import { publish, setStatus } from './hub';
import { load, save } from './state';

const SCOPES = 'user:read:chat user:write:chat bits:read';
const redirectUri = () => `${env.PUBLIC_URL}/auth/twitch/callback`;

export function authUrl(state: string) {
	const q = new URLSearchParams({ response_type: 'code', client_id: env.TWITCH_CLIENT_ID!, redirect_uri: redirectUri(), scope: SCOPES, state });
	return `https://id.twitch.tv/oauth2/authorize?${q}`;
}

async function token(params: Record<string, string>) {
	const res = await fetch('https://id.twitch.tv/oauth2/token', {
		method: 'POST',
		body: new URLSearchParams({ client_id: env.TWITCH_CLIENT_ID!, client_secret: env.TWITCH_CLIENT_SECRET!, ...params })
	});
	if (!res.ok) throw new Error(`Twitch token ${res.status}`);
	const t = await res.json();
	return { access: t.access_token as string, refresh: t.refresh_token as string, expiresAt: Date.now() + t.expires_in * 1000 };
}

/** OAuth callback: store tokens + the streamer's user id, then (re)start the connection. */
export async function connectWithCode(code: string) {
	const t = await token({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
	const me = await fetch('https://api.twitch.tv/helix/users', { headers: { Authorization: `Bearer ${t.access}`, 'Client-Id': env.TWITCH_CLIENT_ID! } });
	const user = (await me.json()).data[0];
	const s = await load();
	s.twitch = { ...t, userId: user.id, login: user.login };
	await save();
	start();
}

/** Helix call with one automatic refresh on 401. */
async function helix(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
	const s = await load();
	if (!s.twitch) throw new Error('not connected');
	const res = await fetch(`https://api.twitch.tv/helix/${path}`, {
		...init,
		headers: { Authorization: `Bearer ${s.twitch.access}`, 'Client-Id': env.TWITCH_CLIENT_ID!, 'Content-Type': 'application/json' }
	});
	if (res.status === 401 && retry) {
		try {
			Object.assign(s.twitch, await token({ grant_type: 'refresh_token', refresh_token: s.twitch.refresh }));
			await save();
		} catch {
			needsReconnect('Twitch login was rejected. Tap to reconnect.');
			throw new Error('twitch auth');
		}
		return helix(path, init, false);
	}
	return res;
}

function needsReconnect(reason: string) {
	setStatus({ platform: 'twitch', state: 'error', reason, action: 'reconnect' });
}

/** Map an EventSub notification to a ChatEvent, or undefined for events we don't show. */
/** EventSub message fragments -> text and emote images; undefined when there are no emotes (plain text is enough). */
export function emoteParts(message: any): ChatEvent['parts'] {
	const f: any[] = message?.fragments ?? [];
	if (!f.some((x) => x.type === 'emote')) return undefined;
	return f.map((x) =>
		x.type === 'emote' && x.emote?.id
			? { text: x.text, emote: `https://static-cdn.jtvnw.net/emoticons/v2/${x.emote.id}/${x.emote.format?.includes('animated') ? 'animated' : 'static'}/dark/2.0` }
			: { text: x.text }
	);
}

export function toChatEvent(type: string, e: any, id: string, ts: string): ChatEvent | undefined {
	const base = { id, platform: 'twitch' as const, ts };
	if (type === 'channel.chat.message')
		return { ...base, id: e.message_id, kind: 'message', author: e.chatter_user_name, text: e.message.text, parts: emoteParts(e.message) };
	if (type === 'channel.cheer')
		return { ...base, kind: 'cheer', author: e.is_anonymous ? 'Anonymous' : e.user_name, text: e.message ?? '', label: `${e.bits} BITS` };
	if (type !== 'channel.chat.notification') return undefined;
	const author = e.chatter_is_anonymous ? 'Anonymous' : e.chatter_user_name;
	const text = e.message?.text || e.system_message || '';
	const n = { ...base, id: e.message_id ?? id, author, text, parts: e.message?.text ? emoteParts(e.message) : undefined };
	switch (e.notice_type) {
		case 'sub': return { ...n, kind: 'sub', label: `SUB · TIER ${Number(e.sub?.sub_tier ?? 1000) / 1000}` };
		case 'resub': return { ...n, kind: 'resub', label: `RESUB · ${e.resub?.cumulative_months ?? '?'} MONTHS` };
		case 'sub_gift': return { ...n, kind: 'gift', label: 'GIFTED SUB' };
		case 'community_sub_gift': return { ...n, kind: 'gift', label: `GIFTED ${e.community_sub_gift?.total ?? ''} SUBS` };
		case 'raid': return { ...n, author: e.raid?.user_name ?? author, kind: 'raid', label: `RAID · ${e.raid?.viewer_count ?? 0} VIEWERS` };
		default: return undefined;
	}
}

let socket: WebSocket | undefined; // the welcomed connection
let latest: WebSocket | undefined; // the newest one opened; only its close triggers a restart
let watchdog: ReturnType<typeof setTimeout> | undefined;

async function subscribe(sessionId: string) {
	const s = (await load()).twitch!;
	const user = { broadcaster_user_id: s.userId, user_id: s.userId };
	const subs = [
		['channel.chat.message', user],
		['channel.chat.notification', user],
		['channel.cheer', { broadcaster_user_id: s.userId }]
	] as const;
	for (const [type, condition] of subs) {
		const res = await helix('eventsub/subscriptions', {
			method: 'POST',
			body: JSON.stringify({ type, version: '1', condition, transport: { method: 'websocket', session_id: sessionId } })
		});
		if (!res.ok && res.status !== 409) throw new Error(`subscribe ${type}: ${res.status}`);
	}
}

/** Open the EventSub socket. On session_reconnect Twitch keeps subscriptions, so we don't resubscribe. */
function open(url = 'wss://eventsub.wss.twitch.tv/ws', isReconnect = false) {
	const ws = new WebSocket(url);
	latest = ws;
	let keepaliveMs = 20_000;
	const arm = () => {
		clearTimeout(watchdog);
		watchdog = setTimeout(() => ws.close(), keepaliveMs + 10_000); // missed keepalives: drop and reopen
	};
	ws.onmessage = async (msg) => {
		arm();
		const { metadata, payload } = JSON.parse(String(msg.data));
		switch (metadata.message_type) {
			case 'session_welcome': {
				keepaliveMs = payload.session.keepalive_timeout_seconds * 1000;
				const old = socket;
				socket = ws;
				if (isReconnect) old?.close();
				else
					await subscribe(payload.session.id).catch((e) =>
						e.message !== 'twitch auth' && setStatus({ platform: 'twitch', state: 'error', reason: 'Could not subscribe to Twitch chat. Retrying.' })
					);
				pollLive();
				break;
			}
			case 'session_reconnect':
				open(payload.session.reconnect_url, true);
				break;
			case 'notification': {
				const ev = toChatEvent(payload.subscription.type, payload.event, metadata.message_id, metadata.message_timestamp);
				if (ev) publish(ev);
				break;
			}
			case 'revocation':
				needsReconnect('Twitch access was revoked. Tap to reconnect.');
				break;
		}
	};
	ws.onclose = () => {
		if (shouldRestart(ws, latest)) {
			socket = undefined;
			setTimeout(start, 5000);
		}
	};
}

/** Connections we replaced on purpose (start, session_reconnect) close quietly; only losing the newest one restarts. */
export const shouldRestart = (closed: WebSocket, newest: WebSocket | undefined) => closed === newest;

let liveTimer: ReturnType<typeof setInterval> | undefined;
/** Twitch "live" vs "waiting" for the status chip; checked every 2 minutes. */
function pollLive() {
	const check = async () => {
		const s = await load();
		if (!s.twitch) return;
		const res = await helix(`streams?user_id=${s.twitch.userId}`).catch(() => undefined);
		if (!res?.ok) return;
		const live = (await res.json()).data.length > 0;
		setStatus({ platform: 'twitch', state: live ? 'live' : 'waiting', reason: live ? undefined : 'Connected, not live.' });
	};
	clearInterval(liveTimer);
	liveTimer = setInterval(check, 120_000);
	check();
}

export async function start() {
	if (!env.TWITCH_CLIENT_ID) return;
	const s = await load();
	if (!s.twitch) return setStatus({ platform: 'twitch', state: 'not_connected', reason: 'Twitch is not connected yet.', action: 'reconnect' });
	const previous = latest;
	open(); // becomes `latest` first, so closing the previous one does not schedule another start
	previous?.close();
}

/** Real threaded reply on Twitch. */
export async function reply(parentId: string, text: string) {
	const s = (await load()).twitch;
	if (!s) throw new Error('Twitch is not connected.');
	const res = await helix('chat/messages', {
		method: 'POST',
		body: JSON.stringify({ broadcaster_id: s.userId, sender_id: s.userId, message: text, reply_parent_message_id: parentId })
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok || body.data?.[0]?.is_sent === false) throw new Error(body.data?.[0]?.drop_reason?.message ?? `Twitch send failed (${res.status})`);
}

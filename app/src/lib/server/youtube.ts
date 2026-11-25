import { env } from '#lib/server/env.ts';
import type { ChatEvent } from '#lib/types.ts';
import { publish, setStatus } from './hub';
import { DAILY, spend, usedToday } from './quota';
import { load, save } from './state';

const API = 'https://www.googleapis.com/youtube/v3';
const REPLY_RESERVE = 1500; // quota kept back so replies keep working all day
const STREAM_HOURS = 12;

async function yt(path: string, units: number) {
	spend(units);
	const res = await fetch(`${API}/${path}&key=${env.YOUTUBE_API_KEY}`);
	const body = await res.json();
	if (!res.ok) throw Object.assign(new Error(body.error?.message ?? `YouTube ${res.status}`), { reason: body.error?.errors?.[0]?.reason });
	return body;
}

/** Newest uploads (1 unit) → their live status (1 unit). Avoids search.list (100 units). */
async function findLiveChat(): Promise<string | undefined> {
	const uploads = 'UU' + env.YOUTUBE_CHANNEL_ID!.slice(2);
	const items = (await yt(`playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}`, 1)).items ?? [];
	if (!items.length) return undefined;
	const ids = items.map((i: any) => i.contentDetails.videoId).join(',');
	const videos = (await yt(`videos?part=liveStreamingDetails,snippet&id=${ids}`, 1)).items ?? [];
	return videos.find((v: any) => v.snippet.liveBroadcastContent === 'live' && v.liveStreamingDetails?.activeLiveChatId)?.liveStreamingDetails.activeLiveChatId;
}

/** Map a liveChatMessage resource; undefined for types we don't show. */
export function toChatEvent(m: any): ChatEvent | undefined {
	const s = m.snippet;
	const base = { id: m.id, platform: 'youtube' as const, author: m.authorDetails?.displayName ?? 'someone', ts: s.publishedAt, text: s.displayMessage ?? '' };
	switch (s.type) {
		case 'textMessageEvent': return { ...base, kind: 'message' };
		case 'superChatEvent': return { ...base, kind: 'superchat', label: `SUPER CHAT · ${s.superChatDetails.amountDisplayString}`, text: s.superChatDetails.userComment ?? '' };
		case 'superStickerEvent': return { ...base, kind: 'supersticker', label: `SUPER STICKER · ${s.superStickerDetails.amountDisplayString}`, text: s.superStickerDetails.superStickerMetadata?.altText ?? '' };
		case 'newSponsorEvent': return { ...base, kind: 'membership', label: `NEW MEMBER${s.newSponsorDetails?.memberLevelName ? ' · ' + s.newSponsorDetails.memberLevelName.toUpperCase() : ''}` };
		case 'memberMilestoneChatEvent': return { ...base, kind: 'milestone', label: `MEMBER · ${s.memberMilestoneChatDetails.memberMonth} MONTHS`, text: s.memberMilestoneChatDetails.userComment ?? '' };
		case 'membershipGiftingEvent': return { ...base, kind: 'gift', label: `GIFTED ${s.membershipGiftingDetails.giftMembershipsCount} MEMBERSHIPS` };
		default: return undefined;
	}
}

let liveChatId: string | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * shortcut: polls liveChatMessages.list, spreading the day's quota over STREAM_HOURS (~25 s between polls).
 * Upgrade to streamList over gRPC (push, ~5 units per connection) once Google's stream_list.proto is added.
 */
async function readChat(chatId: string) {
	let pageToken = '';
	while (liveChatId === chatId) {
		const res = await yt(`liveChat/messages?part=snippet,authorDetails&maxResults=2000&liveChatId=${chatId}${pageToken ? `&pageToken=${pageToken}` : ''}`, 5);
		for (const m of res.items ?? []) {
			const ev = toChatEvent(m);
			if (ev) publish(ev);
		}
		if (res.offlineAt) return;
		pageToken = res.nextPageToken;
		const budget = Math.max(DAILY - REPLY_RESERVE - usedToday(), 5);
		const floor = ((STREAM_HOURS * 3600_000) / (budget / 5)) | 0;
		await sleep(Math.max(res.pollingIntervalMillis ?? 0, floor, 2000));
	}
}

export async function start() {
	if (!env.YOUTUBE_API_KEY || !env.YOUTUBE_CHANNEL_ID) return;
	for (;;) {
		try {
			liveChatId = await findLiveChat();
			if (!liveChatId) {
				setStatus({ platform: 'youtube', state: 'waiting', reason: 'Not live. Checking every 2 min.' });
				await sleep(120_000);
				continue;
			}
			setStatus({ platform: 'youtube', state: 'live' });
			await readChat(liveChatId);
		} catch (e: any) {
			const quota = e.reason === 'quotaExceeded';
			setStatus({
				platform: 'youtube',
				state: 'error',
				reason: quota ? 'YouTube daily limit used up. Resets at midnight Pacific.' : 'YouTube chat dropped. Retrying.'
			});
			await sleep(quota ? 600_000 : 30_000);
		}
		liveChatId = undefined;
	}
}

// ---- Replies (Google login with youtube.force-ssl) ----

const redirectUri = () => `${env.PUBLIC_URL}/auth/google/callback`;

export function authUrl(state: string) {
	const q = new URLSearchParams({
		client_id: env.GOOGLE_CLIENT_ID!,
		redirect_uri: redirectUri(),
		response_type: 'code',
		scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
		access_type: 'offline',
		prompt: 'consent',
		state
	});
	return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function googleToken(params: Record<string, string>) {
	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, ...params })
	});
	if (!res.ok) throw new Error(`Google token ${res.status}`);
	return res.json();
}

export async function connectWithCode(code: string) {
	const t = await googleToken({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
	const s = await load();
	s.google = { access: t.access_token, refresh: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000 };
	await save();
}

async function googleAccess() {
	const s = await load();
	if (!s.google) throw new Error('Connect YouTube to reply.');
	if (Date.now() > s.google.expiresAt - 60_000) {
		try {
			const t = await googleToken({ grant_type: 'refresh_token', refresh_token: s.google.refresh });
			s.google.access = t.access_token;
			s.google.expiresAt = Date.now() + t.expires_in * 1000;
			await save();
		} catch {
			throw new Error('YouTube login expired. Reconnect YouTube to reply.');
		}
	}
	return s.google.access;
}

/** YouTube live chat has no threads: a reply is a new message starting with @author (20 units). */
export async function reply(author: string, text: string) {
	if (!liveChatId) throw new Error('YouTube is not live.');
	if (usedToday() > DAILY - 100) throw new Error('YouTube daily limit almost used up. Replies resume after midnight Pacific.');
	const messageText = text.startsWith('@') ? text : `@${author} ${text}`;
	spend(20);
	const res = await fetch(`${API}/liveChat/messages?part=snippet`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${await googleAccess()}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ snippet: { liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText } } })
	});
	if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error?.message ?? `YouTube send failed (${res.status})`);
}

export async function hasReplyLogin() {
	return !!(await load()).google;
}

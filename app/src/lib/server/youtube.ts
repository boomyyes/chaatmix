import { resolve } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { env } from '#lib/server/env.ts';
import type { ChatEvent } from '#lib/types.ts';
import { publish, setStatus } from './hub';
import { DAILY, repliesToday, spend, usedToday } from './quota';
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

/** Milliseconds per 5-unit call that spreads what's left of today's quota (minus the reply reserve) over STREAM_HOURS. */
const paceMs = () => ((STREAM_HOURS * 3600_000) / (Math.max(DAILY - REPLY_RESERVE - usedToday(), 5) / 5)) | 0;

let liveChatId: string | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let client: any;
function streamClient() {
	if (client) return client;
	// proto/stream_list.proto is Google's file from the "Streaming Live Chat" guide; cwd is the app folder.
	const def = protoLoader.loadSync(resolve('proto/stream_list.proto'), { keepCase: false, longs: String, enums: String, defaults: false });
	const pkg: any = grpc.loadPackageDefinition(def);
	client = new pkg.youtube.api.v3.V3DataLiveChatMessageService('youtube.googleapis.com:443', grpc.credentials.createSsl());
	return client;
}

/** gRPC enum names → the REST names toChatEvent knows: SUPER_CHAT_EVENT → superChatEvent. */
export const restType = (t: string) => t.toLowerCase().replace(/_(\w)/g, (_, c: string) => c.toUpperCase());

/**
 * Push stream (liveChatMessages.streamList): YouTube sends messages as they arrive. Each connection costs 5 units;
 * when YouTube closes it we reconnect with the last page token so nothing is missed. Resolves when the chat goes offline.
 */
async function streamChat(chatId: string) {
	let pageToken: string | undefined;
	let failures = 0;
	while (liveChatId === chatId) {
		spend(5);
		const opened = Date.now();
		const offline = await new Promise<boolean>((done, fail) => {
			const md = new grpc.Metadata();
			md.set('x-goog-api-key', env.YOUTUBE_API_KEY!);
			const call = streamClient().StreamList({ liveChatId: chatId, part: ['snippet', 'authorDetails'], maxResults: 2000, ...(pageToken && { pageToken }) }, md);
			call.on('data', (res: any) => {
				failures = 0;
				for (const m of res.items ?? []) {
					const ev = toChatEvent({ ...m, snippet: { ...m.snippet, type: restType(m.snippet?.type ?? '') } });
					if (ev) publish(ev);
				}
				if (res.nextPageToken) pageToken = res.nextPageToken;
				if (res.offlineAt) {
					call.cancel();
					done(true);
				}
			});
			call.on('end', () => done(false));
			call.on('error', (e: grpc.ServiceError) => (e.code === grpc.status.CANCELLED ? done(true) : fail(e)));
		}).catch((e) => {
			if (++failures >= 3) throw e;
			return false;
		});
		if (offline) return;
		// Each connection costs 5 units and YouTube may end streams early: a connection that lasted less than its
		// share of the day's budget waits out the rest (pageToken resumes, so nothing is lost, only delayed).
		await sleep(Math.max(2000 * Math.max(failures, 1), paceMs() - (Date.now() - opened)));
	}
}

const REFUSED = [grpc.status.UNAUTHENTICATED, grpc.status.PERMISSION_DENIED, grpc.status.UNIMPLEMENTED, grpc.status.INVALID_ARGUMENT];

/**
 * Fallback when the push stream is refused: polls liveChatMessages.list, spreading the day's quota over
 * STREAM_HOURS (~25 s between polls).
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
		await sleep(Math.max(res.pollingIntervalMillis ?? 0, paceMs(), 2000));
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
			const chatId = liveChatId;
			await streamChat(chatId).catch((e: grpc.ServiceError) => {
				if (!REFUSED.includes(e.code)) throw e;
				console.warn(`YouTube push stream refused (${e.details}); polling instead.`);
				return readChat(chatId);
			});
		} catch (e: any) {
			console.error('YouTube chat error:', e.code ?? '', e.details ?? e.message);
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
	// Capped at the reserve, so a busy day of replies can't eat the budget chat needs.
	if ((repliesToday() + 1) * 20 > REPLY_RESERVE)
		throw new Error(`Reply limit reached for today (${REPLY_RESERVE / 20} YouTube replies). Resets at midnight Pacific.`);
	const messageText = text.startsWith('@') ? text : `@${author} ${text}`;
	spend(20, true);
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

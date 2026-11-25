import { describe, expect, it, vi } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import { flush, publish, since } from './hub';
import { consumeState, issueState } from './oauth';
import { load, save } from './state';
import { shouldRestart, toChatEvent as twitchEvent } from './twitch';
import { restType, toChatEvent as youtubeEvent } from './youtube';

describe('youtube push stream', () => {
	it('maps gRPC enum names to the REST names the mapper knows', () => {
		expect(restType('SUPER_CHAT_EVENT')).toBe('superChatEvent');
		expect(restType('TEXT_MESSAGE_EVENT')).toBe('textMessageEvent');
		expect(restType('MEMBER_MILESTONE_CHAT_EVENT')).toBe('memberMilestoneChatEvent');
	});
});

// writeFile fails once, then works: simulates a brief storage error
const fs = vi.hoisted(() => ({ fail: false }));
vi.mock('node:fs/promises', () => ({
	readFile: vi.fn(async () => {
		throw new Error('no file');
	}),
	writeFile: vi.fn(async () => {
		if (fs.fail) {
			fs.fail = false;
			throw new Error('disk hiccup');
		}
	}),
	rename: vi.fn(async () => {})
}));

const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

describe('hub', () => {
	it('releases held events in platform-timestamp order, not arrival order', () => {
		publish({ id: 'tw1', platform: 'twitch', kind: 'message', author: 'a', text: '2nd', ts: t(2) });
		publish({ id: 'yt1', platform: 'youtube', kind: 'message', author: 'b', text: '1st', ts: t(1) }); // arrives late
		flush(Date.parse(t(1)) + 1000); // nothing is 2 s old yet
		expect(since(0)).toHaveLength(0);
		flush(Date.parse(t(10)));
		expect(since(0).map((e) => e.text)).toEqual(['1st', '2nd']);
	});

	it('drops duplicates (resume/reconnect repeats)', () => {
		const before = since(0).length;
		publish({ id: 'yt1', platform: 'youtube', kind: 'message', author: 'b', text: 'dup', ts: t(1) });
		flush(Date.parse(t(20)));
		expect(since(0)).toHaveLength(before);
	});
});

describe('hub timestamps', () => {
	it('releases Twitch-style timestamps with 9 decimal places', () => {
		publish({ id: 'ns', platform: 'twitch', kind: 'message', author: 'a', text: 'nano', ts: '2026-01-01T00:00:30.123456789Z' });
		flush(Date.parse(t(40)));
		expect(since(0).some((e) => e.text === 'nano')).toBe(true);
	});

	it('never holds an unreadable timestamp forever', () => {
		publish({ id: 'bad', platform: 'twitch', kind: 'message', author: 'a', text: 'bad ts', ts: 'not a date' });
		flush(Date.now() + 5000);
		expect(since(0).some((e) => e.text === 'bad ts')).toBe(true);
	});
});

describe('state saves', () => {
	it('keeps saving after one failed write', async () => {
		await load();
		fs.fail = true;
		await expect(save()).rejects.toThrow('disk hiccup');
		await expect(save()).resolves.toBeUndefined();
	});
});

describe('twitch reconnect', () => {
	it('restarts only when the newest connection closes', () => {
		const replaced = {} as WebSocket;
		const newest = {} as WebSocket;
		expect(shouldRestart(replaced, newest)).toBe(false); // closed on purpose by start() or session_reconnect
		expect(shouldRestart(newest, newest)).toBe(true); // the live one dropped
	});
});

function fakeCookies() {
	const jar = new Map<string, string>();
	return { get: (k: string) => jar.get(k), set: (k: string, v: string) => jar.set(k, v), delete: (k: string) => jar.delete(k) } as unknown as Cookies;
}

describe('oauth state', () => {
	it('accepts a fresh state once, from the same browser', () => {
		const c = fakeCookies();
		const s = issueState('twitch', c);
		expect(consumeState('twitch', s, c)).toBe(true);
		expect(consumeState('twitch', s, c)).toBe(false); // single use
	});

	it('rejects another browser, the wrong platform, unknown and expired states', () => {
		const c = fakeCookies();
		expect(consumeState('twitch', issueState('twitch', c), fakeCookies())).toBe(false);
		expect(consumeState('youtube', issueState('twitch', c), c)).toBe(false);
		expect(consumeState('twitch', 'made-up', c)).toBe(false);
		const old = issueState('twitch', c, Date.now() - 11 * 60_000);
		expect(consumeState('twitch', old, c)).toBe(false);
	});
});

describe('event mapping', () => {
	it('maps a Super Chat with its amount label', () => {
		const e = youtubeEvent({
			id: 'm1',
			snippet: { type: 'superChatEvent', publishedAt: t(1), superChatDetails: { amountDisplayString: '₹500', userComment: 'hi' } },
			authorDetails: { displayName: 'deepak.v' }
		});
		expect(e).toMatchObject({ kind: 'superchat', label: 'SUPER CHAT · ₹500', text: 'hi', author: 'deepak.v' });
	});

	it('maps Twitch gifts and cheers, ignores unrelated notices', () => {
		expect(twitchEvent('channel.chat.notification', { notice_type: 'community_sub_gift', chatter_user_name: 'l', community_sub_gift: { total: 5 }, system_message: 'gift' }, 'x', t(1))).toMatchObject({
			kind: 'gift',
			label: 'GIFTED 5 SUBS'
		});
		expect(twitchEvent('channel.cheer', { bits: 100, user_name: 'o', message: 'Cheer100' }, 'c1', t(1))).toMatchObject({ kind: 'cheer', label: '100 BITS', id: 'c1' });
		expect(twitchEvent('channel.chat.notification', { notice_type: 'announcement' }, 'y', t(1))).toBeUndefined();
	});
});

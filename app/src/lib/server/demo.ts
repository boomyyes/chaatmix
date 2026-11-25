// DEMO=1: fake chat so the UI can be worked on without a live stream. Never enabled in production.
import type { ChatEvent } from '#lib/types.ts';
import { publish, setStatus } from './hub.ts';

const lines: Omit<ChatEvent, 'id' | 'ts'>[] = [
	{ platform: 'youtube', kind: 'message', author: 'mira.draws', text: 'that combo was clean' },
	{ platform: 'twitch', kind: 'message', author: 'kxtsune', text: 'LET HIM COOK' },
	{ platform: 'youtube', kind: 'message', author: 'rohan_p', text: 'first time catching you live, hi from Pune' },
	{ platform: 'youtube', kind: 'superchat', author: 'deepak.v', text: 'Happy 100th stream! Play the boss rush next?', label: 'SUPER CHAT · ₹500' },
	{ platform: 'twitch', kind: 'message', author: 'nullbyte', text: 'audio slightly low on my end' },
	{ platform: 'twitch', kind: 'gift', author: 'lanternfish', text: 'Gave 5 Tier 1 subs to the community', label: 'GIFTED 5 SUBS' },
	{ platform: 'youtube', kind: 'message', author: 'sana.k', text: 'the lighting looks so good today' },
	{ platform: 'twitch', kind: 'cheer', author: 'okapi_ok', text: 'Cheer100 for the clutch', label: '100 BITS' },
	{ platform: 'youtube', kind: 'message', author: 'arjun_08', text: 'what controller is that?' },
	{ platform: 'twitch', kind: 'message', author: 'kxtsune', text: 'GG' }
];

export function startDemo() {
	setStatus({ platform: 'youtube', state: 'live' });
	setStatus({ platform: 'twitch', state: 'live' });
	let n = 0;
	setInterval(() => {
		const l = lines[n % lines.length];
		publish({ ...l, id: `demo-${n++}`, ts: new Date().toISOString() });
	}, 1500);
}

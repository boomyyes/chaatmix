import { load, save } from './state.ts';

// YouTube Data API: 10,000 units/day per project, reset at midnight Pacific.
export const DAILY = 10_000;
const SAVE_EVERY_MS = 5 * 60_000; // Object Storage requests are only free up to a monthly cap (50k at Always Free launch; current figure unconfirmed); don't save on every poll
const pacificDay = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

const q = { day: pacificDay(), used: 0, replies: 0 };
let lastSave = 0;

// Pick up what was used before a restart or watchdog reboot.
load()
	.then((s) => {
		if (s.quota?.day === q.day) [q.used, q.replies] = [Math.max(q.used, s.quota.used), Math.max(q.replies, s.quota.replies ?? 0)];
	})
	.catch(() => {});

export function usedToday() {
	if (pacificDay() !== q.day) [q.day, q.used, q.replies] = [pacificDay(), 0, 0];
	return q.used;
}

/** YouTube replies sent today (20 units each). */
export function repliesToday() {
	usedToday();
	return q.replies;
}

export function spend(units: number, reply = false) {
	usedToday();
	q.used += units;
	if (reply) q.replies++;
	if (Date.now() - lastSave < SAVE_EVERY_MS) return;
	lastSave = Date.now();
	load()
		.then((s) => {
			s.quota = { ...q };
			return save();
		})
		.catch(() => {});
}

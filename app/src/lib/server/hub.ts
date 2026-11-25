import type { ChatEvent, Platform, SourceStatus } from '#lib/types.ts';

const HOLD_MS = 2000; // YouTube arrives late; hold events this long so both platforms merge in true order
const RING = 200; // events kept for phones that reconnect

type Listener = (msg: { type: 'chat'; event: ChatEvent } | { type: 'status'; status: SourceStatus }) => void;

let seq = 0;
let pending: ChatEvent[] = [];
const ring: ChatEvent[] = [];
const seen = new Set<string>();
const listeners = new Set<Listener>();
const statuses = new Map<Platform, SourceStatus>([
	['youtube', { platform: 'youtube', state: 'waiting' }],
	['twitch', { platform: 'twitch', state: 'not_connected', reason: 'Twitch is not connected yet.', action: 'reconnect' }]
]);

/** Queue an event; it is released in timestamp order once it is HOLD_MS old. */
export function publish(event: ChatEvent) {
	if (Number.isNaN(Date.parse(event.ts))) event = { ...event, ts: new Date().toISOString() }; // never hold an event forever
	const key = `${event.platform}:${event.id}`;
	if (seen.has(key)) return; // YouTube resume and Twitch reconnects can repeat messages
	seen.add(key);
	if (seen.size > 5000) seen.delete(seen.values().next().value!);
	pending.push(event);
}

/** Release every held event older than HOLD_MS, oldest first. Exported for tests. */
export function flush(now = Date.now()) {
	const ready = pending.filter((e) => Date.parse(e.ts) <= now - HOLD_MS);
	if (!ready.length) return;
	pending = pending.filter((e) => Date.parse(e.ts) > now - HOLD_MS);
	ready.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
	for (const e of ready) {
		const out = { ...e, seq: ++seq };
		ring.push(out);
		if (ring.length > RING) ring.shift();
		for (const l of listeners) l({ type: 'chat', event: out });
	}
}

setInterval(flush, 250).unref?.();

export function since(lastSeq: number) {
	return ring.filter((e) => e.seq! > lastSeq);
}

export function setStatus(status: SourceStatus) {
	statuses.set(status.platform, status);
	for (const l of listeners) l({ type: 'status', status });
}

export function getStatuses() {
	return [...statuses.values()];
}

export function subscribe(listener: Listener) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

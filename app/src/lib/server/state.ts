import { readFile, writeFile, rename } from 'node:fs/promises';
import { env } from '#lib/server/env.ts';
import type { ChatEvent } from '#lib/types.ts';

export type Tokens = { access: string; refresh: string; expiresAt: number };
export type State = {
	twitch?: Tokens & { userId: string; login: string };
	google?: Tokens;
	pins: ChatEvent[];
	quota?: { day: string; used: number }; // YouTube units used today, so a reboot doesn't forget them
};

const FILE = env.STATE_FILE || 'state.json';
// Bucket pre-authenticated request (PAR) URL ending in /o/: read/write objects with no Oracle login or SDK.
const BUCKET = env.STATE_PAR_URL ? env.STATE_PAR_URL.replace(/\/?$/, '/') + 'state.json' : undefined;
let state: State | undefined;

async function bucketGet() {
	if (!BUCKET) return undefined;
	const res = await fetch(BUCKET);
	if (res.status === 404) return undefined;
	if (!res.ok) throw new Error(`state bucket read ${res.status}`); // never start empty over a real outage
	return res.text();
}

/** Bucket is the source of truth; the local file is only a cache. */
export async function load(): Promise<State> {
	if (state) return state;
	const raw = (await bucketGet()) ?? (await readFile(FILE, 'utf8').catch(() => undefined));
	state = raw ? (JSON.parse(raw) as State) : { pins: [] };
	state.pins ??= [];
	return state;
}

let writing = Promise.resolve();
/** Write-through: bucket first, then the local cache (temp file + rename so a crash can't corrupt it). */
export function save(): Promise<void> {
	writing = writing.catch(() => {}).then(async () => { // one failed write must not fail every later save
		const body = JSON.stringify(state);
		if (BUCKET) {
			const res = await fetch(BUCKET, { method: 'PUT', body, headers: { 'Content-Type': 'application/json' } });
			if (!res.ok) throw new Error(`state bucket write ${res.status}`);
		}
		await writeFile(FILE + '.tmp', body);
		await rename(FILE + '.tmp', FILE);
	});
	return writing;
}

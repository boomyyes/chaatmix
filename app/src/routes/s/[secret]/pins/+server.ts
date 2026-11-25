import { json } from '@sveltejs/kit';
import { load, save } from '#lib/server/state.ts';
import type { ChatEvent } from '#lib/types.ts';
import type { RequestHandler } from './$types';

/** Toggle a pin: pinned → unpinned, otherwise pinned. Returns the full list. */
export const POST: RequestHandler = async ({ request }) => {
	const ev = (await request.json()) as ChatEvent;
	const s = await load();
	const key = `${ev.platform}:${ev.id}`;
	const i = s.pins.findIndex((p) => `${p.platform}:${p.id}` === key);
	if (i >= 0) s.pins.splice(i, 1);
	else s.pins.push({ id: ev.id, platform: ev.platform, kind: ev.kind, author: ev.author, text: ev.text, label: ev.label, ts: ev.ts });
	await save();
	return json(s.pins);
};

export const DELETE: RequestHandler = async () => {
	const s = await load();
	s.pins = [];
	await save();
	return json(s.pins);
};

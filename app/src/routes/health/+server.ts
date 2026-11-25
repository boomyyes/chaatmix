import { json } from '@sveltejs/kit';
import { getStatuses } from '#lib/server/hub.ts';
import { DAILY, usedToday } from '#lib/server/quota.ts';
import type { RequestHandler } from './$types';

/** Read by the watchdog. Always 200 while the process is up; `ok` is false when a source needs a human. */
export const GET: RequestHandler = () => {
	const sources = getStatuses();
	return json({ ok: !sources.some((s) => s.state === 'error'), sources, youtubeQuota: { used: usedToday(), daily: DAILY } });
};

import { error, json } from '@sveltejs/kit';
import * as twitch from '#lib/server/twitch.ts';
import * as youtube from '#lib/server/youtube.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const { platform, messageId, author, text } = await request.json();
	const body = String(text ?? '').trim();
	if (!body || body.length > 200) error(400, 'Replies must be 1–200 characters.');
	if (platform !== 'twitch' && platform !== 'youtube') error(400, 'Unknown platform.');
	try {
		if (platform === 'twitch') await twitch.reply(String(messageId), body);
		else await youtube.reply(String(author), body);
	} catch (e) {
		return json({ ok: false, error: (e as Error).message }, { status: 502 });
	}
	return json({ ok: true });
};

import { error, redirect } from '@sveltejs/kit';
import { env } from '#lib/server/env.ts';
import { consumeState } from '#lib/server/oauth.ts';
import * as twitch from '#lib/server/twitch.ts';
import * as youtube from '#lib/server/youtube.ts';
import type { RequestHandler } from './$types';

/** Fixed return path (no secret in it); only a state this server just issued to this browser is accepted. */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const platform = params.platform === 'google' ? 'youtube' : params.platform;
	if (platform !== 'twitch' && platform !== 'youtube') error(404);
	if (!consumeState(platform, url.searchParams.get('state'), cookies)) error(400, 'This login link expired. Open chaat-mix and try again.');
	const code = url.searchParams.get('code');
	if (!code) error(400, 'Login was cancelled.');
	await (platform === 'twitch' ? twitch.connectWithCode(code) : youtube.connectWithCode(code));
	redirect(303, `/s/${env.ACCESS_SECRET}/`);
};

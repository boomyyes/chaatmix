import { error, redirect } from '@sveltejs/kit';
import { issueState } from '#lib/server/oauth.ts';
import * as twitch from '#lib/server/twitch.ts';
import * as youtube from '#lib/server/youtube.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, cookies }) => {
	// SvelteKit 3 blocks external redirects unless the target origin is allowed explicitly.
	if (params.platform === 'twitch') redirect(303, twitch.authUrl(issueState('twitch', cookies)), { external: ['https://id.twitch.tv'] });
	if (params.platform === 'youtube') redirect(303, youtube.authUrl(issueState('youtube', cookies)), { external: ['https://accounts.google.com'] });
	error(404);
};

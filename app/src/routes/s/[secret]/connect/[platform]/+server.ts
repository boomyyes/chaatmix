import { error, redirect } from '@sveltejs/kit';
import { issueState } from '#lib/server/oauth.ts';
import * as twitch from '#lib/server/twitch.ts';
import * as youtube from '#lib/server/youtube.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, cookies }) => {
	if (params.platform === 'twitch') redirect(303, twitch.authUrl(issueState('twitch', cookies)));
	if (params.platform === 'youtube') redirect(303, youtube.authUrl(issueState('youtube', cookies)));
	error(404);
};

import { error } from '@sveltejs/kit';
import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { env } from '#lib/server/env.ts';
import { safeEqual } from '#lib/server/oauth.ts';
import * as twitch from '#lib/server/twitch.ts';
import * as youtube from '#lib/server/youtube.ts';

export const init: ServerInit = () => {
	if (!env.ACCESS_SECRET || env.ACCESS_SECRET.length < 24) throw new Error('ACCESS_SECRET must be set (24+ random characters).');
	if (env.DEMO === '1') return void import('#lib/server/demo.ts').then((m) => m.startDemo());
	twitch.start();
	youtube.start();
};

/**
 * Everything under /s/<secret>/ requires the access secret; anything else there is a plain 404.
 * Checks the route the router actually matched, not the raw path: "/%73/x/…" decodes to "/s/x/…".
 */
export const handle: Handle = async ({ event, resolve }) => {
	if (event.route.id?.startsWith('/s/[secret]') && !safeEqual(event.params.secret ?? '', env.ACCESS_SECRET!)) error(404);
	return resolve(event);
};

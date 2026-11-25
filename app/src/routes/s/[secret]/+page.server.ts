import { load as loadState } from '#lib/server/state.ts';
import { hasReplyLogin } from '#lib/server/youtube.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({
	pins: (await loadState()).pins,
	youtubeReplies: await hasReplyLogin()
});

import type { RequestHandler } from './$types';

/** Served under /s/<secret>/ so the relative start_url keeps the secret (iOS home-screen apps don't share Safari cookies). */
export const GET: RequestHandler = () =>
	new Response(
		JSON.stringify({
			name: 'chaat-mix',
			short_name: 'chaat-mix',
			start_url: './',
			scope: './',
			display: 'standalone',
			background_color: '#020A04',
			theme_color: '#020A04'
		}),
		{ headers: { 'Content-Type': 'application/manifest+json' } }
	);

import { getStatuses, since, subscribe } from '#lib/server/hub.ts';
import type { RequestHandler } from './$types';

/** Server-Sent Events: replays missed events by Last-Event-ID, then streams chat and status. */
export const GET: RequestHandler = ({ request }) => {
	const last = Number(request.headers.get('last-event-id') ?? 0) || 0;
	let cleanup = () => {};
	const stream = new ReadableStream({
		start(controller) {
			const enc = new TextEncoder();
			const send = (s: string) => {
				try {
					controller.enqueue(enc.encode(s));
				} catch {
					cleanup();
				}
			};
			send('retry: 3000\n\n');
			send(`event: status\ndata: ${JSON.stringify(getStatuses())}\n\n`);
			for (const e of since(last)) send(`id: ${e.seq}\nevent: chat\ndata: ${JSON.stringify(e)}\n\n`);
			const unsub = subscribe((m) =>
				m.type === 'chat'
					? send(`id: ${m.event.seq}\nevent: chat\ndata: ${JSON.stringify(m.event)}\n\n`)
					: send(`event: status\ndata: ${JSON.stringify(getStatuses())}\n\n`)
			);
			const ping = setInterval(() => send(': ping\n\n'), 25_000); // keeps proxies from closing an idle stream
			cleanup = () => {
				unsub();
				clearInterval(ping);
			};
		},
		cancel() {
			cleanup();
		}
	});
	return new Response(stream, {
		headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }
	});
};

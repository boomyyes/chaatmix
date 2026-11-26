<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { page } from '$app/state';
	import type { ChatEvent, Platform, SourceStatus } from '#lib/types.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const MAX = 500; // messages kept on screen; pinned and paid ones are dropped last
	const base = $derived(page.url.pathname.replace(/\/?$/, '/'));

	let messages = $state<ChatEvent[]>([]);
	let statuses = $state<SourceStatus[]>([]);
	let pins = $state<ChatEvent[]>(untrack(() => data.pins)); // server copy at load; updated from pin responses
	let online = $state(true);
	let newCount = $state(0);
	let atBottom = true;
	let feed = $state<HTMLElement>();
	let now = $state(Date.now());
	let showPins = $state(false);
	let textScale = $state(1);
	let replyTo = $state<ChatEvent | null>(null);
	let replyText = $state('');
	let replyError = $state('');
	let sending = $state(false);
	let announce = $state('');

	const isPaid = (e: ChatEvent) => e.kind !== 'message';
	const key = (e: ChatEvent) => `${e.platform}:${e.id}`;
	const pinned = $derived(new Set(pins.map(key)));
	const status = (p: Platform) => statuses.find((s) => s.platform === p);
	const nothingLive = $derived(statuses.length > 0 && statuses.every((s) => s.state !== 'live') && messages.length === 0);
	const issue = $derived(
		!online
			? { platform: undefined, title: 'CONNECTION LOST', reason: 'Reconnecting to chaat-mix…', action: undefined }
			: (() => {
					const s = statuses.find((s) => s.state === 'error' || (s.state === 'not_connected' && s.action));
					if (!s) return undefined;
					const name = s.platform === 'youtube' ? 'YOUTUBE' : 'TWITCH';
					return { platform: s.platform, title: s.state === 'error' ? `${name} PROBLEM` : `${name} NOT CONNECTED`, reason: s.reason ?? '', action: s.action };
				})()
	);

	function age(ts: string) {
		const s = Math.max(0, Math.round((now - Date.parse(ts)) / 1000));
		return s < 10 ? 'now' : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
	}

	function trim(list: ChatEvent[]) {
		while (list.length > MAX) {
			const i = list.findIndex((e) => !isPaid(e) && !pinned.has(key(e)));
			list.splice(i >= 0 ? i : 0, 1);
		}
	}

	async function add(e: ChatEvent) {
		const last = messages.at(-1);
		messages.push(e);
		if (last && Date.parse(e.ts) < Date.parse(last.ts)) messages.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
		trim(messages);
		if (isPaid(e)) announce = `${e.label} from ${e.author}`;
		if (atBottom) {
			await tick();
			feed!.scrollTop = feed!.scrollHeight;
		} else newCount++;
	}

	function onScroll() {
		atBottom = feed!.scrollHeight - feed!.scrollTop - feed!.clientHeight < 40;
		if (atBottom) newCount = 0;
	}

	function jumpToNew() {
		feed!.scrollTo({ top: feed!.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
		newCount = 0;
	}

	async function togglePin(e: ChatEvent) {
		const res = await fetch(`${base}pins`, { method: 'POST', body: JSON.stringify(e) });
		if (res.ok) pins = await res.json();
	}

	async function clearPins() {
		if (!confirm(`Clear ${pins.length} pins?`)) return;
		const res = await fetch(`${base}pins`, { method: 'DELETE' });
		if (res.ok) pins = await res.json();
	}

	function startReply(e: ChatEvent) {
		replyTo = e;
		replyText = e.platform === 'youtube' ? `@${e.author} ` : '';
		replyError = '';
	}

	async function sendReply(ev: SubmitEvent) {
		ev.preventDefault();
		if (!replyTo || !replyText.trim()) return;
		sending = true;
		replyError = '';
		try {
			const res = await fetch(`${base}reply`, {
				method: 'POST',
				body: JSON.stringify({ platform: replyTo.platform, messageId: replyTo.id, author: replyTo.author, text: replyText })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body.error ?? body.message ?? 'Reply failed.');
			replyTo = null;
		} catch (e) {
			replyError = (e as Error).message;
		} finally {
			sending = false;
		}
	}

	// Neither platform's API has like or heart for chat, so "thanks" is a one-tap reply.
	let thanked = $state(new Set<string>());
	async function thank(e: ChatEvent) {
		if (e.platform === 'youtube' && !data.youtubeReplies) return startReply(e); // shows the connect button
		thanked.add(key(e));
		thanked = new Set(thanked);
		const res = await fetch(`${base}reply`, {
			method: 'POST',
			body: JSON.stringify({ platform: e.platform, messageId: e.id, author: e.author, text: `${e.platform === 'youtube' ? `@${e.author} ` : ''}thank you ❤️` })
		}).catch(() => undefined);
		if (!res?.ok) {
			thanked.delete(key(e));
			thanked = new Set(thanked);
			startReply(e);
			replyError = 'Thanks did not send. Try again or type a reply.';
		}
	}

	// Pins sheet: slides in and out; drag the top bar down to close or shrink it, up to expand it.
	let expanded = $state(false);
	let dragY = $state(0);
	let dragStart = $state<number | null>(null);
	function dragDown(ev: PointerEvent) {
		dragStart = ev.clientY;
		(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
	}
	function dragMove(ev: PointerEvent) {
		if (dragStart !== null) dragY = Math.max(ev.clientY - dragStart, -240);
	}
	function dragEnd() {
		if (dragStart === null) return;
		if (dragY > 80) expanded ? (expanded = false) : closePins();
		else if (dragY < -60) expanded = true;
		dragStart = null;
		dragY = 0;
	}
	function closePins() {
		showPins = false;
		expanded = false;
	}

	function cycleTextSize() {
		textScale = textScale >= 1.3 ? 0.9 : Math.round((textScale + 0.2) * 10) / 10;
		try {
			localStorage.setItem('textScale', String(textScale));
		} catch {}
	}

	onMount(() => {
		try {
			textScale = Number(localStorage.getItem('textScale')) || 1;
		} catch {}
		const es = new EventSource(`${base}events`);
		es.addEventListener('chat', (m) => add(JSON.parse(m.data)));
		es.addEventListener('status', (m) => (statuses = JSON.parse(m.data)));
		es.onopen = () => (online = true);
		es.onerror = () => (online = false);
		const clock = setInterval(() => (now = Date.now()), 1_000);

		// keep the screen on while the app is open
		let lock: { release(): Promise<void> } | undefined;
		const wake = async () => {
			if (document.visibilityState === 'visible') lock = await (navigator as any).wakeLock?.request('screen').catch(() => undefined);
		};
		wake();
		document.addEventListener('visibilitychange', wake);
		return () => {
			es.close();
			clearInterval(clock);
			document.removeEventListener('visibilitychange', wake);
			lock?.release();
		};
	});
</script>

<svelte:head>
	<title>chaat-mix</title>
	<meta name="theme-color" content="#020A04" />
	<link rel="manifest" href="{base}manifest.webmanifest" />
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link
		rel="stylesheet"
		href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:wght@400;700&family=JetBrains+Mono:wght@400;700&family=Noto+Sans+Devanagari:wght@700&display=swap"
	/>
</svelte:head>

<svelte:window onkeydown={(ev) => ev.key === 'Escape' && showPins && closePins()} />

{#snippet icon(p: Platform, size = 20)}
	{#if p === 'youtube'}
		<svg width={size} height={size} viewBox="0 0 20 20" role="img" aria-label="YouTube"><rect x="1" y="4" width="18" height="12" rx="3" fill="var(--yt)" /><path d="M8 7.2v5.6l4.8-2.8z" fill="var(--bg)" /></svg>
	{:else}
		<svg width={size} height={size} viewBox="0 0 20 20" role="img" aria-label="Twitch"><path d="M3 2h15v10l-4 4h-3l-3 3v-3H4l-1-1z" fill="var(--tw)" /><rect x="9" y="5.5" width="1.8" height="5" fill="var(--bg)" /><rect x="13" y="5.5" width="1.8" height="5" fill="var(--bg)" /></svg>
	{/if}
{/snippet}

{#snippet pinIcon(filled: boolean)}
	<svg width="20" height="20" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6l-1 6 4 4H6l4-4z" /><path d="M12 13v8" stroke-linecap="round" /></svg>
{/snippet}

{#snippet words(e: ChatEvent)}
	{#if e.parts}
		{#each e.parts as p, i (i)}{#if p.emote}<img class="emote" src={p.emote} alt={p.text} title={p.text} loading="lazy" />{:else}{p.text}{/if}{/each}
	{:else}{e.text}{/if}
{/snippet}

{#snippet paidCard(e: ChatEvent)}
	<div class="paid">
		{@render icon(e.platform)}
		<div class="paid-body">
			<span class="label">{e.label}</span>
			<span class="paid-author">{e.author}</span>
			{#if e.text}<span class="text">{@render words(e)}</span>{/if}
		</div>
		<div class="actions">
			<button class="icon-btn heart" class:done={thanked.has(key(e))} aria-label="Thank {e.author}" aria-pressed={thanked.has(key(e))} disabled={thanked.has(key(e))} onclick={() => thank(e)}>
				<svg width="20" height="20" viewBox="0 0 24 24" fill={thanked.has(key(e)) ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" /></svg>
			</button>
			<button class="icon-btn" aria-label="{pinned.has(key(e)) ? 'Unpin' : 'Pin'} message from {e.author}" aria-pressed={pinned.has(key(e))} onclick={() => togglePin(e)}>
				{@render pinIcon(pinned.has(key(e)))}
			</button>
			<button class="icon-btn" aria-label="Reply to {e.author}" onclick={() => startReply(e)}>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 6 6v5" /></svg>
			</button>
		</div>
	</div>
{/snippet}

<div class="screen" style="--scale: {textScale}">
	<header>
		<div class="brand">
			<span class="wordmark">CHAAT//MIX</span>
			<span class="hindi" lang="hi">चाट मिक्स</span>
			<div class="sev" aria-hidden="true"></div>
		</div>
		<div class="controls">
			{#each ['youtube', 'twitch'] as const as p}
				{@const s = status(p)}
				<span class="chip is-{s?.state ?? 'waiting'}">
					{@render icon(p, 16)}{s?.state === 'live' ? 'LIVE' : s?.state === 'error' ? 'ERROR' : s?.state === 'not_connected' ? 'OFF' : 'WAITING'}
				</span>
			{/each}
			<div class="grow"></div>
			<button class="box-btn" aria-label="Text size" onclick={cycleTextSize}>Aa</button>
			<button class="box-btn pins-btn" aria-label="Pinned messages, {pins.length}" aria-expanded={showPins} onclick={() => (showPins = true)}>
				{@render pinIcon(false)}{pins.length}
			</button>
		</div>
	</header>

	{#if nothingLive}
		<main class="waiting">
			<h1>&gt; chaat is being mixed<span class="cursor">_</span></h1>
			<p>Waiting for your streams. Chat shows up here, garma-garam, the moment YouTube or Twitch goes live. Nothing to set up.</p>
			<div class="waiting-rows">
				{#each statuses as s (s.platform)}
					<div>{@render icon(s.platform, 18)}<span>{s.platform.toUpperCase()} · {s.reason ?? s.state}</span></div>
				{/each}
			</div>
		</main>
	{:else}
		<main class="feed" role="log" aria-label="Chat" aria-live="off" bind:this={feed} onscroll={onScroll}>
			{#each messages as e (key(e))}
				{#if isPaid(e)}
					{@render paidCard(e)}
				{:else}
					<div class="msg">
						{@render icon(e.platform)}
						<div class="msg-body">
							<div class="msg-head"><span class="author">{e.author}</span><span class="age">{age(e.ts)}</span></div>
							<button class="text as-text" onclick={() => startReply(e)} aria-label="Reply to {e.author}: {e.text}">{@render words(e)}</button>
						</div>
					</div>
				{/if}
			{/each}
		</main>
	{/if}

	<div class="bottom">
		{#if newCount > 0}
			<button class="new-pill" onclick={jumpToNew}>{newCount} NEW ↓</button>
		{/if}
		{#if issue && !replyTo}
			<div class="popup" role="status">
				{#if issue.platform}{@render icon(issue.platform)}{/if}
				<div class="grow">
					<div class="popup-title">{issue.title}</div>
					<div class="popup-reason">{issue.reason}</div>
				</div>
				{#if issue.action === 'reconnect' && issue.platform}
					<a class="popup-action" href="{base}connect/{issue.platform}">RECONNECT</a>
				{/if}
			</div>
		{/if}
	</div>

	{#if replyTo}
		<form class="compose" onsubmit={sendReply}>
			<div class="compose-head">
				{@render icon(replyTo.platform, 14)}
				<span class="grow">REPLYING TO @{replyTo.author} · {replyTo.platform.toUpperCase()}</span>
				<button type="button" class="icon-btn muted" aria-label="Cancel reply" onclick={() => (replyTo = null)}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
				</button>
			</div>
			{#if replyTo.platform === 'youtube' && !data.youtubeReplies}
				<a class="connect-yt" href="{base}connect/youtube">CONNECT YOUTUBE TO REPLY</a>
			{:else}
				<div class="compose-row">
					<label class="grow">
						<span class="sr-only">Reply message</span>
						<!-- svelte-ignore a11y_autofocus -->
						<input bind:value={replyText} maxlength="200" autofocus />
					</label>
					<button type="submit" class="send" disabled={sending}>{sending ? '…' : 'SEND'}</button>
				</div>
				{#if replyError}<div class="reply-error" role="alert">{replyError}</div>{/if}
			{/if}
		</form>
	{/if}

	<div class="scrim" class:open={showPins} aria-hidden="true"></div>
	<div
		class="sheet"
		class:open={showPins}
		class:expanded
		class:dragging={dragStart !== null}
		style:transform={showPins ? `translateY(${dragY}px)` : undefined}
		role="dialog"
		aria-label="Pinned messages"
		inert={!showPins}
	>
		<!-- svelte-ignore a11y_no_static_element_interactions (drag is a touch shortcut; the close button and Escape cover keyboard and screen readers) -->
		<div class="sheet-top" onpointerdown={dragDown} onpointermove={dragMove} onpointerup={dragEnd} onpointercancel={dragEnd}>
			<div class="grabber" aria-hidden="true"></div>
			<div class="sheet-head">
				<h2>PINNED // {pins.length}</h2>
				{#if pins.length}<button class="box-btn clear" onpointerdown={(ev) => ev.stopPropagation()} onclick={clearPins}>CLEAR ALL</button>{/if}
				<button class="icon-btn muted" aria-label="Close pinned messages" onpointerdown={(ev) => ev.stopPropagation()} onclick={closePins}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
				</button>
			</div>
		</div>
		<div class="sheet-list">
			{#each pins as p (key(p))}
				{@render paidCard(p)}
			{:else}
				<p class="empty">Nothing pinned. Tap the pin on a Super Chat or sub to keep it here.</p>
			{/each}
		</div>
	</div>

	<div class="sr-only" aria-live="polite">{announce}{issue ? ` ${issue.title}: ${issue.reason}` : ''}</div>
	<div class="scanlines" aria-hidden="true"></div>
</div>

<style>
	:global(html, body) {
		margin: 0;
		height: 100%;
		background: #020a04;
	}
	.screen {
		/* mint chutney, pomegranate, tamarind */
		--bg: #020a04;
		--surface: #06170b;
		--surface2: #0a2212;
		--border: #164d27;
		--text: #b8ffb0;
		--muted: #5e9e66;
		--accent: #33ff66;
		--pop: #ff2bd6;
		--paid-bg: #1f0619;
		--warn: #ffb000;
		--warn-bg: #1f1500;
		--yt: #ff5c5c;
		--tw: #b48cff;
		--mono: 'JetBrains Mono', ui-monospace, monospace;
		position: relative;
		height: 100dvh;
		max-width: 520px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--bg);
		color: var(--text);
		font-family: 'Atkinson Hyperlegible Next', system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji';
		font-variant-emoji: emoji; /* ❤ and friends in colour, not tinted the text green */
	}
	button {
		font: inherit;
		cursor: pointer;
	}
	.grow {
		flex: 1;
		min-width: 0;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
	header {
		padding: max(env(safe-area-inset-top), 12px) 16px 10px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		border-bottom: 1px solid var(--accent);
		box-shadow: 0 0 14px rgb(51 255 102 / 0.25);
		z-index: 2;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.wordmark {
		font-family: var(--mono);
		font-weight: 700;
		font-size: 13px;
		letter-spacing: 0.12em;
		color: var(--accent);
	}
	.hindi {
		font-family: 'Noto Sans Devanagari', sans-serif;
		font-weight: 700;
		font-size: 13px;
		color: var(--pop);
	}
	.sev {
		flex: 1;
		height: 3px;
		background: repeating-linear-gradient(90deg, var(--warn) 0 7px, transparent 7px 10px, var(--pop) 10px 12px, transparent 12px 15px, var(--accent) 15px 19px, transparent 19px 23px);
	}
	.controls {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.chip {
		flex-shrink: 0;
		white-space: nowrap;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px 6px 8px;
		border: 1px solid var(--border);
		background: var(--surface2);
		font: 700 12px var(--mono);
		letter-spacing: 0.06em;
		color: var(--muted);
	}
	.chip.is-live {
		color: var(--accent);
	}
	.chip.is-error,
	.chip.is-not_connected {
		color: var(--warn);
		border-color: var(--warn);
		background: var(--warn-bg);
	}
	.box-btn {
		min-width: 44px;
		height: 44px;
		padding: 0 12px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border: 1px solid var(--border);
		background: var(--surface2);
		color: var(--text);
		font: 700 15px var(--mono);
	}
	.pins-btn {
		color: var(--pop);
	}
	.feed {
		flex: 1;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 8px 0 120px;
		display: flex;
		flex-direction: column;
	}
	.feed > :first-child {
		margin-top: auto; /* newest at the bottom even when the feed is short */
	}
	.msg {
		display: flex;
		gap: 10px;
		padding: 7px 16px;
	}
	.msg :global(svg),
	.paid :global(svg) {
		flex-shrink: 0;
		margin-top: 2px;
	}
	.msg-body,
	.paid-body {
		flex: 1;
		min-width: 0;
	}
	.msg-head {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	.author {
		font: 700 calc(14px * var(--scale)) var(--mono);
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.age {
		margin-left: auto;
		font: 400 12px var(--mono);
		color: var(--muted);
	}
	.text {
		font-size: calc(19px * var(--scale));
		line-height: 1.37;
		overflow-wrap: anywhere;
	}
	.as-text {
		display: block;
		width: 100%;
		padding: 0;
		border: 0;
		background: none;
		color: inherit;
		text-align: left;
	}
	.paid {
		margin: 6px 16px;
		display: flex;
		gap: 12px;
		padding: 12px 6px 12px 14px;
		background: var(--paid-bg);
		border: 1px solid var(--pop);
		box-shadow: 0 0 18px rgb(255 43 214 / 0.35);
	}
	.paid-body {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.label {
		font: 700 13px var(--mono);
		letter-spacing: 0.08em;
		color: var(--pop);
	}
	.paid-author {
		font: 700 calc(15px * var(--scale)) var(--mono);
	}
	.paid .text {
		font-size: calc(19px * var(--scale));
	}
	.actions {
		display: flex;
		flex-direction: column;
	}
	.icon-btn {
		width: 44px;
		height: 44px;
		border: 0;
		background: transparent;
		color: var(--pop);
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.icon-btn.muted {
		color: var(--muted);
	}
	.waiting {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 14px;
		padding: 0 28px;
	}
	.waiting h1 {
		margin: 0;
		font: 700 22px var(--mono);
		color: var(--accent);
		text-shadow: 0 0 12px rgb(51 255 102 / 0.55);
	}
	.cursor {
		color: var(--pop);
		animation: blink 1s steps(1) infinite;
	}
	.waiting p {
		margin: 0;
		font-size: 18px;
		line-height: 26px;
	}
	.waiting-rows {
		margin-top: 10px;
		padding: 14px;
		border: 1px solid var(--border);
		background: var(--surface);
		display: flex;
		flex-direction: column;
		gap: 10px;
		font: 400 13px var(--mono);
		color: var(--muted);
	}
	.waiting-rows div {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.bottom {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 3;
		padding: 0 16px max(env(safe-area-inset-bottom), 16px);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		pointer-events: none;
	}
	.bottom > * {
		pointer-events: auto;
	}
	.new-pill {
		padding: 12px 18px;
		border: 0;
		background: var(--accent);
		color: var(--bg);
		box-shadow: 0 0 20px rgb(51 255 102 / 0.6);
		font: 700 14px var(--mono);
		letter-spacing: 0.06em;
	}
	.popup {
		align-self: stretch;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 8px 10px 14px;
		background: var(--warn-bg);
		border: 1px solid var(--warn);
		box-shadow: 0 0 22px rgb(255 176 0 / 0.4);
	}
	.popup-title {
		font: 700 13px var(--mono);
		letter-spacing: 0.06em;
		color: var(--warn);
	}
	.popup-reason {
		font-size: 14px;
		line-height: 19px;
	}
	.popup-action {
		height: 44px;
		padding: 0 14px;
		display: inline-flex;
		align-items: center;
		background: var(--warn);
		color: var(--bg);
		font: 700 13px var(--mono);
		text-decoration: none;
	}
	.compose {
		position: relative;
		z-index: 4;
		padding: 10px 12px max(env(safe-area-inset-bottom), 14px);
		display: flex;
		flex-direction: column;
		gap: 8px;
		background: var(--surface);
		border-top: 1px solid var(--pop);
		box-shadow: 0 -6px 24px rgb(255 43 214 / 0.25);
	}
	.compose-head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding-left: 4px;
		font: 700 12px var(--mono);
		letter-spacing: 0.06em;
		color: var(--pop);
	}
	.compose-row {
		display: flex;
		gap: 8px;
	}
	.compose-row label {
		display: flex;
	}
	input {
		flex: 1;
		min-width: 0;
		height: 48px;
		padding: 0 12px;
		border: 1px solid var(--border);
		background: var(--bg);
		color: var(--text);
		font: 400 17px 'Atkinson Hyperlegible Next', sans-serif;
	}
	input:focus-visible,
	button:focus-visible,
	a:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.send {
		height: 48px;
		padding: 0 16px;
		border: 0;
		background: var(--pop);
		color: var(--bg);
		box-shadow: 0 0 18px rgb(255 43 214 / 0.5);
		font: 700 14px var(--mono);
	}
	.connect-yt {
		height: 48px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--pop);
		color: var(--bg);
		font: 700 14px var(--mono);
		text-decoration: none;
	}
	.reply-error {
		font-size: 14px;
		color: var(--warn);
	}
	.scrim {
		position: absolute;
		inset: 0;
		z-index: 5;
		background: rgb(0 0 0 / 0.6);
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.28s ease;
	}
	.scrim.open {
		opacity: 1;
	}
	.sheet {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 6;
		height: 60%;
		display: flex;
		flex-direction: column;
		background: var(--surface);
		border-top: 1px solid var(--accent);
		box-shadow: 0 -8px 30px rgb(51 255 102 / 0.25);
		transform: translateY(110%);
		transition:
			transform 0.32s cubic-bezier(0.2, 0.9, 0.3, 1),
			height 0.32s cubic-bezier(0.2, 0.9, 0.3, 1);
	}
	.sheet.expanded {
		height: 92%;
	}
	.sheet.dragging {
		transition: none;
	}
	.sheet-top {
		padding-top: 10px;
		touch-action: none; /* the drag is ours, not the page's scroll */
		cursor: grab;
	}
	.sheet-list {
		flex: 1;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding-bottom: max(env(safe-area-inset-bottom), 24px);
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.grabber {
		margin: 0 auto 6px;
		width: 48px;
		height: 5px;
		background: var(--accent);
	}
	.emote {
		height: 1.6em;
		vertical-align: middle;
		margin: -0.3em 0.1em;
	}
	.heart.done {
		color: var(--yt);
	}
	.heart:not(.done):active svg {
		transform: scale(1.3);
	}
	/* new messages slide in; paid ones flash once */
	.msg,
	.paid {
		animation: arrive 0.25s ease-out;
	}
	.feed .paid {
		animation:
			arrive 0.25s ease-out,
			flash 1.2s ease-out;
	}
	.chip.is-live :global(svg) {
		animation: pulse 2s ease-in-out infinite;
	}
	@keyframes arrive {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
	}
	@keyframes flash {
		0% {
			box-shadow: 0 0 40px rgb(255 43 214 / 0.9);
		}
	}
	@keyframes pulse {
		50% {
			opacity: 0.45;
		}
	}
	.sheet-head {
		display: flex;
		align-items: center;
		padding: 0 16px;
	}
	.sheet-head h2 {
		flex: 1;
		margin: 0;
		font: 700 16px var(--mono);
		letter-spacing: 0.08em;
		color: var(--accent);
	}
	.clear {
		font-size: 12px;
	}
	.empty {
		padding: 0 16px;
		color: var(--muted);
	}
	.scanlines {
		position: absolute;
		inset: 0;
		pointer-events: none;
		z-index: 10;
		background: repeating-linear-gradient(to bottom, transparent 0 2px, rgb(0 0 0 / 0.22) 2px 3px);
	}
	@keyframes blink {
		50% {
			opacity: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.cursor,
		.msg,
		.paid,
		.feed .paid,
		.chip.is-live :global(svg) {
			animation: none;
		}
		.sheet,
		.scrim {
			transition: none;
		}
	}
</style>

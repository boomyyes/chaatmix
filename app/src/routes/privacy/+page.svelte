<svelte:head><title>Privacy policy · chaat-mix</title></svelte:head>

<main>
	<h1>Privacy policy</h1>
	<p>chaat-mix is a private tool used by one streamer. This page explains what it does with data.</p>

	<h2>What it accesses</h2>
	<ul>
		<li><strong>Public live chat</strong> from the streamer's YouTube and Twitch streams: names, messages, Super Chats, memberships, subs and bits, as shown publicly in chat.</li>
		<li>
			<strong>Google (YouTube) account access</strong>, only when the streamer chooses "Connect YouTube": the <code>youtube.force-ssl</code> permission,
			used for one thing only, to post the streamer's own replies into their live chat.
		</li>
		<li><strong>Twitch account access</strong>, when the streamer chooses "Connect Twitch": reading chat, reading bits, and sending the streamer's replies.</li>
	</ul>

	<h2>What it stores</h2>
	<ul>
		<li>The login tokens for Google and Twitch, kept in private, access-controlled storage so the streamer does not have to log in again.</li>
		<li>Messages the streamer pins, until they unpin or clear them.</li>
		<li>Recent chat is held in memory only and is not saved.</li>
	</ul>

	<h2>What it does not do</h2>
	<ul>
		<li>It does not sell, share or transfer Google or Twitch user data to anyone.</li>
		<li>It does not use the data for advertising, profiling or training AI models.</li>
		<li>It only posts a message when the streamer writes and sends a reply.</li>
	</ul>
	<p>Use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.</p>

	<h2>Removing access</h2>
	<p>
		The streamer can revoke access at any time from their Google account (Security → Third-party apps) or Twitch (Settings → Connections).
		Revoking access stops the app from using the stored tokens; the developer deletes them on request.
	</p>

	<h2>Contact</h2>
	<p>Questions: contact the developer at the email shown on the Google sign-in screen for chaat-mix.</p>

	<p><a href="/">Home</a> · <a href="/terms">Terms of service</a></p>
</main>

<style>
	main {
		max-width: 640px;
		margin: 48px auto;
		padding: 0 16px;
		font: 17px/1.6 system-ui, sans-serif;
	}
</style>

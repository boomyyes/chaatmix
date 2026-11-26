export type Platform = 'youtube' | 'twitch';

export type Kind =
	| 'message'
	| 'superchat'
	| 'supersticker'
	| 'membership'
	| 'milestone'
	| 'gift'
	| 'sub'
	| 'resub'
	| 'cheer'
	| 'raid';

export type ChatEvent = {
	id: string; // platform message id
	platform: Platform;
	kind: Kind;
	author: string;
	text: string;
	parts?: { text: string; emote?: string }[]; // Twitch only: text split into words and emote image URLs
	label?: string; // paid/support events: "SUPER CHAT · ₹500", "100 BITS"
	ts: string; // platform timestamp, ISO 8601 UTC
	seq?: number; // set by the hub; used for replay
};

export type SourceState = 'live' | 'waiting' | 'not_connected' | 'error';

export type SourceStatus = {
	platform: Platform;
	state: SourceState;
	reason?: string; // plain language, shown in the issue popup
	action?: 'reconnect'; // the one thing the streamer can do about it
};

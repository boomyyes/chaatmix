// Production: systemd's EnvironmentFile. Dev: load ./.env if present (Node's built-in loader).
// Tests never read the real .env: it holds live secrets and would switch on the Oracle bucket.
if (!process.env.VITEST) {
	try {
		process.loadEnvFile();
	} catch {}
}

export const env = process.env;

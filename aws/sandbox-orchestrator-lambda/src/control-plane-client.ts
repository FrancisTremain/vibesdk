/**
 * Thin HTTP client for one sandbox task's aws/sandbox-controlplane
 * server, authenticated with the shared X-Controlplane-Secret header
 * (see aws/infra/sandbox/main.tf's security-group comment for why
 * that header, not source-IP, is the real authorization boundary for
 * this path).
 */

export interface ControlPlaneResponse<T = unknown> {
	status: number;
	body: T;
}

export class ControlPlaneClient {
	constructor(
		private readonly baseUrl: string,
		private readonly secret: string,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<ControlPlaneResponse<T>> {
		const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
			method,
			headers: {
				'Content-Type': 'application/json',
				'X-Controlplane-Secret': this.secret,
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		const responseBody = (await res.json().catch(() => ({}))) as T;
		return { status: res.status, body: responseBody };
	}

	bootstrap(req: {
		files: { filePath: string; fileContents: string }[];
		projectName: string;
		envVars?: Record<string, string>;
		initCommand?: string;
	}) {
		return this.request('POST', '/bootstrap', req);
	}

	status() {
		return this.request('GET', '/status');
	}

	writeFiles(req: { files: { filePath: string; fileContents: string }[]; commitMessage?: string }) {
		return this.request('POST', '/files', req);
	}

	getFiles(filePaths?: string[]) {
		const qs = filePaths?.length ? `?${filePaths.map((p) => `path=${encodeURIComponent(p)}`).join('&')}` : '';
		return this.request('GET', `/files${qs}`);
	}

	executeCommands(req: { commands: string[]; timeout?: number }) {
		return this.request('POST', '/commands', req);
	}

	getLogs(onlyRecent?: boolean, durationSeconds?: number) {
		const params = new URLSearchParams();
		if (onlyRecent) params.set('onlyRecent', 'true');
		if (durationSeconds !== undefined) params.set('durationSeconds', String(durationSeconds));
		const qs = params.toString();
		return this.request('GET', `/logs${qs ? `?${qs}` : ''}`);
	}

	getErrors(clear?: boolean) {
		return this.request('GET', `/errors${clear ? '?clear=true' : ''}`);
	}

	clearErrors() {
		return this.request('POST', '/errors/clear');
	}

	runStaticAnalysis(lintFiles?: string[]) {
		return this.request('POST', '/analysis', { lintFiles });
	}

	deploy() {
		return this.request('POST', '/deploy');
	}

	shutdown() {
		return this.request('POST', '/shutdown');
	}
}

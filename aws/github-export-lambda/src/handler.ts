/**
 * API Gateway HTTP API (v2) Lambda for GitHub export -- reduced port
 * of worker/api/controllers/githubExporter/controller.ts's
 * `initiateGitHubExport`/`handleOAuthCallback`. Two routes:
 *
 *   POST /api/github/export/initiate  -- signs a short-lived state
 *     token (./state-token.ts) and returns a GitHub OAuth authorize URL.
 *   GET  /api/github/oauth/callback   -- exchanges the code, creates
 *     or reuses the target repository (./github-repo-api.ts), pushes
 *     the session's git history to it (./push.ts), and redirects back
 *     to the caller's `returnUrl` with a success/error query param.
 *
 * Not ported, deliberately (see this package's README for the full
 * list): the cached-token fast path (no per-user token storage exists
 * yet), remote-status diffing (`checkRemoteStatus`), and the README
 * deploy-button rewrite (no Cloudflare deploy target to link to).
 *
 * SECURITY NOTE: the original checks the caller owns the app
 * (`AppService.checkAppOwnership`) before both initiating an export
 * and completing the OAuth callback. This Lambda has no caller-identity
 * verification wired in at all yet -- any caller who knows a
 * `sessionId` can trigger an export of that session's files using
 * their own GitHub OAuth grant. Not safe to expose publicly without
 * adding an ownership/auth check first; see the README.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { GitHubExporterOAuthProvider } from 'vibesdk-oauth-clients';
import { createUserRepository, getRepository } from './github-repo-api';
import { pushSessionToGitHub } from './push';
import { signExportState, verifyExportState } from './state-token';

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} not configured`);
	return value;
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
	return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function errorResponse(message: string, statusCode = 500): APIGatewayProxyResultV2 {
	return jsonResponse(statusCode, { success: false, error: { message } });
}

function redirect(location: string): APIGatewayProxyResultV2 {
	return { statusCode: 302, headers: { Location: location } };
}

function originOf(event: APIGatewayProxyEventV2): string {
	const host = event.headers?.host ?? event.requestContext.domainName;
	return `https://${host}`;
}

function oauthProviderFor(event: APIGatewayProxyEventV2): GitHubExporterOAuthProvider {
	const baseUrl = originOf(event);
	return new GitHubExporterOAuthProvider(
		requireEnv('GITHUB_EXPORTER_CLIENT_ID'),
		requireEnv('GITHUB_EXPORTER_CLIENT_SECRET'),
		`${baseUrl}/api/github/oauth/callback`,
	);
}

async function handleInitiate(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
	let body: { sessionId?: string; repositoryName?: string; description?: string; isPrivate?: boolean; returnUrl?: string };
	try {
		body = JSON.parse(event.body ?? '{}');
	} catch {
		return errorResponse('Invalid JSON body', 400);
	}

	if (!body.sessionId) return errorResponse('sessionId is required', 400);
	if (!body.repositoryName) return errorResponse('repositoryName is required', 400);
	if (!body.returnUrl) return errorResponse('returnUrl is required', 400);

	const state = await signExportState(
		{
			sessionId: body.sessionId,
			repositoryName: body.repositoryName,
			description: body.description,
			isPrivate: body.isPrivate,
			returnUrl: body.returnUrl,
		},
		requireEnv('JWT_SECRET'),
	);

	const authUrl = await oauthProviderFor(event).getAuthorizationUrl(state);
	return jsonResponse(200, { success: true, data: { authUrl } });
}

async function handleCallback(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
	const code = event.queryStringParameters?.code;
	const stateParam = event.queryStringParameters?.state;
	const oauthError = event.queryStringParameters?.error;
	const fallbackReturnUrl = `${originOf(event)}/chat`;

	if (oauthError) return redirect(`${fallbackReturnUrl}?github_export=error&reason=${encodeURIComponent(oauthError)}`);
	if (!code) return redirect(`${fallbackReturnUrl}?github_export=error&reason=missing_code`);
	if (!stateParam) return redirect(`${fallbackReturnUrl}?github_export=error&reason=missing_state`);

	const state = await verifyExportState(stateParam, requireEnv('JWT_SECRET'));
	if (!state) return redirect(`${fallbackReturnUrl}?github_export=error&reason=invalid_state`);

	const returnUrl = state.returnUrl || fallbackReturnUrl;
	const provider = oauthProviderFor(event);

	let accessToken: string;
	try {
		const tokens = await provider.exchangeCodeForTokens(code);
		accessToken = tokens.accessToken;
	} catch {
		return redirect(`${returnUrl}?github_export=error&reason=token_exchange_failed`);
	}

	let username: string;
	try {
		const userInfo = await provider.getUserInfo(accessToken);
		username = userInfo.name ?? userInfo.email.split('@')[0]!;
	} catch {
		return redirect(`${returnUrl}?github_export=error&reason=user_info_failed`);
	}

	const created = await createUserRepository({
		name: state.repositoryName,
		description: state.description,
		private: state.isPrivate ?? false,
		token: accessToken,
	});

	let repositoryUrl: string;
	if (created.success) {
		repositoryUrl = created.repository.html_url;
	} else if (created.alreadyExists && created.repositoryName) {
		const existing = await getRepository({ owner: username, repo: created.repositoryName, token: accessToken });
		if (!existing.success || !existing.repository) {
			return redirect(`${returnUrl}?github_export=error&reason=${encodeURIComponent(created.error)}`);
		}
		repositoryUrl = existing.repository.html_url;
	} else {
		return redirect(`${returnUrl}?github_export=error&reason=${encodeURIComponent(created.error)}`);
	}

	const pushResult = await pushSessionToGitHub(state.sessionId, repositoryUrl, accessToken);
	if (!pushResult.success) {
		return redirect(`${returnUrl}?github_export=error&reason=${encodeURIComponent(pushResult.error ?? 'push_failed')}`);
	}

	return redirect(`${returnUrl}?github_export=success&repository_url=${encodeURIComponent(repositoryUrl)}`);
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
	try {
		switch (event.routeKey) {
			case 'POST /api/github/export/initiate':
				return await handleInitiate(event);
			case 'GET /api/github/oauth/callback':
				return await handleCallback(event);
			default:
				return errorResponse('Not found', 404);
		}
	} catch (err) {
		return errorResponse(err instanceof Error ? err.message : 'Internal server error', 500);
	}
}

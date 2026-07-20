/**
 * Port of the `{ success, data|error, message? }` envelope shape from
 * worker/api/responses.ts, trimmed to what the auth routes actually
 * produce (no rate-limit error details, no usage-limit shape).
 */

import type { APIGatewayProxyResultV2 } from 'aws-lambda';

export function jsonResponse(
	statusCode: number,
	body: unknown,
	options: { cookies?: string[] } = {},
): APIGatewayProxyResultV2 {
	return {
		statusCode,
		headers: { 'Content-Type': 'application/json' },
		cookies: options.cookies,
		body: JSON.stringify(body),
	};
}

export function successResponse(data: unknown, statusCode = 200, cookies?: string[]): APIGatewayProxyResultV2 {
	return jsonResponse(statusCode, { success: true, data }, { cookies });
}

export function errorResponse(message: string, statusCode = 500): APIGatewayProxyResultV2 {
	return jsonResponse(statusCode, { success: false, error: { message } });
}

export function redirectResponse(location: string, cookies?: string[]): APIGatewayProxyResultV2 {
	return {
		statusCode: 302,
		headers: { Location: location },
		cookies,
		body: '',
	};
}

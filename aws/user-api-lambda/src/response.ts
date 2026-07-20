/**
 * Same envelope shape as aws/auth-api-lambda/src/response.ts (ported
 * from worker/api/responses.ts) -- duplicated rather than imported
 * since these are two independent Lambda packages, same reasoning as
 * every other small shared file in this migration (see e.g.
 * fake-dynamo.ts's copies).
 */

import type { APIGatewayProxyResultV2 } from 'aws-lambda';

export function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
	return {
		statusCode,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	};
}

export function successResponse(data: unknown, statusCode = 200): APIGatewayProxyResultV2 {
	return jsonResponse(statusCode, { success: true, data });
}

export function errorResponse(message: string, statusCode = 500): APIGatewayProxyResultV2 {
	return jsonResponse(statusCode, { success: false, error: { message } });
}

/**
 * Same envelope shape as the sibling Lambda packages' response.ts
 * (e.g. aws/user-api-lambda/src/response.ts) -- duplicated rather
 * than imported, same reasoning as every other small shared file in
 * this migration.
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

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

/**
 * POST /api/agent's response shape -- the frontend reads this as a raw
 * NDJSON body (src/utils/ndjson-parser/ndjson-parser.ts, called with
 * skipJsonParsing so it never expects the {success,data} envelope every
 * other route here uses). One line is all the AWS backend has to send
 * (no blueprint-chunk streaming -- see aws/apps-api-lambda's GET
 * /api/capabilities, which already declares the "app" feature's phased/
 * blueprint UX disabled on this backend, only "general" agentic).
 */
export function ndjsonResponse(line: Record<string, unknown>): APIGatewayProxyResultV2 {
	return {
		statusCode: 200,
		headers: { 'Content-Type': 'application/x-ndjson' },
		body: `${JSON.stringify(line)}\n`,
	};
}

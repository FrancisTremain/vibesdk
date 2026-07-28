export interface RecordUsageParams {
	userId: string;
	sessionId: string;
	provider: string;
	model: string;
	tokensIn: number;
	tokensOut: number;
	error: boolean;
}

export interface UsageAnalytics {
	totalRequests: number;
	totalCost: number;
	tokensIn: number;
	tokensOut: number;
	erroredRequests: number;
	errorRate: number;
	lastRequestAt: string | null;
	timeRange: { start: string; end: string; days: number };
}

export interface UserUsageAnalytics extends UsageAnalytics {
	userId: string;
}

export interface SessionUsageAnalytics extends UsageAnalytics {
	sessionId: string;
}

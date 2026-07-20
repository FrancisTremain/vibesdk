/**
 * Field shapes ported from worker/database/schema.ts's audit_logs and
 * system_settings tables.
 */

export interface AuditLog {
	id: string;
	userId: string | null;
	entityType: string;
	entityId: string;
	action: string;
	oldValues: unknown;
	newValues: unknown;
	ipAddress: string | null;
	userAgent: string | null;
	createdAt: number;
}

export type NewAuditLog = Omit<AuditLog, 'id' | 'createdAt'> & Partial<Pick<AuditLog, 'createdAt'>>;

export interface SystemSetting {
	id: string;
	key: string;
	value: unknown;
	description: string | null;
	updatedAt: number;
	updatedBy: string | null;
}

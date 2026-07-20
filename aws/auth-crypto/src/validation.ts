/**
 * Port of `validatePassword` from worker/utils/validationUtils.ts. Pure
 * Zod-schema validation logic, no Cloudflare or AWS dependency -- copied
 * unchanged aside from inlining the `PasswordValidationResult` type
 * (originally worker/types/auth-types.ts, not otherwise part of this
 * package).
 */

import { z } from 'zod';

export interface PasswordValidationResult {
	valid: boolean;
	errors?: string[];
	score: number; // 0-4 strength score
	requirements?: {
		minLength: boolean;
		hasLowercase: boolean;
		hasUppercase: boolean;
		hasNumbers: boolean;
		hasSpecialChars: boolean;
		notCommon: boolean;
		noSequential: boolean;
	};
	suggestions?: string[];
}

const passwordSchema = z
	.string()
	.min(8, 'Password must be at least 8 characters')
	.max(128, 'Password must be less than 128 characters')
	.regex(/[a-z]/, 'Password must contain at least one lowercase letter')
	.regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
	.regex(/[0-9]/, 'Password must contain at least one number');

export function validatePassword(password: string): PasswordValidationResult {
	if (!password || typeof password !== 'string') {
		return {
			valid: false,
			errors: ['Password is required'],
			score: 0,
			requirements: {
				minLength: false,
				hasLowercase: false,
				hasUppercase: false,
				hasNumbers: false,
				hasSpecialChars: false,
				notCommon: false,
				noSequential: false,
			},
		};
	}

	const result = passwordSchema.safeParse(password);

	const requirements = {
		minLength: password.length >= 8,
		hasLowercase: /[a-z]/.test(password),
		hasUppercase: /[A-Z]/.test(password),
		hasNumbers: /[0-9]/.test(password),
		hasSpecialChars: /[^a-zA-Z0-9]/.test(password),
		notCommon: true,
		noSequential: true,
	};

	let score = 0;
	if (requirements.minLength) score++;
	if (requirements.hasLowercase && requirements.hasUppercase) score++;
	if (requirements.hasNumbers) score++;
	if (requirements.hasSpecialChars) score++;
	if (password.length >= 12) score = Math.min(4, score + 1);

	const suggestions: string[] = [];
	if (password.length < 12) {
		suggestions.push('Use at least 12 characters for better security');
	}
	if (!requirements.hasSpecialChars) {
		suggestions.push('Add special characters for enhanced security');
	}

	if (!result.success) {
		return {
			valid: false,
			errors: result.error.issues.map((e) => e.message),
			score,
			requirements,
			suggestions: suggestions.length > 0 ? suggestions : undefined,
		};
	}

	return {
		valid: true,
		score,
		requirements,
		suggestions: suggestions.length > 0 ? suggestions : undefined,
	};
}

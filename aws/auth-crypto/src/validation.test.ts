import { describe, expect, it } from 'vitest';
import { validatePassword } from './validation';

describe('validatePassword', () => {
	it('accepts a password meeting all requirements', () => {
		const result = validatePassword('Abcdefg1');
		expect(result.valid).toBe(true);
		expect(result.errors).toBeUndefined();
	});

	it('rejects an empty password', () => {
		const result = validatePassword('');
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('Password is required');
		expect(result.score).toBe(0);
	});

	it('rejects a password shorter than 8 characters', () => {
		const result = validatePassword('Ab1');
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('Password must be at least 8 characters');
	});

	it('rejects a password longer than 128 characters', () => {
		const result = validatePassword('Ab1' + 'x'.repeat(130));
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('Password must be less than 128 characters');
	});

	it('rejects a password missing a lowercase letter', () => {
		const result = validatePassword('ABCDEFG1');
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('Password must contain at least one lowercase letter');
	});

	it('rejects a password missing an uppercase letter', () => {
		const result = validatePassword('abcdefg1');
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('Password must contain at least one uppercase letter');
	});

	it('rejects a password missing a number', () => {
		const result = validatePassword('Abcdefgh');
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('Password must contain at least one number');
	});

	it('scores a long password with special characters higher', () => {
		const weak = validatePassword('Abcdefg1');
		const strong = validatePassword('Abcdefg1!2345');
		expect(strong.score).toBeGreaterThan(weak.score);
	});

	it('suggests improvements for a minimal valid password', () => {
		const result = validatePassword('Abcdefg1');
		expect(result.suggestions).toContain('Use at least 12 characters for better security');
		expect(result.suggestions).toContain('Add special characters for enhanced security');
	});

	it('gives no suggestions for a long password with special characters', () => {
		const result = validatePassword('Abcdefg1!2345');
		expect(result.suggestions).toBeUndefined();
	});
});

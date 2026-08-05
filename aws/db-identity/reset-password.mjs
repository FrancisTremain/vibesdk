#!/usr/bin/env node
/**
 * One-off manual password reset for the AWS deployment's vibesdk-identity
 * table. Run this yourself -- it prompts locally for the email and new
 * password and never transmits either anywhere except straight to
 * DynamoDB. Matches the exact PBKDF2 scheme in
 * aws/auth-crypto/src/password-crypto.ts (100,000 iterations, SHA-256,
 * 16-byte salt, 32-byte key, base64(salt+hash)) so the result verifies
 * correctly against the real auth-api-lambda login path.
 *
 * Usage:
 *   cd aws/db-identity
 *   npm install   (if node_modules isn't already present)
 *   node reset-password.mjs
 *
 * Requires AWS credentials in the environment (same as any other `aws`
 * CLI command you've been running) with dynamodb:GetItem/UpdateItem on
 * the vibesdk-identity table, and assumes ap-southeast-2 -- change
 * REGION below if your deployment uses a different one.
 *
 * Input is not masked: raw-mode masking behaves inconsistently across
 * PowerShell / Git Bash / cmd.exe on Windows, and this script only ever
 * runs on your own machine in your own terminal -- masking would protect
 * against someone reading over your shoulder, not against Claude, which
 * never sees this input either way (only you run this file,
 * interactively, outside of any tool call).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createInterface } from 'node:readline';
import { webcrypto as crypto } from 'node:crypto';

const REGION = 'ap-southeast-2';
const TABLE_NAME = 'vibesdk-identity';

const SALT_LENGTH = 16;
const ITERATIONS = 100_000;
const KEY_LENGTH = 32;

async function pbkdf2(password, salt) {
	const encoder = new TextEncoder();
	const passwordKey = await crypto.subtle.importKey(
		'raw',
		encoder.encode(password),
		'PBKDF2',
		false,
		['deriveBits'],
	);
	const derivedBits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
		passwordKey,
		KEY_LENGTH * 8,
	);
	return new Uint8Array(derivedBits);
}

async function hashPassword(password) {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
	const hash = await pbkdf2(password, salt);
	const combined = new Uint8Array(salt.length + hash.length);
	combined.set(salt);
	combined.set(hash, salt.length);
	return Buffer.from(combined).toString('base64');
}

function prompt(question) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function main() {
	const email = (await prompt('Account email: ')).trim().toLowerCase();
	if (!email) {
		console.error('Email is required.');
		process.exitCode = 1;
		return;
	}

	const newPassword = await prompt('New password (min 8 characters): ');
	if (!newPassword || newPassword.length < 8) {
		console.error('Password must be at least 8 characters.');
		process.exitCode = 1;
		return;
	}
	const confirmPassword = await prompt('Confirm new password: ');
	if (newPassword !== confirmPassword) {
		console.error('Passwords do not match.');
		process.exitCode = 1;
		return;
	}

	const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

	const lookup = await ddb.send(
		new GetCommand({ TableName: TABLE_NAME, Key: { pk: `EMAIL#${email}`, sk: 'LOOKUP' } }),
	);
	const userId = lookup.Item?.userId;
	if (!userId) {
		console.error(`No account found for ${email}.`);
		process.exitCode = 1;
		return;
	}

	const passwordHash = await hashPassword(newPassword);
	const now = Date.now();

	await ddb.send(
		new UpdateCommand({
			TableName: TABLE_NAME,
			Key: { pk: `USER#${userId}`, sk: 'PROFILE' },
			UpdateExpression: 'SET passwordHash = :hash, passwordChangedAt = :now, updatedAt = :now',
			ExpressionAttributeValues: { ':hash': passwordHash, ':now': now },
		}),
	);

	console.log(`Password updated for ${email}. You can sign in with the new password now.`);
}

main().catch((err) => {
	console.error('Failed:', err.message);
	process.exitCode = 1;
});

import { describe, expect, it } from 'vitest';
import { BootstrapResponseSchema, FileTreeNodeSchema, InstanceCreationRequestSchema } from './types';

describe('ported sandbox schemas', () => {
	it('parses a bootstrap response', () => {
		const parsed = BootstrapResponseSchema.parse({ success: true, previewURL: 'https://preview.example.com' });
		expect(parsed.success).toBe(true);
	});

	it('parses a recursive file tree node', () => {
		const parsed = FileTreeNodeSchema.parse({
			path: '/src',
			type: 'directory',
			children: [{ path: '/src/index.ts', type: 'file' }],
		});
		expect(parsed.children).toHaveLength(1);
	});

	it('defaults initCommand on instance creation requests', () => {
		const parsed = InstanceCreationRequestSchema.parse({ files: [], projectName: 'demo' });
		expect(parsed.initCommand).toBe('bun run dev');
	});
});

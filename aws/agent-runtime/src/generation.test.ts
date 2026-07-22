import { describe, expect, it } from 'vitest';
import { parseGeneratedProject } from './generation';

describe('parseGeneratedProject', () => {
	it('parses a well-formed response', () => {
		const raw = JSON.stringify({
			projectName: 'todo-app',
			initCommand: 'bun run dev',
			files: [
				{ filePath: 'package.json', fileContents: '{}' },
				{ filePath: 'index.html', fileContents: '<h1>todo</h1>' },
			],
		});

		expect(parseGeneratedProject(raw)).toEqual({
			projectName: 'todo-app',
			initCommand: 'bun run dev',
			files: [
				{ filePath: 'package.json', fileContents: '{}' },
				{ filePath: 'index.html', fileContents: '<h1>todo</h1>' },
			],
		});
	});

	it('strips a markdown code fence the model added despite instructions not to', () => {
		const raw = '```json\n' + JSON.stringify({ files: [{ filePath: 'a.txt', fileContents: 'x' }] }) + '\n```';
		const result = parseGeneratedProject(raw);
		expect(result.files).toEqual([{ filePath: 'a.txt', fileContents: 'x' }]);
	});

	it('defaults projectName and initCommand when omitted', () => {
		const raw = JSON.stringify({ files: [{ filePath: 'a.txt', fileContents: 'x' }] });
		const result = parseGeneratedProject(raw);
		expect(result.projectName).toBe('generated-app');
		expect(result.initCommand).toBe('bun run dev');
	});

	it('throws a clear error on invalid JSON', () => {
		expect(() => parseGeneratedProject('not json at all')).toThrow(/did not return valid JSON/);
	});

	it('throws when the response is a JSON value but not an object', () => {
		expect(() => parseGeneratedProject('[1, 2, 3]')).toThrow(/not a JSON object/);
	});

	it('throws when files is missing or empty', () => {
		expect(() => parseGeneratedProject('{}')).toThrow(/no files/);
		expect(() => parseGeneratedProject('{"files": []}')).toThrow(/no files/);
	});

	it('throws when a file entry is missing filePath or fileContents', () => {
		expect(() => parseGeneratedProject(JSON.stringify({ files: [{ fileContents: 'x' }] }))).toThrow(/missing filePath/);
		expect(() => parseGeneratedProject(JSON.stringify({ files: [{ filePath: 'a.txt' }] }))).toThrow(/missing fileContents/);
	});
});

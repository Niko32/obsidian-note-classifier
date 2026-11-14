import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

// Bundle against a small Obsidian API stub so tests exercise the actual plugin modules.
const mock = {
	request: null,
	async requestUrl(options) { return this.request(options); },
	getFrontMatterInfo(source) {
		const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
		return { exists: !!match, frontmatter: match?.[1] ?? '', contentStart: match?.[0].length ?? 0 };
	},
};
globalThis.__obsidianTest = mock;
const plugin = {
	name: 'obsidian-stub',
	setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
		builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
			contents: 'export const requestUrl = (...a) => globalThis.__obsidianTest.requestUrl(...a); export const getFrontMatterInfo = (...a) => globalThis.__obsidianTest.getFrontMatterInfo(...a);',
		}));
	},
};
async function loadModule(path) {
	const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false, plugins: [plugin] });
	return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}
const { createBackend } = await loadModule('src/backends.ts');
const { buildInput, classifyFile } = await loadModule('src/classifier.ts');
const defaults = {
	tags: ['work', 'ideas'], mode: 'one', includeTitle: true, includeFrontmatter: false,
	includeContent: true, backend: 'ollama', ollamaModel: 'tev1', ollamaUrl: 'http://localhost:11434',
	typesafeApiKey: '',
};

function reply(answers) {
	return { status: 200, json: { answers } };
}

test('selected input only, with and without frontmatter', () => {
	const file = { basename: 'Example' };
	const source = '---\ntags: work\naliases: Example\n---\nBody text';
	assert.equal(buildInput(file, source, defaults), 'Title:\nExample\n\nContent:\nBody text');
	assert.equal(buildInput(file, source, { ...defaults, includeTitle: false, includeFrontmatter: true, includeContent: false }),
		'Frontmatter:\ntags: work\naliases: Example');
	assert.equal(buildInput(file, 'Body text', { ...defaults, includeTitle: false }), 'Content:\nBody text');
});

test('exactly one: choice request and validated selection', async () => {
	const backend = createBackend(defaults);
	mock.request = async (options) => {
		assert.equal(options.url, 'http://localhost:11434/v1/systemone');
		const body = JSON.parse(options.body);
		assert.deepEqual(Object.keys(body.questions), ['best']);
		assert.deepEqual(body.questions.best.criteria, { tag_0: 'work', tag_1: 'ideas' });
		return reply({ best: { type: 'choice', choice: 'tag_1' } });
	};
	assert.deepEqual(await backend.classify('note', defaults.tags, 'one'), ['ideas']);
	mock.request = async () => reply({ best: { type: 'choice', choice: 'unknown' } });
	await assert.rejects(backend.classify('note', defaults.tags, 'one'), /valid tag/);
});

test('zero or more uses independent yes/no answers; one or more falls back to choice', async () => {
	const backend = createBackend(defaults);
	mock.request = async (options) => {
		const body = JSON.parse(options.body);
		assert.deepEqual(Object.keys(body.questions), ['match_0', 'match_1']);
		return reply({ match_0: { type: 'noul', noul: 0.2 }, match_1: { type: 'noul', noul: 0.5 } });
	};
	assert.deepEqual(await backend.classify('note', defaults.tags, 'zero-or-more'), ['ideas']);
	mock.request = async () => reply({
		best: { type: 'choice', choice: 'tag_0' },
		match_0: { type: 'noul', noul: 0.1 }, match_1: { type: 'noul', noul: 0.2 },
	});
	assert.deepEqual(await backend.classify('note', defaults.tags, 'one-or-more'), ['work']);
});

test('TypeSafe authentication and errors never write tags', async () => {
	const backend = createBackend({ ...defaults, backend: 'typesafe', typesafeApiKey: 'secret' });
	mock.request = async (options) => {
		assert.equal(options.headers.Authorization, 'Bearer secret');
		assert.equal(options.url, 'https://api.typesafe.ai/v1/systemone');
		return { status: 401 };
	};
	await assert.rejects(backend.classify('note', defaults.tags, 'one'), /HTTP 401/);
});

test('classification preserves unmanaged tags and other frontmatter fields', async () => {
	const frontmatter = { tags: ['#work', 'personal'], aliases: ['test'] };
	const app = {
		vault: { cachedRead: async () => '---\ntags: [work, personal]\n---\nBody' },
		fileManager: { processFrontMatter: async (_file, fn) => fn(frontmatter) },
	};
	const backend = { classify: async () => ['ideas'] };
	assert.deepEqual(await classifyFile(app, { basename: 'Example' }, defaults, backend), ['ideas']);
	assert.deepEqual(frontmatter, { tags: ['personal', 'ideas'], aliases: ['test'] });
	await assert.rejects(classifyFile(app, { basename: 'Example' }, defaults,
		{ classify: async () => ['bad'] }), /outside the configured/);
	assert.deepEqual(frontmatter.tags, ['personal', 'ideas']);
});

test('zero tags do not create empty frontmatter on a plain note', async () => {
	const app = {
		vault: { cachedRead: async () => 'Plain body' },
		fileManager: { processFrontMatter: () => { throw new Error('unexpected write'); } },
	};
	assert.deepEqual(await classifyFile(app, { basename: 'Plain' },
		{ ...defaults, mode: 'zero-or-more' }, { classify: async () => [] }), []);
});

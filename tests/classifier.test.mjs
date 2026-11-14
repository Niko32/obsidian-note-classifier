import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

// Bundle against a small Obsidian API stub so tests exercise the actual plugin modules.
const mock = {
	request: null,
	confirmations: [],
	notices: [],
	autoConfirm: false,
	async requestUrl(options) { return this.request(options); },
	getFrontMatterInfo(source) {
		const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
		return {
			exists: !!match, frontmatter: match?.[1] ?? '', contentStart: match?.[0].length ?? 0,
			from: match ? source.indexOf('\n') + 1 : 0,
			to: match ? match[0].lastIndexOf('---') : 0,
		};
	},
	parseYaml(yaml) {
		// Test double for the frontmatter tag forms used below.
		const match = /^tags:[ \t]*(.*)$/m.exec(yaml);
		if (!match) return {};
		const value = match[1].trim();
		if (value.startsWith('[')) return { tags: value.slice(1, -1).split(',').map((tag) => tag.trim()) };
		if (value) return { tags: value.replace(/^["']|["']$/g, '') };
		const lines = yaml.slice(match.index + match[0].length).split('\n');
		return { tags: lines.filter((line) => /^\s+- /.test(line)).map((line) => line.replace(/^\s+- /, '')) };
	},
};
globalThis.__obsidianTest = mock;
const plugin = {
	name: 'obsidian-stub',
	setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
		builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
			contents: `
				export const requestUrl = (...a) => globalThis.__obsidianTest.requestUrl(...a);
				export const getFrontMatterInfo = (...a) => globalThis.__obsidianTest.getFrontMatterInfo(...a);
				export const parseYaml = (...a) => globalThis.__obsidianTest.parseYaml(...a);
				export class PluginSettingTab {}
				export class ButtonComponent {}
				export class TextAreaComponent {}
				export class Notice {
					constructor(message) { globalThis.__obsidianTest.notices.push(message); }
					setMessage() {}
					hide() {}
				}
				export class Modal {
					constructor() {
						this.contentEl = {
							createEl: (_, { text }) => globalThis.__obsidianTest.confirmations.push(text),
							empty() {},
						};
					}
					setTitle() {}
					open() { this.onOpen(); }
					close() { this.onClose(); }
				}
				export class Setting {
					addButton(callback) {
						const button = {
							setButtonText(text) { this.text = text; return this; },
							setCta() { return this; },
							onClick(fn) {
								if (this.text === 'Classify all' && globalThis.__obsidianTest.autoConfirm) fn();
								return this;
							},
						};
						callback(button);
						return this;
					}
				}
			`,
		}));
	},
};
async function loadModule(path) {
	const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false, plugins: [plugin] });
	return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}
const { createBackend } = await loadModule('src/backends.ts');
const { buildInput, classifyFile, collectUnclassifiedFiles } = await loadModule('src/classifier.ts');
const { ClassificationRunner } = await loadModule('src/commands.ts');
const { parseTags, normalizeTagDefinitions } = await loadModule('src/settings.ts');
const defaults = {
	tags: [{ name: 'work', description: 'Work projects, but not personal tasks' },
		{ name: 'ideas', description: '' }], mode: 'one', includeTitle: true, includeFrontmatter: false,
	includeContent: true, backend: 'ollama', ollamaModel: 'tev1', ollamaUrl: 'http://localhost:11434',
	typesafeApiKey: '',
};

function reply(answers) {
	return { status: 200, json: { answers } };
}

test('tag input trims prefixes, rejects invalid tags, and avoids duplicates', () => {
	assert.deepEqual(parseTags('#work'), ['work']);
	assert.deepEqual(parseTags('work\nideas\nwork'), ['work', 'ideas']);
	assert.throws(() => parseTags('two words'), /Tags cannot contain spaces/);
});

test('older saved tag lists retain their names and gain empty descriptions', () => {
	assert.deepEqual(normalizeTagDefinitions(['work', 'ideas', 'work']), [
		{ name: 'work', description: '' }, { name: 'ideas', description: '' },
	]);
	assert.deepEqual(normalizeTagDefinitions([{ name: 'work', description: 'Professional only' }, 'ideas']), [
		{ name: 'work', description: 'Professional only' }, { name: 'ideas', description: '' },
	]);
});

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
		assert.deepEqual(body.questions.best.criteria, {
			tag_0: 'Tag: work. Guidance on when it applies: Work projects, but not personal tasks',
			tag_1: 'ideas',
		});
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
		assert.match(body.questions.match_0.instructions, /Work projects, but not personal tasks/);
		assert.doesNotMatch(body.questions.match_1.instructions, /Work projects/);
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
		assert.match(JSON.parse(options.body).questions.best.criteria.tag_0, /Work projects, but not personal tasks/);
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

test('collects only untagged files before confirmation and ignores unrelated tags', async () => {
	const files = ['tagged', 'unrelated', 'plain'].map((path) => ({ path, basename: path }));
	const contents = {
		tagged: '---\ntags: [personal, ideas]\n---\nBody',
		unrelated: '---\ntags: [personal, travel]\n---\nBody',
		plain: 'Body',
	};
	const reads = [];
	const app = { vault: {
		getAbstractFileByPath: (path) => files.find((file) => file.path === path),
		cachedRead: async (file) => { reads.push(file.path); return contents[file.path]; },
	} };
	assert.deepEqual(await collectUnclassifiedFiles(app, files, defaults), [files[1], files[2]]);
	assert.deepEqual(reads, ['tagged', 'unrelated', 'plain']);
	assert.deepEqual(await collectUnclassifiedFiles(app, [files[0]], defaults), []);
});

test('batch confirmation counts only eligible notes, and none eligible needs no confirmation', async () => {
	const files = ['tagged', 'other-tags', 'plain'].map((path) => ({ path, basename: path }));
	const contents = {
		tagged: '---\ntags: work\n---\nBody',
		'other-tags': '---\ntags: personal\n---\nBody',
		plain: 'Body',
	};
	const reads = [];
	const writes = [];
	const app = {
		vault: {
			getAbstractFileByPath: (path) => files.find((file) => file.path === path),
			cachedRead: async (file) => { reads.push(file.path); return contents[file.path]; },
		},
		fileManager: { processFrontMatter: async (file, fn) => { writes.push(file.path); fn({ tags: [] }); } },
	};
	mock.confirmations = [];
	mock.notices = [];
	mock.autoConfirm = true;
	let requests = 0;
	mock.request = async () => {
		assert.match(mock.confirmations[0], /Classify 2 Markdown notes/);
		assert.deepEqual(reads.slice(0, 3), files.map((file) => file.path));
		requests++;
		return reply({ best: { type: 'choice', choice: 'tag_0' } });
	};
	const runner = new ClassificationRunner({ app }, () => defaults);
	await runner.run(files, true);
	assert.deepEqual(writes, ['other-tags', 'plain']);
	assert.equal(requests, 2);
	assert.equal(mock.confirmations.length, 1);
	assert.ok(mock.notices.includes('Classified 2 notes.'));
	mock.confirmations = [];
	mock.notices = [];
	await runner.run([files[0]], true);
	assert.deepEqual(mock.confirmations, []);
	assert.ok(mock.notices.includes('No untagged Markdown files to classify.'));
	assert.equal(requests, 2);
});

test('batch skips notes with any configured frontmatter tag without contacting the model or writing', async () => {
	for (const tags of ['tags: work', 'tags: [personal, ideas]', 'tags:\n  - personal\n  - #WORK']) {
		let reads = 0;
		const app = {
			vault: { cachedRead: async () => { reads++; return `---\n${tags}\n---\nBody`; } },
			fileManager: { processFrontMatter: () => { throw new Error('unexpected write'); } },
		};
		const result = await classifyFile(app, { basename: 'Example' }, defaults,
			{ classify: async () => { throw new Error('unexpected model call'); } }, true);
		assert.equal(result, null);
		assert.equal(reads, 1);
	}
});

test('batch classifies notes with only unrelated tags, while current file reclassifies tagged notes', async () => {
	for (const source of ['---\ntags: [personal, travel]\n---\nBody', '---\ntags: personal\n---\nBody', 'Body']) {
		let calls = 0;
		const app = {
			vault: { cachedRead: async () => source },
			fileManager: { processFrontMatter: async (_file, fn) => fn({ tags: ['personal'] }) },
		};
		const result = await classifyFile(app, { basename: 'Example' }, defaults,
			{ classify: async () => { calls++; return ['ideas']; } }, true);
		assert.deepEqual(result, ['ideas']);
		assert.equal(calls, 1);
	}
	const frontmatter = { tags: ['work', 'personal'] };
	const app = {
		vault: { cachedRead: async () => '---\ntags: [work, personal]\n---\nBody' },
		fileManager: { processFrontMatter: async (_file, fn) => fn(frontmatter) },
	};
	assert.deepEqual(await classifyFile(app, { basename: 'Example' }, defaults,
		{ classify: async () => ['ideas'] }), ['ideas']);
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

import { App, ButtonComponent, Notice, PluginSettingTab, Setting, TextAreaComponent } from 'obsidian';
import type NoteClassifierPlugin from './main';

export type TagMode = 'one' | 'zero-or-more' | 'one-or-more';
export type BackendId = 'typesafe' | 'ollama';

export interface TagDefinition {
	name: string;
	description: string;
}

export interface ClassifierSettings {
	tags: TagDefinition[];
	mode: TagMode;
	includeTitle: boolean;
	includeFrontmatter: boolean;
	includeContent: boolean;
	backend: BackendId;
	typesafeApiKey: string;
	ollamaUrl: string;
	ollamaModel: string;
}

export const DEFAULT_SETTINGS: ClassifierSettings = {
	tags: [],
	mode: 'one',
	includeTitle: true,
	includeFrontmatter: false,
	includeContent: true,
	backend: 'ollama',
	typesafeApiKey: '',
	ollamaUrl: 'http://localhost:11434',
	ollamaModel: 'tev1',
};

// Obsidian tags cannot contain whitespace, #, or commas. Accept pasted #tag notation.
export function parseTags(value: string): string[] {
	const tags = value.split(/[\n,]/).map((tag) => tag.trim().replace(/^#/, ''));
	if (tags.some((tag) => tag && /[\s#,{}[\]]/u.test(tag))) {
		throw new Error('Tags cannot contain spaces, #, commas, or brackets.');
	}
	return [...new Set(tags.filter(Boolean))];
}

/** Keep tags from older settings files, which stored only an array of names. */
export function normalizeTagDefinitions(value: unknown): TagDefinition[] {
	if (!Array.isArray(value)) return [];
	const tags: TagDefinition[] = [];
	for (const entry of value as unknown[]) {
		const name = typeof entry === 'string' ? entry :
			entry && typeof entry === 'object' && 'name' in entry ? entry.name : null;
		if (typeof name !== 'string' || !name.trim() || tags.some((tag) => tag.name === name)) continue;
		const description = entry && typeof entry === 'object' && 'description' in entry &&
			typeof entry.description === 'string' ? entry.description : '';
		tags.push({ name, description });
	}
	return tags;
}

export class ClassifierSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: NoteClassifierPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName('Tags').setHeading();

		const tagSetting = new Setting(containerEl)
			.setName('Available tags')
			.setDesc('Add a tag with Enter or the Add button, then optionally describe when it applies.');
		tagSetting.controlEl.addClass('note-classifier-tag-control');
		let input: HTMLInputElement;
		const addTag = async (): Promise<void> => {
			const value = input.value.trim();
			if (!value) return;
			let tag: string;
			try {
				const parsed = parseTags(value);
				if (parsed.length !== 1) throw new Error('Enter one tag at a time.');
				tag = parsed[0]!;
			} catch (error) {
				new Notice(error instanceof Error ? error.message : String(error));
				return;
			}
			if (this.plugin.settings.tags.some((existing) => existing.name === tag)) {
				new Notice('Tag already added.');
				return;
			}
			this.plugin.settings.tags.push({ name: tag, description: '' });
			input.value = '';
			renderTags();
			await this.plugin.saveSettings();
			input.focus();
		};
		tagSetting.addText((text) => {
			input = text.inputEl;
			text.setPlaceholder('Add a tag');
			input.addEventListener('keydown', (event) => {
				if (event.key === 'Enter' && !event.isComposing) {
					event.preventDefault();
					void addTag();
				}
			});
		});
		tagSetting.addButton((button) => button.setButtonText('Add').onClick(() => { void addTag(); }));
		const tagList = tagSetting.controlEl.createDiv({ cls: 'note-classifier-tag-list' });
		const renderTags = (): void => {
			tagList.empty();
			for (const tag of this.plugin.settings.tags) {
				const item = tagList.createDiv({ cls: 'note-classifier-tag' });
				item.createSpan({ cls: 'note-classifier-tag-name', text: tag.name });
				const removeButton = new ButtonComponent(item)
					.setIcon('x')
					.setTooltip(`Remove ${tag.name}`)
					.onClick(async () => {
						this.plugin.settings.tags = this.plugin.settings.tags.filter((existing) => existing !== tag);
						renderTags();
						input.focus();
						await this.plugin.saveSettings();
					});
				removeButton.buttonEl.setAttribute('aria-label', `Remove ${tag.name}`);
				const description = new TextAreaComponent(item)
					.setPlaceholder('When should this tag apply?')
					.setValue(tag.description)
					.onChange(async (value) => {
						tag.description = value;
						await this.plugin.saveSettings();
					});
				description.inputEl.setAttribute('aria-label', `Description for ${tag.name}`);
			}
		};
		renderTags();

		new Setting(containerEl)
			.setName('Tag combination')
			.setDesc('Choose how many of the available tags each note must receive.')
			.addDropdown((dropdown) => dropdown
				.addOption('one', 'Exactly one')
				.addOption('zero-or-more', 'Zero or more')
				.addOption('one-or-more', 'One or more')
				.setValue(this.plugin.settings.mode)
				.onChange(async (value) => {
					this.plugin.settings.mode = value as TagMode;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl).setName('Classification input').setHeading();
		const parts: { key: 'includeTitle' | 'includeFrontmatter' | 'includeContent'; name: string }[] = [
			{ key: 'includeTitle', name: 'File title' },
			{ key: 'includeFrontmatter', name: 'File frontmatter' },
			{ key: 'includeContent', name: 'File content' },
		];
		for (const { key, name } of parts) {
			new Setting(containerEl).setName(name).addToggle((toggle) => toggle
				.setValue(this.plugin.settings[key])
				.onChange(async (value) => {
					this.plugin.settings[key] = value;
					await this.plugin.saveSettings();
				}));
		}

		new Setting(containerEl).setName('Model').setHeading();
		new Setting(containerEl)
			.setName('Backend')
			.setDesc('TypeSafe sends selected note data to an external service. Ollama runs locally.')
			.addDropdown((dropdown) => dropdown
				.addOption('ollama', 'Ollama (local)')
				.addOption('typesafe', 'TypeSafe (Jev)')
				.setValue(this.plugin.settings.backend)
				.onChange(async (value) => {
					this.plugin.settings.backend = value as BackendId;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.backend === 'typesafe') {
			new Setting(containerEl)
				.setName('TypeSafe API key')
				.setDesc('Get a key from console.typesafe.ai. Stored in Obsidian plugin data (not encrypted).')
				.addText((text) => {
					text.inputEl.type = 'password';
					text.setValue(this.plugin.settings.typesafeApiKey).onChange(async (value) => {
						this.plugin.settings.typesafeApiKey = value.trim();
						await this.plugin.saveSettings();
					});
				});
		} else {
			new Setting(containerEl)
				.setName('Ollama URL')
				.setDesc('Local Ollama server. Use the base URL, without /v1/systemone.')
				.addText((text) => text
					.setValue(this.plugin.settings.ollamaUrl)
					.onChange(async (value) => {
						this.plugin.settings.ollamaUrl = value.trim();
						await this.plugin.saveSettings();
					}));
			new Setting(containerEl)
				.setName('Ollama model')
				.setDesc('A decision model supporting /v1/systemone. Run ollama pull tev1 first.')
				.addText((text) => text
					.setValue(this.plugin.settings.ollamaModel)
					.onChange(async (value) => {
						this.plugin.settings.ollamaModel = value.trim();
						await this.plugin.saveSettings();
					}));
		}
	}
}

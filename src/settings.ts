import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type NoteClassifierPlugin from './main';

export type TagMode = 'one' | 'zero-or-more' | 'one-or-more';
export type BackendId = 'typesafe' | 'ollama';

export interface ClassifierSettings {
	tags: string[];
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

export class ClassifierSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: NoteClassifierPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName('Tags').setHeading();

		new Setting(containerEl)
			.setName('Available tags')
			.setDesc('Enter one tag per line (or separate tags with commas). These are the only tags the model can assign.')
			.addTextArea((text) => text
				.setPlaceholder('Projects\nreading\nideas')
				.setValue(this.plugin.settings.tags.join('\n'))
				.onChange(async (value) => {
					try {
						this.plugin.settings.tags = parseTags(value);
						await this.plugin.saveSettings();
					} catch (error) {
						new Notice(String(error));
					}
				}));

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

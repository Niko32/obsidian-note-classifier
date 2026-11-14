import { Notice, Plugin } from 'obsidian';
import { ClassificationRunner } from './commands';
import { ClassifierSettingTab, ClassifierSettings, DEFAULT_SETTINGS, normalizeTagDefinitions } from './settings';

export default class NoteClassifierPlugin extends Plugin {
	settings!: ClassifierSettings;

	async onload(): Promise<void> {
		const saved = await this.loadData() as Partial<ClassifierSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...saved, tags: normalizeTagDefinitions(saved?.tags) };
		this.addSettingTab(new ClassifierSettingTab(this.app, this));
		const runner = new ClassificationRunner(this, () => this.settings);
		this.addCommand({
			id: 'classify-current-file',
			name: 'Classify current file',
			callback: () => {
				if (!this.settings.tags.length) {
					new Notice('Define available tags in the plugin settings first.');
					return;
				}
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'md') {
					new Notice('Open a Markdown file to classify it.');
					return;
				}
				void runner.run([file]);
			},
		});
		this.addCommand({
			id: 'classify-all-files',
			name: 'Classify all files',
			callback: () => { void runner.run(this.app.vault.getMarkdownFiles(), true); },
		});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

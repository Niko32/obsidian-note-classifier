import { Modal, Notice, Plugin, Setting, TFile } from 'obsidian';
import { createBackend } from './backends';
import { classifyFile, collectUnclassifiedFiles } from './classifier';
import type { ClassifierSettings } from './settings';

/** Runs one classification at a time, including the optional batch confirmation. */
export class ClassificationRunner {
	private busy = false;
	constructor(private plugin: Plugin, private getSettings: () => ClassifierSettings) {}

	async run(files: TFile[], confirmAll = false): Promise<void> {
		if (this.busy) {
			new Notice('Classification is already running.');
			return;
		}
		const current = this.getSettings();
		if (!current.tags.length) {
			new Notice('Define available tags in the plugin settings first.');
			return;
		}
		if (current.mode !== 'zero-or-more' && current.tags.length > 255) {
			new Notice('Use at most 255 available tags for this tag combination.');
			return;
		}
		if (!current.includeTitle && !current.includeFrontmatter && !current.includeContent) {
			new Notice('Select at least one classification input in the plugin settings.');
			return;
		}
		if (!files.length) {
			new Notice('No Markdown files to classify.');
			return;
		}
		const settings: ClassifierSettings = { ...current, tags: current.tags.map((tag) => ({ ...tag })) };
		try {
			this.busy = true;
			let eligible = files;
			if (confirmAll) {
				const scanning = new Notice('Finding notes without configured tags…', 0);
				try {
					eligible = await collectUnclassifiedFiles(this.plugin.app, files, settings);
				} finally {
					scanning.hide();
				}
				if (!eligible.length) {
					new Notice('No untagged Markdown files to classify.');
					return;
				}
			}
			const backend = createBackend(settings);
			if (confirmAll && !await confirmBatch(this.plugin, eligible.length, settings.backend)) return;
			const progress = new Notice(`Classifying 0/${eligible.length} notes…`, 0);
			let done = 0;
			let skipped = 0;
			let checked = 0;
			try {
				for (const file of eligible) {
					// A file may have been deleted during a long batch.
					if (this.plugin.app.vault.getAbstractFileByPath(file.path) !== file) continue;
					const result = await classifyFile(this.plugin.app, file, settings, backend, confirmAll);
					if (result === null) skipped++;
					else done++;
					checked++;
					progress.setMessage(`Classifying ${checked}/${eligible.length} notes…`);
				}
				new Notice(`Classified ${done} ${done === 1 ? 'note' : 'notes'}.${skipped ? ` Skipped ${skipped} no longer eligible.` : ''}`);
			} catch (error) {
				new Notice(`Stopped after ${done} notes: ${error instanceof Error ? error.message : String(error)}`, 10000);
			} finally {
				progress.hide();
			}
		} catch (error) {
			new Notice(error instanceof Error ? error.message : String(error));
		} finally {
			this.busy = false;
		}
	}
}

function confirmBatch(plugin: Plugin, count: number, backend: string): Promise<boolean> {
	return new Promise((resolve) => {
		class ConfirmModal extends Modal {
			private accepted = false;
			onOpen(): void {
				this.setTitle('Classify all files?');
				this.contentEl.createEl('p', {
					text: `Classify ${count} Markdown ${count === 1 ? 'note' : 'notes'} with ${backend === 'typesafe' ? 'TypeSafe (sends selected note data to TypeSafe)' : 'Ollama'}?`,
				});
				new Setting(this.contentEl)
					.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
					.addButton((button) => button.setButtonText('Classify all').setCta().onClick(() => {
						this.accepted = true;
						this.close();
					}));
			}
			onClose(): void {
				this.contentEl.empty();
				resolve(this.accepted);
			}
		}
		new ConfirmModal(plugin.app).open();
	});
}

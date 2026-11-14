import { Modal, Notice, Plugin, Setting, TFile } from 'obsidian';
import { createBackend } from './backends';
import { classifyFile } from './classifier';
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
			const backend = createBackend(settings);
			this.busy = true;
			if (confirmAll && !await confirmBatch(this.plugin, files.length, settings.backend)) return;
			const progress = new Notice(`Checking 0/${files.length} notes…`, 0);
			let done = 0;
			let skipped = 0;
			let checked = 0;
			try {
				for (const file of files) {
					// A file may have been deleted during a long batch.
					if (this.plugin.app.vault.getAbstractFileByPath(file.path) !== file) continue;
					const result = await classifyFile(this.plugin.app, file, settings, backend, confirmAll);
					if (result === null) skipped++;
					else done++;
					checked++;
					progress.setMessage(`Checked ${checked}/${files.length} notes…`);
				}
				new Notice(`Classified ${done} ${done === 1 ? 'note' : 'notes'}.${confirmAll ? ` Skipped ${skipped} already tagged.` : ''}`);
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
					text: `Check ${count} Markdown notes and classify those without a configured frontmatter tag using ${backend === 'typesafe' ? 'TypeSafe (sends selected note data to TypeSafe)' : 'Ollama'}. Other tags will not prevent classification.`,
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

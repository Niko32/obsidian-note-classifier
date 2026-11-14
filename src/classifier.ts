import { App, getFrontMatterInfo, TFile } from 'obsidian';
import type { ClassificationBackend } from './backends';
import type { ClassifierSettings } from './settings';

export function buildInput(file: TFile, source: string, settings: ClassifierSettings): string {
	const info = getFrontMatterInfo(source);
	const parts: string[] = [];
	if (settings.includeTitle) parts.push(`Title:\n${file.basename}`);
	if (settings.includeFrontmatter && info.exists) parts.push(`Frontmatter:\n${info.frontmatter}`);
	if (settings.includeContent) {
		parts.push(`Content:\n${source.slice(info.contentStart)}`);
	}
	return parts.join('\n\n');
}

function existingTags(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((tag): tag is string => typeof tag === 'string');
	if (typeof value === 'string') return value.split(',').map((tag) => tag.trim()).filter(Boolean);
	return [];
}

/** Classify a note and change only managed tags, keeping unrelated frontmatter tags. */
export async function classifyFile(app: App, file: TFile, settings: ClassifierSettings,
	backend: ClassificationBackend): Promise<string[]> {
	const source = await app.vault.cachedRead(file);
	const input = buildInput(file, source, settings);
	if (!input.trim()) throw new Error(`No selected input available for ${file.path}.`);
	const selected = await backend.classify(input, settings.tags, settings.mode);
	const allowed = new Set(settings.tags);
	if (selected.some((tag) => !allowed.has(tag)) ||
		(settings.mode === 'one' && selected.length !== 1) ||
		(settings.mode === 'one-or-more' && selected.length === 0)) {
		throw new Error('Model returned tags outside the configured tag combination.');
	}
	// Zero tags on a note without frontmatter needs no write or empty YAML block.
	if (!selected.length && !getFrontMatterInfo(source).exists) return selected;
	await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
		const otherTags = existingTags(frontmatter.tags).filter((tag) =>
			!allowed.has(tag.replace(/^#/, '')));
		const updated = [...new Set([...otherTags, ...selected])];
		if (updated.length) frontmatter.tags = updated;
		else delete frontmatter.tags;
	});
	return selected;
}

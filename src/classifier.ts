import { App, getFrontMatterInfo, parseYaml, TFile } from 'obsidian';
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

/** Only frontmatter tags from the configured list make a note ineligible for batch classification. */
export function hasConfiguredTag(source: string, allowed: Set<string>): boolean {
	const info = getFrontMatterInfo(source);
	if (!info.exists) return false;
	const frontmatter: unknown = parseYaml(source.slice(info.from, info.to));
	if (!frontmatter || typeof frontmatter !== 'object' || !('tags' in frontmatter)) return false;
	const names = new Set([...allowed].map((tag) => tag.toLowerCase()));
	return existingTags(frontmatter.tags).some((tag) => names.has(tag.trim().replace(/^#/, '').toLowerCase()));
}

/** Find eligible batch files before asking for confirmation; read only, no model requests. */
export async function collectUnclassifiedFiles(app: App, files: TFile[], settings: ClassifierSettings): Promise<TFile[]> {
	const allowed = new Set(settings.tags.map((tag) => tag.name));
	const eligible: TFile[] = [];
	for (const file of files) {
		if (app.vault.getAbstractFileByPath(file.path) !== file) continue;
		const source = await app.vault.cachedRead(file);
		if (!hasConfiguredTag(source, allowed)) eligible.push(file);
	}
	return eligible;
}

/** Classify a note and change only managed tags, keeping unrelated frontmatter tags.
 * Returns null when batch mode skips a note already bearing a configured tag. */
export async function classifyFile(app: App, file: TFile, settings: ClassifierSettings,
	backend: ClassificationBackend, skipIfTagged = false): Promise<string[] | null> {
	const source = await app.vault.cachedRead(file);
	const allowed = new Set(settings.tags.map((tag) => tag.name));
	if (skipIfTagged && hasConfiguredTag(source, allowed)) return null;
	const input = buildInput(file, source, settings);
	if (!input.trim()) throw new Error(`No selected input available for ${file.path}.`);
	const selected = await backend.classify(input, settings.tags, settings.mode);
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

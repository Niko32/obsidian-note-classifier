import { requestUrl } from 'obsidian';
import type { ClassifierSettings, TagMode } from './settings';

/** A backend takes selected note data and returns only configured tags. */
export interface ClassificationBackend {
	classify(input: string, tags: string[], mode: TagMode): Promise<string[]>;
}

type Question = {
	type: 'choice' | 'noul';
	instructions: string;
	criteria?: Record<string, string>;
};
type Answer = { type: string; choice?: unknown; noul?: unknown };

// Both Jev and Ollama decision models implement the System One protocol.
class SystemOneBackend implements ClassificationBackend {
	constructor(private url: string, private model: string, private apiKey?: string) {}

	async classify(input: string, tags: string[], mode: TagMode): Promise<string[]> {
		const questions: Record<string, Question> = {};
		const criteria: Record<string, string> = {};
		tags.forEach((tag, index) => { criteria[`tag_${index}`] = tag; });
		if (mode !== 'zero-or-more') {
			questions.best = {
				type: 'choice',
				instructions: 'Which one of these note tags best describes the state? Select the most relevant tag.',
				criteria,
			};
		}
		if (mode !== 'one') {
			tags.forEach((tag, index) => {
				questions[`match_${index}`] = {
					type: 'noul',
					instructions: `Is the note meaningfully about ${JSON.stringify(tag)} and should it receive this tag?`,
					criteria: {
						true: `The note should be tagged ${tag}.`,
						false: `The note should not be tagged ${tag}.`,
					},
				};
			});
		}

		const response = await requestUrl({
			url: this.url,
			method: 'POST',
			contentType: 'application/json',
			body: JSON.stringify({ model: this.model, state: input, questions }),
			headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
			throw: false,
		});
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Model request failed (HTTP ${response.status}). Check the model, server, and credentials.`);
		}
		const data: unknown = response.json;
		if (!isRecord(data) || !isRecord(data.answers)) {
			throw new Error('Model returned an invalid response.');
		}
		const answers = data.answers;
		let best: string | undefined;
		if (mode !== 'zero-or-more') {
			const answer = answers.best as Answer | undefined;
			if (answer?.type !== 'choice' || typeof answer.choice !== 'string' ||
				!Object.prototype.hasOwnProperty.call(criteria, answer.choice)) {
				throw new Error('Model did not select a valid tag.');
			}
			best = criteria[answer.choice];
		}
		if (mode === 'one') return best ? [best] : [];

		const selected: string[] = [];
		for (let index = 0; index < tags.length; index++) {
			const answer = answers[`match_${index}`] as Answer | undefined;
			if (answer?.type !== 'noul' || typeof answer.noul !== 'number' ||
				!Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
				throw new Error('Model did not return valid tag decisions.');
			}
			if (answer.noul >= 0.5) selected.push(tags[index]!);
		}
		// The choice guarantees at least one tag even when all yes/no scores are low.
		if (mode === 'one-or-more' && selected.length === 0 && best) selected.push(best);
		return selected;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createBackend(settings: ClassifierSettings): ClassificationBackend {
	if (settings.backend === 'typesafe') {
		if (!settings.typesafeApiKey.trim()) throw new Error('Add a TypeSafe API key in Note classifier settings.');
		return new SystemOneBackend('https://api.typesafe.ai/v1/systemone', 'jev-latest', settings.typesafeApiKey.trim());
	}
	if (!settings.ollamaModel.trim()) throw new Error('Set an Ollama model in Note classifier settings.');
	let url: URL;
	try {
		url = new URL(settings.ollamaUrl);
	} catch {
		throw new Error('Set a valid Ollama URL in Note classifier settings.');
	}
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new Error('Ollama URL must be an HTTP(S) base URL without credentials or query parameters.');
	}
	return new SystemOneBackend(`${url.href.replace(/\/$/, '')}/v1/systemone`, settings.ollamaModel.trim());
}

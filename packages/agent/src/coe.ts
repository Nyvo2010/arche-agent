/**
 * Context Optimization Engine (COE) — per-request safety net.
 *
 * Runs inside `transformContext` (after SCE) and keeps a single LLM request
 * within budget by trimming history. Composes with session compaction
 * (`harness/compaction`): COE trims within a request, compaction rewrites
 * history across turns.
 *
 * Pipeline (re-measures after each step, stops when under budget):
 *  1. Query-aware extractive compression of oversized tool results
 *     (relevant lines kept, head/tail fill, omission marker).
 *  2. Drop least-relevant droppable groups first until under budget
 *     (relevance = term overlap with the latest user message; ties → oldest).
 *
 * COE never rewrites history with placeholder text and never deletes single
 * messages: compression shortens oversized results in place, drops remove
 * whole groups. Identical repeated results need no special step — they score
 * identically, so the oldest copy is evicted first.
 *
 * "Query" = the latest user message; terms are split like the SCE spec
 * (camelCase/snake_case/kebab-case, lowercase, stopwords dropped, deduped).
 * Everything is deterministic: no LLM calls, no extra dependencies.
 *
 * Invariants:
 * - Never splits a `toolCall` from its `toolResult`.
 * - Never drops the last N messages (reserved tail, default 2).
 * - Never drops compaction/branch summaries (they hold the compacted past).
 * - No-op: returns messages unchanged when already under budget.
 * - Never throws: the `transformContext` wrapper falls back to the input.
 */

import { estimateTokens } from "./harness/compaction/compaction.ts";
import type { AgentMessage } from "./types.ts";

/** Default fraction of the model context window available per request. */
export const DEFAULT_COE_BUDGET_RATIO = 0.7;
/** Default per-tool-result cap in tokens. */
export const DEFAULT_TOOL_RESULT_CAP_TOKENS = 2000;
/** Default number of trailing messages that are always kept. */
export const DEFAULT_RESERVED_TAIL_MESSAGES = 2;

/**
 * Scale the reserved tail with the budget: ~1 message per 20k tokens,
 * clamped to [2, 8]. Small budgets keep the minimum (every message counts
 * toward the floor); large budgets keep more of the recent thread.
 */
export function resolveReservedTailMessages(maxContextTokens: number): number {
	if (!Number.isFinite(maxContextTokens) || maxContextTokens <= 0) return DEFAULT_RESERVED_TAIL_MESSAGES;
	return Math.min(8, Math.max(2, Math.floor(maxContextTokens / 20_000)));
}

const CHARS_PER_TOKEN = 4;

/**
 * Prefix of the SCE workspace slice. Such groups are never dropped: the slice
 * is small (its own token budget) and evicting it would discard the turn's
 * workspace grounding. Must equal SCE_SLICE_MARKER in `./sce.ts` (kept as a
 * literal here to avoid a module cycle; pinned by `sce.test.ts`).
 */
const SCE_SLICE_PREFIX = "<workspace-context>";

export interface CoeOptions {
	/** Absolute token budget. Defaults to `0.7 * contextWindow` (see `resolveMaxContextTokens`). */
	maxContextTokens?: number;
	/** Per-tool-result cap in tokens. Defaults to 2000. */
	toolResultCapTokens?: number;
	/** Trailing messages always kept. Defaults to 2. */
	reservedTailMessages?: number;
}

/** Request-level context COE accounts for alongside history. */
export interface CoeSnapshot {
	systemPrompt?: string;
	/** Tool schemas, counted toward the budget (only JSON-stringified). */
	tools?: unknown[];
}

/** Outcome of one `optimizeMessagesForBudget` run. */
export interface CoeResult {
	messages: AgentMessage[];
	tokensBefore: number;
	tokensAfter: number;
	maxContextTokens: number;
	truncatedToolResults: number;
	droppedMessages: number;
	/** Query terms used for relevance ranking/compression (latest user message). */
	queryTerms: string[];
}

/** Resolve the per-request budget: explicit override wins, else 70% of the window. */
export function resolveMaxContextTokens(contextWindow: number, override?: number): number {
	if (override !== undefined && Number.isFinite(override) && override > 0) {
		return Math.floor(override);
	}
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
	return Math.floor(contextWindow * DEFAULT_COE_BUDGET_RATIO);
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

/** Token estimate for the fixed per-request overhead: system prompt + tool schemas. */
function estimateSnapshotTokens(snapshot: CoeSnapshot): number {
	let tokens = 0;
	if (snapshot.systemPrompt) {
		tokens += Math.ceil(snapshot.systemPrompt.length / CHARS_PER_TOKEN);
	}
	if (snapshot.tools && snapshot.tools.length > 0) {
		tokens += Math.ceil(safeJsonStringify(snapshot.tools).length / CHARS_PER_TOKEN);
	}
	return tokens;
}

/** Token estimate for one request: system prompt + tool schemas + history. */
export function estimateRequestTokens(messages: AgentMessage[], snapshot: CoeSnapshot): number {
	let tokens = estimateSnapshotTokens(snapshot);
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

const STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"but",
	"by",
	"can",
	"did",
	"do",
	"does",
	"for",
	"from",
	"has",
	"have",
	"how",
	"in",
	"is",
	"it",
	"not",
	"of",
	"on",
	"or",
	"please",
	"show",
	"tell",
	"that",
	"the",
	"this",
	"to",
	"was",
	"what",
	"when",
	"where",
	"which",
	"will",
	"with",
	"you",
]);

/**
 * Split text into search terms (same recipe as the SCE query builder):
 * camelCase/snake_case/kebab-case split, lowercase, stopwords dropped, deduped.
 * Split identifiers also emit their joined compound (`getUserName` → `get`,
 * `user`, `name`, `getusername`): matching is substring-based, so the compound
 * hits the literal identifier in code that the parts alone only approximate.
 */
export function extractQueryTerms(text: string): string[] {
	const terms: string[] = [];
	const seen = new Set<string>();
	const push = (term: string): void => {
		if (term.length < 2 || STOPWORDS.has(term) || seen.has(term)) return;
		seen.add(term);
		terms.push(term);
	};
	for (const token of text.split(/[^A-Za-z0-9]+/)) {
		if (token.length === 0) continue;
		const parts = token.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ");
		for (const part of parts) push(part.toLowerCase());
		if (parts.length > 1) push(parts.join("").toLowerCase());
	}
	return terms;
}

/** Searchable text of one message: user/assistant text, tool names + args,
 * results, bash executions, custom content, and summaries. Anything reaching
 * the LLM via `convertToLlm` is scorable here; otherwise relevant context
 * (e.g. `!` command output) would always rank 0 and be evicted first.
 * Shared with SCE query building (`./sce.ts`). */
export function messageText(message: AgentMessage): string {
	switch (message.role) {
		case "user":
			return typeof message.content === "string"
				? message.content
				: message.content
						.filter((b) => b.type === "text")
						.map((b) => b.text)
						.join("\n");
		case "assistant":
			return message.content
				.map((b) => {
					if (b.type === "text") return b.text;
					if (b.type === "thinking") return b.thinking;
					return `${b.name} ${safeJsonStringify(b.arguments)}`;
				})
				.join("\n");
		case "toolResult":
			return message.content
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n");
		case "bashExecution":
			return `${message.command}\n${message.output}`;
		case "custom":
			return typeof message.content === "string"
				? message.content
				: message.content
						.filter((b) => b.type === "text")
						.map((b) => b.text)
						.join("\n");
		case "branchSummary":
		case "compactionSummary":
			return message.summary;
		default:
			return "";
	}
}

/** Latest user message text, or "" when there is none. Shared with SCE. */
export function latestUserText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") return messageText(messages[i]);
	}
	return "";
}

/** Relevance of a haystack: total occurrences of any query term (case-insensitive). */
function scoreText(haystack: string, terms: string[]): number {
	if (terms.length === 0) return 0;
	const lower = haystack.toLowerCase();
	let score = 0;
	for (const term of terms) {
		score += lower.split(term).length - 1;
	}
	return score;
}

function toolResultText(message: AgentMessage): string | undefined {
	if (message.role !== "toolResult") return undefined;
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			parts.push(block.text);
		}
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function toolResultHasImages(message: AgentMessage): boolean {
	if (message.role !== "toolResult") return false;
	return message.content.some((block) => block.type === "image");
}

/** Collapse consecutive duplicate lines (log folding); returns lines. */
function collapseRepeatedLines(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		if (out.length > 0 && out[out.length - 1] === line) continue;
		out.push(line);
	}
	return out;
}

/**
 * Failure signals win first: error/assert lines are what debugging turns need
 * most, regardless of the current query terms.
 */
const ERROR_LINE = /error|fail|exception|assert|panic|traceback|expected|✗|×/i;

/**
 * Query-aware extractive compression: keep failure-signal lines first, then
 * lines matching the query terms (in original order), fill leftover room
 * head-first, and mark what was omitted. Single-line blobs keep a char
 * head+tail split.
 */
export function compressToolResultText(text: string, capTokens: number, terms: string[] = []): string {
	const capChars = Math.max(1, Math.floor(capTokens * CHARS_PER_TOKEN));
	const lines = collapseRepeatedLines(text);
	const collapsed = lines.join("\n");
	if (collapsed.length <= capChars) return collapsed;

	// Single long line: char-level head + tail split.
	if (lines.length === 1) {
		const headChars = Math.ceil(capChars / 2);
		const tailChars = Math.floor(capChars / 2);
		const omitted = collapsed.length - headChars - tailChars;
		return `${collapsed.slice(0, headChars)}\n…[compressed by COE: ${omitted} chars omitted]…\n${collapsed.slice(collapsed.length - tailChars)}`;
	}

	const lowerTerms = terms.map((t) => t.toLowerCase()).filter((t) => t.length > 0);
	const matches = (line: string): boolean =>
		lowerTerms.length > 0 && lowerTerms.some((term) => line.toLowerCase().includes(term));

	const kept = new Map<number, string>();
	let used = 0;
	const take = (index: number): void => {
		if (kept.has(index)) return;
		const room = capChars - used;
		if (room <= 0) return;
		const line = lines[index];
		kept.set(index, line.length <= room ? line : line.slice(0, room));
		used += Math.min(line.length, room) + 1;
	};

	for (let i = 0; i < lines.length; i++) {
		if (ERROR_LINE.test(lines[i])) take(i);
	}
	for (let i = 0; i < lines.length; i++) {
		if (matches(lines[i])) take(i);
	}
	// Head-first fill: visit every line in order until the cap is reached.
	for (let i = 0; i < lines.length && used < capChars; i++) take(i);

	const ordered = [...kept.keys()].sort((a, b) => a - b).map((i) => kept.get(i) as string);
	const omitted = lines.length - kept.size;
	return `${ordered.join("\n")}\n…[compressed by COE: ${omitted} of ${lines.length} lines omitted]…`;
}

function truncateToolResults(
	messages: AgentMessage[],
	capTokens: number,
	queryTerms: string[],
): { messages: AgentMessage[]; truncated: number } {
	const capChars = Math.max(1, Math.floor(capTokens * CHARS_PER_TOKEN));
	let truncated = 0;
	const next = messages.slice();
	for (let i = 0; i < next.length; i++) {
		const message = next[i];
		if (message.role !== "toolResult" || toolResultHasImages(message)) continue;
		const text = toolResultText(message);
		if (text === undefined || text.length <= capChars) continue;
		next[i] = {
			...message,
			content: [{ type: "text", text: compressToolResultText(text, capTokens, queryTerms) }],
		};
		truncated++;
	}
	return { messages: truncated === 0 ? messages : next, truncated };
}

/**
 * Partition messages into droppable groups. An assistant message and the
 * tool results that immediately follow it form one group (never split).
 * Anything else (user message, lone tool result) is its own group.
 */
function buildGroups(messages: AgentMessage[]): Array<{ start: number; end: number }> {
	const groups: Array<{ start: number; end: number }> = [];
	let i = 0;
	while (i < messages.length) {
		const message = messages[i];
		if (message.role === "assistant") {
			let end = i;
			while (end + 1 < messages.length && messages[end + 1].role === "toolResult") {
				end++;
			}
			groups.push({ start: i, end });
			i = end + 1;
		} else {
			groups.push({ start: i, end: i });
			i++;
		}
	}
	return groups;
}

/**
 * Step 2: drop droppable groups until under budget, least relevant first.
 * Relevance = query-term overlap; ties break oldest-first. Groups intersecting
 * the reserved tail are never dropped; protection expands backwards so a
 * toolResult in the tail keeps its assistant. Compaction/branch summaries are
 * never dropped either: they hold the compacted past, so evicting one would
 * discard more context than any other single drop.
 */
function dropLeastRelevantGroups(
	messages: AgentMessage[],
	snapshot: CoeSnapshot,
	maxContextTokens: number,
	reservedTailMessages: number,
	queryTerms: string[],
): { messages: AgentMessage[]; dropped: number } {
	if (messages.length === 0) return { messages, dropped: 0 };
	const reserved = Math.max(0, Math.min(reservedTailMessages, messages.length));
	let protectedStart = messages.length - reserved;
	// Expand backwards by one: a toolResult at the protection boundary keeps
	// its assistant. Group granularity keeps larger assistant+result spans
	// together even when only the last result overlaps the tail.
	if (
		protectedStart > 0 &&
		messages[protectedStart].role === "toolResult" &&
		messages[protectedStart - 1].role === "assistant"
	) {
		protectedStart--;
	}

	const groups = buildGroups(messages);
	// SCE slice lines, computed once: the slice grounds the turn and is
	// never evicted to make room for history.
	const sceProtected = new Set<number>();
	for (let i = 0; i < protectedStart; i++) {
		if (messageText(messages[i]).startsWith(SCE_SLICE_PREFIX)) sceProtected.add(i);
	}
	const droppable = groups
		.filter((group) => group.end < protectedStart)
		.filter((group) => {
			for (let i = group.start; i <= group.end; i++) {
				const role = messages[i].role;
				if (role === "branchSummary" || role === "compactionSummary") return false;
				if (sceProtected.has(i)) return false;
			}
			return true;
		})
		.map((group) => ({
			...group,
			score: scoreText(
				messages
					.slice(group.start, group.end + 1)
					.map((m) => messageText(m))
					.join("\n"),
				queryTerms,
			),
		}))
		.sort((a, b) => a.score - b.score || a.start - b.start);
	if (droppable.length === 0) return { messages, dropped: 0 };

	// Token math is purely additive (per-message ceils + fixed snapshot
	// overhead), so track the running total by subtraction instead of
	// re-estimating the whole request after every drop. Identical numbers,
	// O(history) total instead of O(groups x history).
	const messageCosts = messages.map((message) => estimateTokens(message));
	let remaining = estimateSnapshotTokens(snapshot);
	for (const cost of messageCosts) remaining += cost;

	const removed = new Set<number>();
	let dropped = 0;
	for (const group of droppable) {
		for (let i = group.start; i <= group.end; i++) {
			if (!removed.has(i)) {
				removed.add(i);
				remaining -= messageCosts[i];
			}
		}
		dropped += group.end - group.start + 1;
		if (remaining <= maxContextTokens) break;
	}
	return { messages: messages.filter((_, index) => !removed.has(index)), dropped };
}

/** Run the full COE pipeline over a message list. Pure: never mutates the input. */
export function optimizeMessagesForBudget(
	messages: AgentMessage[],
	snapshot: CoeSnapshot,
	options: CoeOptions,
): CoeResult {
	const capTokens =
		options.toolResultCapTokens !== undefined &&
		Number.isFinite(options.toolResultCapTokens) &&
		(options.toolResultCapTokens as number) > 0
			? Math.floor(options.toolResultCapTokens as number)
			: DEFAULT_TOOL_RESULT_CAP_TOKENS;
	const reserved =
		options.reservedTailMessages !== undefined && Number.isFinite(options.reservedTailMessages)
			? Math.max(0, Math.floor(options.reservedTailMessages as number))
			: DEFAULT_RESERVED_TAIL_MESSAGES;
	const maxContextTokens = Math.max(0, Math.floor(options.maxContextTokens ?? 0));

	const tokensBefore = estimateRequestTokens(messages, snapshot);
	const queryTerms = extractQueryTerms(latestUserText(messages));
	if (maxContextTokens <= 0 || tokensBefore <= maxContextTokens) {
		return {
			messages,
			tokensBefore,
			tokensAfter: tokensBefore,
			maxContextTokens,
			truncatedToolResults: 0,
			droppedMessages: 0,
			queryTerms,
		};
	}

	const truncated = truncateToolResults(messages, capTokens, queryTerms);
	let current = truncated.messages;
	if (estimateRequestTokens(current, snapshot) <= maxContextTokens) {
		const tokensAfter = estimateRequestTokens(current, snapshot);
		return {
			messages: current,
			tokensBefore,
			tokensAfter,
			maxContextTokens,
			truncatedToolResults: truncated.truncated,
			droppedMessages: 0,
			queryTerms,
		};
	}

	const dropped = dropLeastRelevantGroups(current, snapshot, maxContextTokens, reserved, queryTerms);
	current = dropped.messages;
	return {
		messages: current,
		tokensBefore,
		tokensAfter: estimateRequestTokens(current, snapshot),
		maxContextTokens,
		truncatedToolResults: truncated.truncated,
		droppedMessages: dropped.dropped,
		queryTerms,
	};
}

export interface CoeTransformArgs extends CoeOptions {
	/** Model providing `contextWindow` for the default budget. */
	model: { contextWindow: number };
	/** Request-level context COE accounts for. Called fresh on every turn. */
	getSnapshot?: () => CoeSnapshot;
}

/**
 * Build a `transformContext` hook wiring COE into the agent loop.
 * Runs after SCE in the same `transformContext` step. Never throws:
 * on any error the input messages are returned unchanged.
 */
export function createCoeTransform(
	args: CoeTransformArgs,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
	return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
		try {
			const snapshot = args.getSnapshot?.() ?? {};
			const maxContextTokens = resolveMaxContextTokens(args.model.contextWindow, args.maxContextTokens);
			const result = optimizeMessagesForBudget(messages, snapshot, {
				maxContextTokens,
				toolResultCapTokens: args.toolResultCapTokens,
				reservedTailMessages: args.reservedTailMessages ?? resolveReservedTailMessages(maxContextTokens),
			});
			return result.messages;
		} catch {
			return messages;
		}
	};
}

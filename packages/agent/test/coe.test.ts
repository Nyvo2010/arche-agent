import type { AssistantMessage, Message, Model, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { type AssistantMessageEvent, EventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import {
	type CoeSnapshot,
	compressToolResultText,
	createCoeTransform,
	estimateRequestTokens,
	extractQueryTerms,
	optimizeMessagesForBudget,
	resolveMaxContextTokens,
	resolveReservedTailMessages,
} from "../src/coe.ts";
import type { BashExecutionMessage } from "../src/harness/messages.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "../src/types.ts";

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function toolResult(id: string, name: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

/** Every toolResult must keep its assistant; every assistant toolCall must keep its result. */
function expectPairsIntact(messages: AgentMessage[]): void {
	const callIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") callIds.add(block.id);
			}
		}
	}
	const resultIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") resultIds.add(message.toolCallId);
	}
	for (const id of resultIds) {
		expect(callIds.has(id), `orphan toolResult ${id}`).toBe(true);
	}
	// No dangling toolCall whose result was dropped while the call survived.
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const ids = message.content.filter((b) => b.type === "toolCall").map((b) => b.id);
		if (ids.length === 0) continue;
		// The assistant must be accompanied by its results (grouped drop keeps them together).
		const index = messages.indexOf(message);
		for (const id of ids) {
			const found = messages
				.slice(index + 1)
				.some((m) => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === id);
			expect(found, `dangling toolCall ${id}`).toBe(true);
		}
	}
}

describe("resolveMaxContextTokens", () => {
	it("defaults to 70% of the context window", () => {
		expect(resolveMaxContextTokens(10000)).toBe(7000);
		expect(resolveMaxContextTokens(8192)).toBe(Math.floor(8192 * 0.7));
	});

	it("explicit override wins", () => {
		expect(resolveMaxContextTokens(10000, 1234)).toBe(1234);
	});

	it("ignores invalid overrides and windows", () => {
		expect(resolveMaxContextTokens(10000, -5)).toBe(7000);
		expect(resolveMaxContextTokens(0)).toBe(0);
		expect(resolveMaxContextTokens(Number.NaN)).toBe(0);
	});
});

describe("extractQueryTerms", () => {
	it("splits camel/snake/kebab, lowercases, drops stopwords, dedupes", () => {
		expect(extractQueryTerms("how do I fix getUserName in user_service config-value?")).toEqual([
			"fix",
			"get",
			"user",
			"name",
			"getusername",
			"service",
			"config",
			"value",
		]);
	});

	it("emits the joined compound for split identifiers", () => {
		expect(extractQueryTerms("sceMaxFiles")).toEqual(["sce", "max", "files", "scemaxfiles"]);
		expect(extractQueryTerms("widget")).toEqual(["widget"]);
	});

	it("returns [] for empty input", () => {
		expect(extractQueryTerms("")).toEqual([]);
		expect(extractQueryTerms("a the to")).toEqual([]);
	});
});

describe("resolveReservedTailMessages", () => {
	it("keeps the minimum on small budgets and scales up, capped at 8", () => {
		expect(resolveReservedTailMessages(4000)).toBe(2);
		expect(resolveReservedTailMessages(19_999)).toBe(2);
		expect(resolveReservedTailMessages(91_700)).toBe(4);
		expect(resolveReservedTailMessages(200_000)).toBe(8);
		expect(resolveReservedTailMessages(0)).toBe(2);
	});
});

describe("compressToolResultText", () => {
	it("keeps query-relevant lines buried in the middle", () => {
		const filler = Array.from({ length: 60 }, (_, i) => `filler line ${i} ${"z".repeat(40)}`).join("\n");
		const text = `${filler}\nERROR connection refused databaseTimeout\n${filler}`;
		const out = compressToolResultText(text, 200, ["databasetimeout"]);
		expect(out).toContain("ERROR connection refused databaseTimeout");
		expect(out).toContain("compressed by COE");
		expect(out.length).toBeLessThan(text.length);
	});

	it("keeps failure-signal lines even without query terms", () => {
		const filler = Array.from({ length: 60 }, (_, i) => `filler line ${i} ${"z".repeat(40)}`).join("\n");
		const text = `${filler}\nAssertionError: expected 200 but got 500\n${filler}`;
		const out = compressToolResultText(text, 200, []);
		expect(out).toContain("AssertionError: expected 200 but got 500");
		expect(out).toContain("compressed by COE");
	});

	it("falls back to head-first fill when nothing matches", () => {
		const text = `${"a".repeat(3000)}\n${"b".repeat(3000)}`;
		const out = compressToolResultText(text, 100, ["nomatch"]);
		expect(out).toContain("compressed by COE");
		expect(out.length).toBeLessThan(text.length);
	});

	it("collapses repeated lines and returns short text unchanged", () => {
		expect(compressToolResultText("ok\nok\nok\ndone", 1000, [])).toBe("ok\ndone");
		expect(compressToolResultText("short", 1000, [])).toBe("short");
	});
});

describe("optimizeMessagesForBudget", () => {
	it("no-ops when already under budget", () => {
		const messages: AgentMessage[] = [user("hi"), assistantText("hello")];
		const snapshot: CoeSnapshot = { systemPrompt: "sys" };
		const result = optimizeMessagesForBudget(messages, snapshot, { maxContextTokens: 100000 });
		expect(result.messages).toBe(messages);
		expect(result.droppedMessages).toBe(0);
		expect(result.truncatedToolResults).toBe(0);
		expect(result.tokensAfter).toBe(result.tokensBefore);
	});

	it("counts system prompt and tool schemas against the budget", () => {
		const messages: AgentMessage[] = [user("hi")];
		const withoutSystem = estimateRequestTokens(messages, {});
		const withSystem = estimateRequestTokens(messages, { systemPrompt: "x".repeat(4000) });
		expect(withSystem - withoutSystem).toBe(1000);

		// History alone fits, but the system prompt pushes it over -> trimming kicks in.
		const history: AgentMessage[] = [];
		for (let i = 0; i < 4; i++) {
			history.push(user(`q${i} ${"a".repeat(400)}`));
			history.push(assistantText(`r${i} ${"b".repeat(400)}`));
		}
		const roomy = optimizeMessagesForBudget(history, {}, { maxContextTokens: 100000 });
		expect(roomy.droppedMessages).toBe(0);
		const tight = optimizeMessagesForBudget(history, { systemPrompt: "s".repeat(4000) }, { maxContextTokens: 1300 });
		expect(tight.tokensAfter).toBeLessThanOrEqual(1300);
		expect(tight.droppedMessages).toBeGreaterThan(0);
	});

	it("truncates oversized tool results keeping head and tail", () => {
		const big = `HEAD-${"x".repeat(20000)}-TAIL`;
		const messages: AgentMessage[] = [
			user("run"),
			assistantToolCall("c1", "read", { path: "f" }),
			toolResult("c1", "read", big),
			user("thanks"),
			assistantText("done"),
		];
		const result = optimizeMessagesForBudget(messages, {}, { maxContextTokens: 300, toolResultCapTokens: 100 });
		expect(result.truncatedToolResults).toBe(1);
		const truncated = result.messages.find((m) => m.role === "toolResult") as ToolResultMessage;
		const text = truncated.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("");
		expect(text).toContain("HEAD-");
		expect(text).toContain("-TAIL");
		expect(text).toContain("compressed by COE");
		expect(text.length).toBeLessThan(big.length);
		expectPairsIntact(result.messages);
	});

	it("evicts the oldest copy of identical repeated results without placeholders", () => {
		const repeated = "same output ".repeat(200);
		const messages: AgentMessage[] = [
			user("first read"),
			assistantToolCall("c1", "read", { path: "f" }),
			toolResult("c1", "read", repeated),
			user("second read"),
			assistantToolCall("c2", "read", { path: "f" }),
			toolResult("c2", "read", repeated),
			user("summarize"),
			assistantText("final answer"),
		];
		const tokensBefore = estimateRequestTokens(messages, {});
		const result = optimizeMessagesForBudget(messages, {}, { maxContextTokens: Math.ceil(tokensBefore * 0.6) });
		expect(result.tokensAfter).toBeLessThanOrEqual(Math.ceil(tokensBefore * 0.6));
		expect(result.droppedMessages).toBeGreaterThan(0);
		// No synthetic text is ever injected: the earlier copy is dropped as a
		// whole group, the surviving history contains only genuine content.
		const joined = JSON.stringify(result.messages);
		expect(joined).not.toContain("omitted by COE");
		expect(joined).not.toContain("first read");
		expect(joined).toContain("second read");
		expect(joined).toContain("summarize");
		expectPairsIntact(result.messages);
	});

	it("drops oldest groups first, keeps last 2 messages and pairs intact", () => {
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 10; i++) {
			messages.push(user(`item ${i} ${"p".repeat(200)}`));
			messages.push(assistantToolCall(`c${i}`, "read", { path: `f${i}` }));
			messages.push(toolResult(`c${i}`, "read", `output ${i} ${"o".repeat(200)}`));
		}
		messages.push(user("final question"));
		messages.push(assistantText("final answer"));
		const total = messages.length;

		const result = optimizeMessagesForBudget(messages, {}, { maxContextTokens: 800 });
		expect(result.tokensAfter).toBeLessThanOrEqual(800);
		expect(result.droppedMessages).toBeGreaterThan(0);
		// Last 2 messages untouched.
		expect(result.messages.slice(-2)).toEqual(messages.slice(-2));
		// Oldest content is gone.
		const joined = JSON.stringify(result.messages);
		expect(joined).not.toContain("item 0");
		expect(joined).toContain("final question");
		expectPairsIntact(result.messages);
		expect(result.messages.length).toBe(total - result.droppedMessages);
	});

	it("drops the least relevant group first, not the oldest", () => {
		const messages: AgentMessage[] = [
			user(`irrelevant weather chat ${"w".repeat(300)}`),
			assistantText(`sunny skies ${"s".repeat(300)}`),
			user(`databaseTimeout investigation ${"d".repeat(300)}`),
			assistantToolCall("c1", "read", { path: "db.ts" }),
			toolResult("c1", "read", `connect databaseTimeout retry ${"r".repeat(300)}`),
			user("how do I fix databaseTimeout?"),
			assistantText("here is the fix"),
		];
		const total = estimateRequestTokens(messages, {});
		// Budget fits the tail + exactly one of the two old groups.
		const tailTokens = estimateRequestTokens(messages.slice(-2), {});
		const oldRelevant = estimateRequestTokens(messages.slice(2, 5), {});
		const budget = Math.ceil(tailTokens + oldRelevant + 10);
		expect(budget).toBeLessThan(total);
		const result = optimizeMessagesForBudget(messages, {}, { maxContextTokens: budget });
		expect(result.tokensAfter).toBeLessThanOrEqual(budget);
		const joined = JSON.stringify(result.messages);
		expect(joined).not.toContain("irrelevant weather");
		expect(joined).toContain("databaseTimeout investigation");
		expect(result.queryTerms).toContain("database");
		expect(result.queryTerms).toContain("timeout");
		expectPairsIntact(result.messages);
	});

	it("never drops compaction or branch summaries", () => {
		const messages: AgentMessage[] = [
			{
				role: "compactionSummary",
				summary: "earlier work on auth",
				tokensBefore: 5000,
				timestamp: Date.now(),
			},
		];
		for (let i = 0; i < 10; i++) {
			messages.push(user(`item ${i} ${"p".repeat(200)}`));
			messages.push(assistantToolCall(`c${i}`, "read", { path: `f${i}` }));
			messages.push(toolResult(`c${i}`, "read", `output ${i} ${"o".repeat(200)}`));
		}
		messages.push(user("final question"));
		messages.push(assistantText("final answer"));

		const result = optimizeMessagesForBudget(messages, {}, { maxContextTokens: 800 });
		expect(result.tokensAfter).toBeLessThanOrEqual(800);
		expect(result.droppedMessages).toBeGreaterThan(0);
		// The summary holds the entire compacted past: it survives even though
		// it is the oldest entry and matches none of the query terms.
		expect(JSON.stringify(result.messages)).toContain("earlier work on auth");
		expect(result.messages.slice(-2)).toEqual(messages.slice(-2));
		expectPairsIntact(result.messages);
	});

	it("scores bash execution output by query relevance", () => {
		const bash = (command: string, output: string): BashExecutionMessage => ({
			role: "bashExecution",
			command,
			output,
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: Date.now(),
		});
		const messages: AgentMessage[] = [
			user(`chatting about weather ${"w".repeat(300)}`),
			bash("curl wttr.in", `sunny skies ${"s".repeat(300)}`),
			user(`databaseTimeout probe ${"d".repeat(300)}`),
			bash("pg_isready", `databaseTimeout connection refused ${"r".repeat(300)}`),
			user("how do I fix databaseTimeout?"),
			assistantText("here is the fix"),
		];
		const tailTokens = estimateRequestTokens(messages.slice(-2), {});
		const relevantTokens = estimateRequestTokens(messages.slice(2, 4), {});
		const budget = Math.ceil(tailTokens + relevantTokens + 10);
		expect(budget).toBeLessThan(estimateRequestTokens(messages, {}));
		const result = optimizeMessagesForBudget(messages, {}, { maxContextTokens: budget });
		expect(result.tokensAfter).toBeLessThanOrEqual(budget);
		const joined = JSON.stringify(result.messages);
		expect(joined).not.toContain("wttr.in");
		expect(joined).toContain("pg_isready");
		expectPairsIntact(result.messages);
	});

	it("never splits an assistant from tail toolResults when protecting the tail", () => {
		const messages: AgentMessage[] = [
			user("old stuff ".repeat(100)),
			assistantText("old answer ".repeat(100)),
			user("do it"),
			assistantToolCall("ct", "bash", { cmd: "ls" }),
			toolResult("ct", "bash", "file list"),
		];
		const result = optimizeMessagesForBudget(
			messages,
			{},
			{
				maxContextTokens: 100,
				reservedTailMessages: 1,
			},
		);
		// Tail toolResult kept => its assistant must be kept too.
		const keptToolResult = result.messages.some(
			(m) => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === "ct",
		);
		if (keptToolResult) {
			expect(
				result.messages.some(
					(m) =>
						m.role === "assistant" &&
						(m as AssistantMessage).content.some((b) => b.type === "toolCall" && b.id === "ct"),
				),
			).toBe(true);
		}
		expectPairsIntact(result.messages);
	});

	it("keeps everything when the whole history fits the reserved tail", () => {
		const messages: AgentMessage[] = [user("a"), assistantText("b")];
		const result = optimizeMessagesForBudget(messages, {}, { maxContextTokens: 1, reservedTailMessages: 5 });
		expect(result.messages.length).toBe(2);
		expect(result.droppedMessages).toBe(0);
	});
});

describe("createCoeTransform", () => {
	it("returns messages unchanged when under budget", async () => {
		const transform = createCoeTransform({ model: { contextWindow: 128000 } });
		const messages: AgentMessage[] = [user("hi")];
		await expect(transform(messages)).resolves.toBe(messages);
	});

	it("trims over-budget history and accounts for system prompt via getSnapshot", async () => {
		const transform = createCoeTransform({
			model: { contextWindow: 1000 },
			maxContextTokens: 400,
			getSnapshot: () => ({ systemPrompt: "sys" }),
		});
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 8; i++) {
			messages.push(user(`q${i} ${"z".repeat(300)}`));
			messages.push(assistantText(`a${i} ${"y".repeat(300)}`));
		}
		messages.push(user("last"));
		messages.push(assistantText("end"));
		const out = await transform(messages);
		expect(estimateRequestTokens(out, { systemPrompt: "sys" })).toBeLessThanOrEqual(400);
		expect(out.slice(-2)).toEqual(messages.slice(-2));
	});

	it("never throws on hostile input", async () => {
		const transform = createCoeTransform({
			model: { contextWindow: 100 },
			getSnapshot: () => {
				throw new Error("snapshot boom");
			},
		});
		const messages: AgentMessage[] = [user("hi")];
		await expect(transform(messages)).resolves.toBe(messages);
	});
});

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

describe("COE wired into agentLoop via transformContext", () => {
	it("keeps the LLM request within budget on an over-budget history", async () => {
		const history: AgentMessage[] = [];
		for (let i = 0; i < 12; i++) {
			history.push(user(`question ${i} ${"q".repeat(400)}`));
			history.push(assistantText(`answer ${i} ${"a".repeat(400)}`));
		}
		const context: AgentContext = { systemPrompt: "You are helpful.", messages: history, tools: [] };
		let seenByLlm: Message[] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			transformContext: createCoeTransform({
				model: createModel(),
				maxContextTokens: 600,
				getSnapshot: () => ({ systemPrompt: context.systemPrompt, tools: context.tools }),
			}),
		};
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						api: "openai-responses",
						provider: "openai",
						model: "mock",
						usage: createUsage(),
						stopReason: "stop",
						timestamp: Date.now(),
					} satisfies AssistantMessage,
				});
			});
			return stream;
		};
		// Capture what the loop hands to convertToLlm after transformContext.
		const capturing: AgentLoopConfig = {
			...config,
			convertToLlm: (messages) => {
				seenByLlm = identityConverter(messages);
				return seenByLlm;
			},
		};
		const stream = agentLoop([user("final")], context, capturing, undefined, streamFn);
		await stream.result();
		expect(seenByLlm.length).toBeGreaterThan(0);
		expect(
			estimateRequestTokens(seenByLlm as AgentMessage[], { systemPrompt: context.systemPrompt }),
		).toBeLessThanOrEqual(600);
		// Reserved tail: the new prompt survives trimming.
		expect(JSON.stringify(seenByLlm)).toContain("final");
	});
});

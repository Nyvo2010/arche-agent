import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { optimizeMessagesForBudget } from "../src/coe.ts";
import {
	applySceSlice,
	buildSceQuery,
	buildSceSliceText,
	createSceSliceMessage,
	rankSceDocs,
	resolveSceScoreFn,
	SCE_SLICE_MARKER,
	SceCache,
	type SceFileDoc,
	type SceScanResult,
	scoreSemanticSimilarity,
	scoreTermOverlap,
} from "../src/sce.ts";
import type { AgentMessage } from "../src/types.ts";

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

function doc(path: string, body: string, matchedLines?: number[]): SceFileDoc {
	const lines = body.split("\n");
	return {
		path,
		lines,
		matchedLines:
			matchedLines ?? lines.map((_, i) => i + 1).filter((n) => lines[n - 1].toLowerCase().includes("auth")),
	};
}

async function runApply(
	messages: AgentMessage[],
	docs: SceFileDoc[],
	options?: { maxFiles?: number; budgetTokens?: number; enableSemantic?: boolean },
): Promise<{ applied: AgentMessage[]; calls: number; result: Awaited<ReturnType<typeof applySceSlice>> }> {
	let calls = 0;
	const cache = new SceCache();
	const scan = async (): Promise<SceScanResult> => {
		calls++;
		return { docs, fallback: false };
	};
	const result = await applySceSlice(messages, {
		root: "/ws",
		cache,
		scanDocs: scan,
		...options,
	});
	return { applied: result.messages, calls, result };
}

describe("buildSceQuery", () => {
	it("combines the last user message with the last assistant reply", () => {
		const messages: AgentMessage[] = [user("how does authenticateUser work"), assistantText("looking at auth")];
		const query = buildSceQuery(messages);
		expect(query).toContain("authenticateUser");
		expect(query).toContain("looking at auth");
	});

	it("returns empty when there is no user message", () => {
		expect(buildSceQuery([assistantText("hello")])).toBe("");
		expect(buildSceQuery([])).toBe("");
	});
});

describe("scoreTermOverlap", () => {
	it("ranks the defining file first and boosts filename matches", () => {
		const docs = [
			doc("docs/notes.md", "auth login\nmore auth mentions here"),
			doc("src/auth.ts", "export function authenticateUser() {}"),
		];
		const scores = scoreTermOverlap(docs, ["auth"], "where is auth");
		expect(scores[1]).toBeGreaterThan(scores[0]);
	});

	it("scores zero when no term matches", () => {
		const docs = [doc("src/auth.ts", "export function authenticateUser() {}")];
		expect(scoreTermOverlap(docs, ["zebra"], "zebra")).toEqual([0]);
	});

	it("surfaces an exactly named file above tf-inflated docs", () => {
		const docs = [
			doc("docs/notes.md", Array.from({ length: 50 }, () => "sdk sdk sdk").join("\n")),
			doc("src/sdk.ts", "export const sdk = 1;"),
		];
		const scores = scoreTermOverlap(docs, ["sdk"], "where is sdk");
		expect(scores[1]).toBeGreaterThan(scores[0]);
	});
});

describe("scoreSemanticSimilarity", () => {
	it("tolerates spelling variants that term overlap misses", () => {
		const docs = [
			{ path: "docs/todo.md", lines: ["buy milk", "call plumber"], matchedLines: [1] },
			{ path: "src/color.ts", lines: ["export const color = 'red';"], matchedLines: [1] },
		];
		const termScores = scoreTermOverlap(docs, ["colour"], "where is colour handled");
		expect(termScores).toEqual([0, 0]);
		const semantic = scoreSemanticSimilarity(docs, ["colour"], "where is colour handled");
		expect(semantic[1]).toBeGreaterThan(semantic[0]);
	});

	it("resolves by mode", () => {
		expect(resolveSceScoreFn(false).name).toBe("term-bm25");
		expect(resolveSceScoreFn(undefined).name).toBe("term-bm25");
		expect(resolveSceScoreFn(true).name).toBe("semantic-trigram");
	});
});

describe("rankSceDocs", () => {
	it("orders best-first with stable ties", () => {
		const docs = [doc("b.ts", "nothing relevant here", []), doc("a.ts", "auth login session", [1])];
		const order = rankSceDocs(docs, ["auth"], "auth", scoreTermOverlap);
		expect(order).toEqual([1, 0]);
	});
});

describe("buildSceSliceText", () => {
	it("heads excerpts with path:line and holds the budget", () => {
		const docs = [
			{
				path: "src/auth.ts",
				lines: ["line one", "export function authenticateUser() {", "line three"],
				matchedLines: [2],
			},
		];
		const { text, files } = buildSceSliceText(docs, 2000);
		expect(text.startsWith(SCE_SLICE_MARKER)).toBe(true);
		expect(text).toContain("src/auth.ts:2: export function authenticateUser() {");
		expect(files).toEqual(["src/auth.ts"]);
		expect(text.length).toBeLessThanOrEqual(2000 * 4 + 64);
	});

	it("trims to a tiny budget instead of overflowing", () => {
		const docs = [
			{
				path: "src/big.ts",
				lines: Array.from({ length: 50 }, (_, i) => `auth line number ${i} with content`),
				matchedLines: Array.from({ length: 50 }, (_, i) => i + 1),
			},
		];
		const { text } = buildSceSliceText(docs, 10);
		expect(text.length).toBeLessThanOrEqual(10 * 4 + 64);
		expect(text).toContain("src/big.ts:");
	});

	it("emits head lines for fallback docs", () => {
		const { text } = buildSceSliceText(
			[{ path: "index.ts", lines: ["export * from './app';"], matchedLines: [] }],
			2000,
		);
		expect(text).toContain("index.ts:1: export * from './app';");
	});
});

describe("applySceSlice", () => {
	it("prepends a real slice and leaves the input untouched", async () => {
		const messages: AgentMessage[] = [user("how does authenticateUser work")];
		const docs = [
			{
				path: "src/auth.ts",
				lines: ["// auth module", "export function authenticateUser() {", "}"],
				matchedLines: [1, 2],
			},
		];
		const { applied, calls, result } = await runApply(messages, docs);
		expect(calls).toBe(1);
		expect(result.cached).toBe(false);
		expect(result.files).toEqual(["src/auth.ts"]);
		expect(applied.length).toBe(2);
		expect(applied).not.toBe(messages);
		expect(messages.length).toBe(1);
		const first = applied[0];
		if (first.role !== "user" || typeof first.content !== "string") throw new Error("expected SCE text slice");
		expect(first.content.startsWith(SCE_SLICE_MARKER)).toBe(true);
		expect(first.content.includes("src/auth.ts:2:")).toBe(true);
	});

	it("serves the second identical turn from cache without re-scanning", async () => {
		const messages: AgentMessage[] = [user("how does authenticateUser work")];
		const docs = [{ path: "src/auth.ts", lines: ["export function authenticateUser() {"], matchedLines: [1] }];
		let calls = 0;
		const cache = new SceCache();
		const runArgs = {
			root: "/ws",
			cache,
			scanDocs: async (): Promise<SceScanResult> => {
				calls++;
				return { docs, fallback: false };
			},
		};
		const first = await applySceSlice(messages, runArgs);
		const second = await applySceSlice(messages, runArgs);
		expect(calls).toBe(1);
		expect(first.cached).toBe(false);
		expect(second.cached).toBe(true);
		expect(second.messages[0]).toEqual(first.messages[0]);
	});

	it("does not rescan as assistant chatter evolves within one user turn", async () => {
		const docs = [{ path: "src/auth.ts", lines: ["auth"], matchedLines: [1] }];
		let calls = 0;
		const cache = new SceCache();
		const runArgs = {
			root: "/ws",
			cache,
			scanDocs: async (): Promise<SceScanResult> => {
				calls++;
				return { docs, fallback: false };
			},
		};
		const first = await applySceSlice([user("how does authenticateUser work")], runArgs);
		expect(first.cached).toBe(false);
		const second = await applySceSlice(
			[user("how does authenticateUser work"), assistantText("checking src/auth.ts now")],
			runArgs,
		);
		expect(calls).toBe(1);
		expect(second.cached).toBe(true);
		// A genuinely new user request re-scans.
		await applySceSlice([user("how does the payment refund flow behave")], runArgs);
		expect(calls).toBe(2);
	});

	it("drops the cache on invalidate", async () => {
		const messages: AgentMessage[] = [user("how does authenticateUser work")];
		const docs = [{ path: "src/auth.ts", lines: ["auth"], matchedLines: [1] }];
		let calls = 0;
		const cache = new SceCache();
		const runArgs = {
			root: "/ws",
			cache,
			scanDocs: async (): Promise<SceScanResult> => {
				calls++;
				return { docs, fallback: false };
			},
		};
		await applySceSlice(messages, runArgs);
		cache.invalidate();
		await applySceSlice(messages, runArgs);
		expect(calls).toBe(2);
	});

	it("no-ops silently on empty terms, empty scan, and scan errors", async () => {
		const cache = new SceCache();
		const stopwords: AgentMessage[] = [user("a")];
		const emptyTerms = await applySceSlice(stopwords, {
			root: "/ws",
			cache,
			scanDocs: async () => ({ docs: [{ path: "x", lines: ["y"], matchedLines: [1] }], fallback: false }),
		});
		expect(emptyTerms.messages).toBe(stopwords);

		const noDocs = await applySceSlice([user("authenticateUser")], {
			root: "/ws",
			cache,
			scanDocs: async () => ({ docs: [], fallback: true }),
		});
		expect(noDocs.messages.length).toBe(1);

		const throwing = await applySceSlice([user("authenticateUser")], {
			root: "/ws",
			cache,
			scanDocs: async () => {
				throw new Error("disk gone");
			},
		});
		expect(throwing.messages.length).toBe(1);
	});

	it("skips the walk for single short probes", async () => {
		let calls = 0;
		const messages: AgentMessage[] = [user("thanks")];
		const result = await applySceSlice(messages, {
			root: "/ws",
			cache: new SceCache(),
			scanDocs: async (): Promise<SceScanResult> => {
				calls++;
				return {
					docs: [{ path: "src/auth.ts", lines: ["thanks"], matchedLines: [1] }],
					fallback: false,
				};
			},
		});
		expect(result.messages).toBe(messages);
		expect(calls).toBe(0);
		expect(result.queryTerms).toEqual(["thanks"]);
	});

	it("never double-injects an already-sliced turn", async () => {
		const sliced = [createSceSliceMessage(`${SCE_SLICE_MARKER}\nbody`), user("follow up")];
		const result = await applySceSlice(sliced, {
			root: "/ws",
			cache: new SceCache(),
			scanDocs: async () => {
				throw new Error("must not scan");
			},
		});
		expect(result.messages).toBe(sliced);
	});
});

describe("SCE marker parity with COE", () => {
	it("matches the literal COE protects from drops", () => {
		expect(SCE_SLICE_MARKER).toBe("<workspace-context>");
	});

	it("COE keeps the SCE slice under budget pressure", () => {
		const slice = createSceSliceMessage(`${SCE_SLICE_MARKER}\n<file: src/auth.ts>\nsrc/auth.ts:2: real code`);
		const messages: AgentMessage[] = [slice, user("what does auth do")];
		for (let i = 0; i < 30; i++) {
			messages.push(assistantToolCall(`c${i}`, "read", { path: `f${i}.ts` }));
			messages.push(toolResult(`c${i}`, "read", `unrelated filler ${i}\n${"x".repeat(4000)}`));
		}
		messages.push(user("summarize auth"));
		messages.push(assistantText("working on it"));
		const result = optimizeMessagesForBudget(messages, { systemPrompt: "", tools: [] }, { maxContextTokens: 3000 });
		expect(result.tokensAfter).toBeLessThanOrEqual(3000);
		const joined = result.messages
			.map((m) => (m.role === "user" && typeof m.content === "string" ? m.content : ""))
			.join("\n");
		expect(joined).toContain(SCE_SLICE_MARKER);
	});
});

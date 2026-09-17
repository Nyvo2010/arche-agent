import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateRequestTokens, resolveMaxContextTokens } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
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

describe("createAgentSession COE wiring", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-coe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("trims an over-budget history through the production transformContext", async () => {
		const model = getModel("openai", "gpt-4o-mini");
		expect(model).toBeTruthy();
		const budget = resolveMaxContextTokens(model!.contextWindow);
		expect(budget).toBeGreaterThan(0);

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager: SessionManager.inMemory(cwd),
		});
		try {
			expect(session.agent.transformContext).toBeTypeOf("function");

			// ~40 groups x ~12KB results = ~480KB > ~358KB budget.
			const messages: AgentMessage[] = [{ role: "user", content: "investigate", timestamp: Date.now() }];
			for (let i = 0; i < 40; i++) {
				messages.push(assistantToolCall(`c${i}`, "read", { path: `f${i}.ts` }));
				messages.push(toolResult(`c${i}`, "read", `log line ${i}\n${"x".repeat(12000)}`));
			}
			messages.push({ role: "user", content: "summarize the logs", timestamp: Date.now() });
			messages.push({
				role: "assistant",
				content: [{ type: "text", text: "working on it" }],
				api: "openai-responses",
				provider: "openai",
				model: "mock",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});

			const snapshot = {
				systemPrompt: session.agent.state.systemPrompt,
				tools: session.agent.state.tools,
			};
			const before = estimateRequestTokens(messages, snapshot);
			expect(before).toBeGreaterThan(budget);

			const after = await session.agent.transformContext!(messages);
			const afterTokens = estimateRequestTokens(after, snapshot);
			expect(afterTokens).toBeLessThanOrEqual(budget);
			expect(afterTokens).toBeLessThan(before);

			// Invariants hold end to end: tail kept, pairs intact, no synthetic text.
			expect(after.slice(-2)).toEqual(messages.slice(-2));
			const joined = JSON.stringify(after);
			expect(joined).not.toContain("omitted by COE");
			const callIds = new Set<string>();
			for (const m of after) {
				if (m.role === "assistant") {
					for (const b of m.content) if (b.type === "toolCall") callIds.add(b.id);
				}
			}
			for (const m of after) {
				if (m.role === "toolResult") expect(callIds.has(m.toolCallId)).toBe(true);
			}
		} finally {
			session.dispose();
		}
	});

	it("warns on the first turn when the budget override sits below the floor", async () => {
		const model = getModel("openai", "gpt-4o-mini");
		expect(model).toBeTruthy();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ context: { maxBudgetTokens: 100 } }));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: model!,
				sessionManager: SessionManager.inMemory(cwd),
			});
			try {
				expect(warn).not.toHaveBeenCalled();
				await session.agent.transformContext!([{ role: "user", content: "hi", timestamp: Date.now() }]);
				expect(warn).toHaveBeenCalledOnce();
				expect(warn.mock.calls[0]?.[0]).toContain("[COE] budget 100 below estimated floor");
			} finally {
				session.dispose();
			}
		} finally {
			warn.mockRestore();
		}
	});

	it("leaves an under-budget history effectively unchanged", async () => {
		const model = getModel("openai", "gpt-4o-mini");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager: SessionManager.inMemory(cwd),
		});
		try {
			const messages: AgentMessage[] = [
				{ role: "user", content: "hi", timestamp: Date.now() },
				assistantToolCall("c1", "read", { path: "f" }),
				toolResult("c1", "read", "small"),
			];
			const after = await session.agent.transformContext!(messages);
			expect(after).toEqual(messages);
		} finally {
			session.dispose();
		}
	});
});

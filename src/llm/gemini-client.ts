/**
 * A.L.A.N. Gemini Client
 * Full native function calling via @google/generative-ai.
 * API key injected from vault at call time — never cached.
 * Tools passed as FunctionDeclarations; responses parsed for functionCall parts.
 */

import {
	GoogleGenerativeAI,
	type Content,
	type Part,
	type FunctionDeclaration,
	type Tool,
	type GenerateContentResult,
	SchemaType,
} from "@google/generative-ai";
import { vault } from "../vault/vault.js";
import { rateLimiter, type RequestPriority } from "./rate-limiter.js";
import type { GeminiTool } from "../skills/skill-system.js";

export const GEMINI_MODELS = {
	FLASH_2_5: "gemini-2.5-flash",
	PRO_2_5: "gemini-2.5-pro",
	FLASH_3: "gemini-3-flash-preview",
	PRO_3_5: "gemini-3-flash-pro-preview",
} as const;

export type GeminiModel = (typeof GEMINI_MODELS)[keyof typeof GEMINI_MODELS];

export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

export interface ToolCallRequest {
	callId: string;
	toolName: string; // e.g. "file-search__search_files"
	skillId: string; // e.g. "file-search"
	actionId: string; // e.g. "search_files"
	params: Record<string, unknown>;
}

export interface LLMResponse {
	text: string;
	model: GeminiModel;
	toolCalls: ToolCallRequest[];
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	latencyMs: number;
}

export interface LLMConfig {
	model?: GeminiModel;
	temperature?: number;
	maxOutputTokens?: number;
	systemPrompt?: string;
}

function toSchemaType(t: string): SchemaType {
	switch (t) {
		case "number":
			return SchemaType.NUMBER;
		case "boolean":
			return SchemaType.BOOLEAN;
		case "array":
			return SchemaType.ARRAY;
		case "object":
			return SchemaType.OBJECT;
		default:
			return SchemaType.STRING;
	}
}

function toFunctionDeclarations(tools: GeminiTool[]): FunctionDeclaration[] {
	return tools.map((t) => ({
		name: t.name,
		description: t.description,
		parameters: {
			type: SchemaType.OBJECT,
			properties: Object.fromEntries(
				Object.entries(t.parameters.properties).map(([k, v]) => [
					k,
					{ type: toSchemaType(v.type), description: v.description },
				]),
			),
			required: t.parameters.required,
		},
	}));
}

function parseToolName(name: string): { skillId: string; actionId: string } {
	const idx = name.indexOf("__");
	if (idx === -1) return { skillId: name, actionId: name };
	return { skillId: name.slice(0, idx), actionId: name.slice(idx + 2) };
}

const DEFAULT_CONFIG: Required<LLMConfig> = {
	model: GEMINI_MODELS.FLASH_2_5,
	temperature: 0.7,
	maxOutputTokens: 8192,
	systemPrompt: "",
};

export class GeminiClient {
	private config: Required<LLMConfig>;

	constructor(config: LLMConfig = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	async chat(
		messages: ChatMessage[],
		options: {
			priority?: RequestPriority;
			config?: Partial<LLMConfig>;
			estimatedTokens?: number;
			tools?: GeminiTool[];
		} = {},
	): Promise<LLMResponse> {
		const priority = options.priority ?? "INTERACTIVE";
		const cfg = { ...this.config, ...options.config };

		return rateLimiter.execute(
			() => this.doChat(messages, cfg, options.tools ?? []),
			priority,
			options.estimatedTokens ?? 2000,
		) as Promise<LLMResponse>;
	}

	/**
	 * After executing a tool, send its result back and get model's final answer.
	 */
	async sendToolResults(
		messages: ChatMessage[],
		toolResults: Array<{ toolName: string; result: unknown }>,
		options: {
			priority?: RequestPriority;
			config?: Partial<LLMConfig>;
			tools?: GeminiTool[];
		} = {},
	): Promise<LLMResponse> {
		const priority = options.priority ?? "INTERACTIVE";
		const cfg = { ...this.config, ...options.config };

		return rateLimiter.execute(
			() =>
				this.doSendToolResults(messages, toolResults, cfg, options.tools ?? []),
			priority,
			1000,
		) as Promise<LLMResponse>;
	}

	async complete(
		prompt: string,
		options: { priority?: RequestPriority; config?: Partial<LLMConfig> } = {},
	): Promise<LLMResponse> {
		return this.chat(
			[{ role: "user", content: prompt, timestamp: Date.now() }],
			options,
		);
	}

	// ─── Internal ─────────────────────────────────────────────────────────────

	private getModel(cfg: Required<LLMConfig>, tools: GeminiTool[]) {
		const apiKey = vault.getSecret("gemini.api_key", "SYSTEM");
		if (!apiKey)
			throw new Error(
				"Gemini API key not found in vault. Add it in the Secrets tab.",
			);

		const genAI = new GoogleGenerativeAI(apiKey);
		const geminiTools: Tool[] =
			tools.length > 0
				? [{ functionDeclarations: toFunctionDeclarations(tools) }]
				: [];

		return genAI.getGenerativeModel({
			model: cfg.model,
			generationConfig: {
				temperature: cfg.temperature,
				maxOutputTokens: cfg.maxOutputTokens,
			},
			systemInstruction: cfg.systemPrompt || undefined,
			tools: geminiTools.length > 0 ? geminiTools : undefined,
		});
	}

	private async doChat(
		messages: ChatMessage[],
		cfg: Required<LLMConfig>,
		tools: GeminiTool[],
	): Promise<LLMResponse> {
		const start = Date.now();
		const model = this.getModel(cfg, tools);

		const history: Content[] = messages.slice(0, -1).map((m) => ({
			role: m.role === "assistant" ? "model" : "user",
			parts: [{ text: m.content } as Part],
		}));

		const lastMessage = messages[messages.length - 1];
		const chat = model.startChat({ history });
		const result: GenerateContentResult = await chat.sendMessage(
			lastMessage.content,
		);

		return this.parseResult(result, cfg.model, start);
	}

	private async doSendToolResults(
		messages: ChatMessage[],
		toolResults: Array<{ toolName: string; result: unknown }>,
		cfg: Required<LLMConfig>,
		tools: GeminiTool[],
	): Promise<LLMResponse> {
		const start = Date.now();
		const model = this.getModel(cfg, tools);

		// Full conversation history
		const history: Content[] = messages.map((m) => ({
			role: m.role === "assistant" ? "model" : "user",
			parts: [{ text: m.content } as Part],
		}));

		const chat = model.startChat({ history });

		// Send all function responses in one message
		const functionResponseParts: Part[] = toolResults.map(
			(tr) =>
				({
					functionResponse: {
						name: tr.toolName,
						response: {
							result:
								typeof tr.result === "string"
									? tr.result
									: JSON.stringify(tr.result),
						},
					},
				}) as Part,
		);

		const result = await chat.sendMessage(functionResponseParts);
		return this.parseResult(result, cfg.model, start);
	}

	private parseResult(
		result: GenerateContentResult,
		model: GeminiModel,
		start: number,
	): LLMResponse {
		const response = result.response;
		const usage = response.usageMetadata;
		const toolCalls: ToolCallRequest[] = [];
		let text = "";

		for (const candidate of response.candidates ?? []) {
			for (const part of candidate.content?.parts ?? []) {
				if ("text" in part && part.text) {
					text += part.text;
				} else if ("functionCall" in part && part.functionCall) {
					const fc = part.functionCall;
					const { skillId, actionId } = parseToolName(fc.name);
					toolCalls.push({
						callId: crypto.randomUUID(),
						toolName: fc.name,
						skillId,
						actionId,
						params: (fc.args ?? {}) as Record<string, unknown>,
					});
				}
			}
		}

		return {
			text: text.trim(),
			model,
			toolCalls,
			promptTokens: usage?.promptTokenCount ?? 0,
			completionTokens: usage?.candidatesTokenCount ?? 0,
			totalTokens: usage?.totalTokenCount ?? 0,
			latencyMs: Date.now() - start,
		};
	}

	updateConfig(config: Partial<LLMConfig>): void {
		this.config = { ...this.config, ...config };
	}
}

export const geminiClient = new GeminiClient();

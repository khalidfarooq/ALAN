/**
 * A.L.A.N. Reflector
 *
 * After the agent produces a response, the reflector evaluates it:
 *   - Did the response fully address the user's goal?
 *   - Are there obvious gaps or errors?
 *   - For WRITE/DESTRUCTIVE actions: is this actually what the user intended?
 *
 * Returns a ReflectionResult that the agent uses to decide whether to iterate
 * or surface a warning to the user.
 */

import { geminiClient } from "../llm/gemini-client.js";

export interface ReflectionResult {
	adequate: boolean;
	confidence: number; // 0-1
	gap?: string; // what's missing, if inadequate
	suggestion?: string; // what the agent should do next
	safetyFlag?: string; // for WRITE/DESTRUCTIVE — is this actually safe?
}

export async function reflect(
	userGoal: string,
	agentResponse: string,
	toolsUsed: string[],
	isWriteAction: boolean,
): Promise<ReflectionResult> {
	const safetySection = isWriteAction
		? `\nSAFETY CHECK: This response involves a WRITE or DESTRUCTIVE action. Check if the action is precisely what the user asked for — no more, no less.`
		: "";

	const prompt = `You are a quality-check assistant reviewing an AI agent's response.

USER GOAL: "${userGoal}"
TOOLS USED: ${toolsUsed.length > 0 ? toolsUsed.join(", ") : "none"}
AGENT RESPONSE: "${agentResponse.substring(0, 800)}"
${safetySection}

Evaluate the response. Respond ONLY with valid JSON — no markdown, no explanation.

{
  "adequate": true,
  "confidence": 0.9,
  "gap": null,
  "suggestion": null,
  "safetyFlag": null
}

Rules:
- "adequate": true if the response fully addresses the user's goal
- "confidence": 0.0-1.0 confidence in your evaluation
- "gap": if not adequate, describe what is missing (1 sentence max)
- "suggestion": if not adequate, what should the agent try next (1 sentence max)
- "safetyFlag": for write/destructive only — any concern about scope or safety`;

	try {
		const response = await geminiClient.complete(prompt, {
			priority: "INTERACTIVE",
			config: { temperature: 0.1, maxOutputTokens: 256 },
		});

		const json = response.text.replace(/```json|```/g, "").trim();
		return JSON.parse(json) as ReflectionResult;
	} catch {
		return { adequate: true, confidence: 0.5 };
	}
}

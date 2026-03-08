/**
 * A.L.A.N. Planner
 *
 * For complex, multi-step requests, the planner runs a dedicated Gemini call
 * to decompose the goal into an ordered StepPlan before execution begins.
 *
 * Complexity detection uses heuristics — anything with sequential keywords
 * ("then", "after", "first", "finally", "and then") or > 12 words is planned.
 */

import { geminiClient } from "../llm/gemini-client.js";

export interface StepPlan {
	steps: PlanStep[];
	reasoning: string;
	estimatedComplexity: "simple" | "moderate" | "complex";
}

export interface PlanStep {
	id: number;
	goal: string;
	toolHint?: string; // e.g. "file-search__search_files"
	requiresWrite: boolean;
	dependsOn?: number[];
}

// Keywords that suggest a multi-step, sequential request
const SEQUENTIAL_PATTERNS = [
	/\bthen\b/i,
	/\bafter that\b/i,
	/\bfirst.+then\b/i,
	/\bfinally\b/i,
	/\band also\b/i,
	/\bfollowed by\b/i,
	/\bonce you.+then\b/i,
	/\bstep by step\b/i,
	/\bmultiple\b/i,
];

const PLANNING_THRESHOLD_WORDS = 15;

export function shouldPlan(userMessage: string): boolean {
	if (userMessage.split(" ").length > PLANNING_THRESHOLD_WORDS) return true;
	return SEQUENTIAL_PATTERNS.some((p) => p.test(userMessage));
}

export async function buildPlan(
	userMessage: string,
	availableTools: string[],
): Promise<StepPlan> {
	const prompt = `You are a planning assistant. The user has a complex goal that needs multiple steps.

USER GOAL: "${userMessage}"

AVAILABLE TOOLS: ${availableTools.join(", ")}

Decompose this into 2-6 concrete steps. Respond ONLY with valid JSON — no markdown, no explanation.

{
  "reasoning": "why you chose this plan",
  "estimatedComplexity": "simple|moderate|complex",
  "steps": [
    {
      "id": 1,
      "goal": "concrete description of this step",
      "toolHint": "tool_name or null",
      "requiresWrite": false,
      "dependsOn": []
    }
  ]
}`;

	try {
		const response = await geminiClient.complete(prompt, {
			priority: "INTERACTIVE",
			config: { temperature: 0.2, maxOutputTokens: 1024 },
		});

		const json = response.text.replace(/```json|```/g, "").trim();
		return JSON.parse(json) as StepPlan;
	} catch {
		// Fallback: single-step plan
		return {
			reasoning: "Could not decompose — treating as single step",
			estimatedComplexity: "simple",
			steps: [{ id: 1, goal: userMessage, requiresWrite: false }],
		};
	}
}

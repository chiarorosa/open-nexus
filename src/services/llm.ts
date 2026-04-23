// llm.ts — Nexus LLM Service (OpenRouter)
// Uses OpenRouter's OpenAI-compatible API.
// Default model: google/gemma-3-27b-it:free

import { config } from "./config";
import { parseLLMResponse, type NexusCommand } from "./parser";
import { buildSkillCatalogForPrompt } from "./skillRegistry";

// ── Types ──────────────────────────────────────────────────────────────────

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMRequestContext {
  source?: "full_request" | "multi_action_segment" | "intent_recovery";
  originalUserMessage?: string;
  segmentIndex?: number;
  segmentTotal?: number;
  intentHints?: string[];
}

// ── System Prompt ──────────────────────────────────────────────────────────
// Optimised for instruction-following models that don't support json_object
// mode — the JSON schema is shown inline with a concrete fence-free example
// so the model learns the exact output shape expected.

function buildSystemPrompt(): string {
  const skillCatalog = buildSkillCatalogForPrompt();

  return `You are Nexus, a desktop assistant. Respond ONLY with a single raw JSON object — no markdown, no code fences, no extra text before or after.

Schema:
{"command":"<name>","args":{...},"display":"<short Portuguese description>"}

Commands:
1. open_url      — open a URL.          args: {"url":"https://..."}
2. search_web    — web search.          args: {"query":"..."}
3. create_folder — create a folder.     args: {"path":"~/Desktop/<name>"}
4. launch_app    — launch app/script.   args: {"name":"<app|script|command>"}
5. run_skill     — execute a known Skill args: {"skill_id":"<id>","inputs":{"key":"value"}}
6. chat          — conversational.      args: {"message":"<Portuguese reply>"}

Available Skills:
${skillCatalog}

Rules:
- Output ONLY the JSON object, nothing else.
- "display" and "message" must always be in Portuguese (pt-BR).
- If a [NEXUS_CONTEXT] block is present, use it as routing hints.
- If source=multi_action_segment, classify ONLY the current segment.
- Prefer run_skill when a known Skill matches the user intent.
- Never invent command names or skill ids not listed above.
- For searches use search_web (or a matching Skill), never build URL manually.
- If user message contains an explicit URL (http/https), prefer open_url (or web.open-site skill).
- For common web destinations written as names (ex: youtube, gmail, github), prefer open_url with canonical https URL.
- create_folder is only for explicit folder/directory intents, never for URLs.
- launch_app accepts app aliases, local commands, or script paths informed by user.
- For specific games/apps that may require launcher + second action, prefer run_skill with chained steps.
- If unsure, use chat and ask for clarification.

Examples:
{"command":"run_skill","args":{"skill_id":"web.search-topic","inputs":{"query":"redes neurais"}},"display":"Pesquisando sobre redes neurais"}
{"command":"open_url","args":{"url":"https://react.dev"},"display":"Abrindo documentação do React"}
{"command":"chat","args":{"message":"Olá! Como posso ajudar?"},"display":"Olá! Como posso ajudar?"}`;
}

// ── Context (session memory) ───────────────────────────────────────────────

const SESSION_WINDOW = 4; // Keep last N user/assistant turns

class SessionContext {
  private messages: Message[] = [];

  add(role: "user" | "assistant", content: string) {
    this.messages.push({ role, content });
    // Sliding window — trim oldest pairs to stay within limit
    while (this.messages.length > SESSION_WINDOW * 2) {
      this.messages.splice(0, 2);
    }
  }

  getHistory(): Message[] {
    return [...this.messages];
  }

  clear() {
    this.messages = [];
  }

  size(): number {
    return this.messages.length / 2;
  }
}

export const sessionContext = new SessionContext();

// ── LLM Service ───────────────────────────────────────────────────────────

export interface LLMResult {
  command: NexusCommand;
  rawResponse: string;
  tokensUsed?: number;
}

function buildContextualUserMessage(userMessage: string, context?: LLMRequestContext): string {
  if (!context) return userMessage;

  const contextLines: string[] = [];
  if (context.source) {
    contextLines.push(`- source: ${context.source}`);
  }
  if (typeof context.segmentIndex === "number" && typeof context.segmentTotal === "number") {
    contextLines.push(`- segment: ${context.segmentIndex}/${context.segmentTotal}`);
  }
  if (context.intentHints && context.intentHints.length > 0) {
    contextLines.push(`- hints: ${context.intentHints.join(", ")}`);
  }

  const original = context.originalUserMessage?.trim();
  const header = contextLines.length > 0 ? contextLines.join("\n") : "- source: unknown";

  if (!original || original === userMessage.trim()) {
    return `[NEXUS_CONTEXT]
${header}
[/NEXUS_CONTEXT]

${userMessage}`;
  }

  return `[NEXUS_CONTEXT]
${header}
- full_request: ${original}
[/NEXUS_CONTEXT]

Current segment:
${userMessage}`;
}

/**
 * Sends a user message to the LLM via OpenRouter, maintaining session context.
 *
 * Note on json_object mode: Gemma and many open-weight models do NOT support
 * response_format: { type: "json_object" }. We enforce JSON structure through
 * the system prompt and the parser fallback chain instead.
 */
export async function sendToLLM(userMessage: string, context?: LLMRequestContext): Promise<LLMResult> {
  const apiKey = config.getApiKey();
  if (!apiKey) {
    throw new Error(
      "API key não configurada. Clique no ⚙ para adicionar sua chave OpenRouter."
    );
  }

  const model   = config.getModel();
  const baseUrl = config.getBaseUrl();

  // System + history + new user message
  const contextualUserMessage = buildContextualUserMessage(userMessage, context);

  const messages: Message[] = [
    { role: "system", content: buildSystemPrompt() },
    ...sessionContext.getHistory(),
    { role: "user", content: contextualUserMessage },
  ];

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`,
      // OpenRouter-specific headers (recommended for routing & analytics)
      "HTTP-Referer":  "https://github.com/nexus-app",
      "X-Title":       "Nexus Desktop Assistant",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.1,   // Very low — we want deterministic JSON, not creativity
      max_tokens:  512,
      // NOTE: response_format is NOT sent — unsupported by most open-weight models.
      // JSON structure is enforced via the system prompt + parser fallback.
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  const rawResponse: string = data.choices?.[0]?.message?.content ?? "";
  const tokensUsed: number  = data.usage?.total_tokens;

  if (!rawResponse) {
    throw new Error("O modelo retornou uma resposta vazia.");
  }

  // Parse & validate — falls back to chat on any malformed output
  const command = parseLLMResponse(rawResponse);

  // Update session context
  sessionContext.add("user", userMessage);
  sessionContext.add("assistant", rawResponse);

  return { command, rawResponse, tokensUsed };
}

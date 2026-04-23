// dictationRefiner.ts — LLM-assisted post-processing for dictated commands.
// Uses the same configured LLM provider/model to refine STT output seamlessly.

import { config } from "./config";

interface Message {
  role: "system" | "user";
  content: string;
}

const DICTATION_SYSTEM_PROMPT = `Você é um normalizador de ditado de voz para o Nexus.
Receberá um texto de transcrição possivelmente com erros fonéticos.

Objetivo:
- Corrigir ortografia e palavras reconhecidas incorretamente.
- Preservar intenção original do usuário.
- Ajustar termos técnicos comuns do Nexus (ex: VS Code, Chrome, terminal, pasta, pesquisar, abrir URL).
- Produzir uma frase de comando natural e curta em pt-BR.

Restrições:
- Não inventar ações novas.
- Não adicionar explicações, comentários, ou texto extra.
- Não usar markdown.
- Não responder em formato conversacional.

Saída obrigatória:
Retorne SOMENTE um JSON bruto válido, no formato:
{"text":"<comando corrigido>"} `;

function extractJsonObject(content: string): string | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  return content.slice(start, end + 1);
}

function parseRefinedText(content: string): string | null {
  const trimmed = content.trim();
  const jsonRaw = extractJsonObject(trimmed) ?? trimmed;

  try {
    const parsed = JSON.parse(jsonRaw) as { text?: unknown };
    if (typeof parsed.text !== "string") return null;
    const result = parsed.text.trim();
    return result.length > 0 ? result : null;
  } catch {
    return null;
  }
}

export async function refineDictationWithLLM(rawText: string): Promise<string> {
  const source = rawText.trim();
  if (!source) return rawText;
  if (!config.isConfigured()) return rawText;

  const apiKey = config.getApiKey();
  const model = config.getModel();
  const baseUrl = config.getBaseUrl();

  const messages: Message[] = [
    { role: "system", content: DICTATION_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Texto de ditado bruto:\n${source}`,
    },
  ];

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/nexus-app",
      "X-Title": "Nexus Dictation Refiner",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0,
      max_tokens: 120,
    }),
  });

  if (!response.ok) {
    return rawText;
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") return rawText;

  const refined = parseRefinedText(content);
  return refined ?? rawText;
}

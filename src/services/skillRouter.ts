import type { CommandName, NexusCommand } from "./parser";
import { getSkillById, getSkillRegistrySnapshot, isSkillEnabled, type SkillDefinition } from "./skillRegistry";

interface RoutingMatch {
  skill: SkillDefinition;
  trigger: string;
  score: number;
}

export interface SkillRoutingResult {
  command: NexusCommand;
  skillId: string;
  confidence: number;
}

export interface SkillRoutingBenchmark {
  total: number;
  matched: number;
  accuracy: number;
}

const MIN_DIRECT_ROUTING_SCORE = 0.78;

const BENCHMARK_CASES: Array<{ utterance: string; expectedSkillId: string }> = [
  { utterance: "abra o site https://react.dev", expectedSkillId: "web.open-site" },
  { utterance: "abrir site https://tauri.app", expectedSkillId: "web.open-site" },
  { utterance: "pesquise sobre redes neurais", expectedSkillId: "web.search-topic" },
  { utterance: "buscar sobre produtividade pessoal", expectedSkillId: "web.search-topic" },
  { utterance: "crie uma pasta Nexus Projetos", expectedSkillId: "files.create-folder-safe" },
  { utterance: "nova pasta Estudos 2026", expectedSkillId: "files.create-folder-safe" },
  { utterance: "abra o vscode", expectedSkillId: "apps.launch-known-app" },
  { utterance: "inicie o chrome", expectedSkillId: "apps.launch-known-app" },
  { utterance: "reescreva esse texto de forma profissional", expectedSkillId: "assistant.rewrite-text-ptbr" },
  { utterance: "melhore esse texto para ficar claro", expectedSkillId: "assistant.rewrite-text-ptbr" },
  { utterance: "resuma em 3 linhas", expectedSkillId: "assistant.summarize-last-response" },
  { utterance: "faça um resumo desse conteúdo", expectedSkillId: "assistant.summarize-last-response" },
];

export function routeSkillFromText(utterance: string): SkillRoutingResult | null {
  return routeSkillFromTextInternal(utterance, null);
}

export function evaluateSkillRoutingAccuracy(): SkillRoutingBenchmark {
  const benchmarkSkillIds = new Set(BENCHMARK_CASES.map((test) => test.expectedSkillId));
  let matched = 0;
  for (const test of BENCHMARK_CASES) {
    const result = routeSkillFromTextInternal(test.utterance, benchmarkSkillIds);
    if (result?.skillId === test.expectedSkillId) {
      matched += 1;
    }
  }
  const total = BENCHMARK_CASES.length;
  return {
    total,
    matched,
    accuracy: total === 0 ? 0 : matched / total,
  };
}

function findBestSkillMatchWithFilter(
  utterance: string,
  allowedSkillIds: Set<string> | null,
  requiredFirstCommand: CommandName | null = null
): RoutingMatch | null {
  const registry = getSkillRegistrySnapshot();
  const utteranceNorm = normalizeText(utterance);
  let best: RoutingMatch | null = null;

  for (const skill of registry.skills) {
    if (allowedSkillIds && !allowedSkillIds.has(skill.id)) continue;
    if (!isSkillEnabled(skill.id)) continue;
    if (requiredFirstCommand) {
      const firstCommand = skill.steps[0]?.command ?? null;
      if (firstCommand !== requiredFirstCommand) continue;
    }
    for (const trigger of skill.triggers) {
      const triggerNorm = normalizeText(trigger);
      if (!triggerNorm) continue;
      const score = scoreTriggerMatch(utteranceNorm, triggerNorm);
      if (score <= 0) continue;
      if (!best || score > best.score) {
        best = { skill, trigger, score };
      }
    }
  }

  return best;
}

function routeSkillFromTextInternal(
  utterance: string,
  allowedSkillIds: Set<string> | null
): SkillRoutingResult | null {
  const text = utterance.trim();
  if (!text) return null;

  const explicitUrl = extractUrl(text);
  if (explicitUrl) {
    const openSiteSkill = getSkillById("web.open-site");
    if (openSiteSkill) {
      return {
        skillId: openSiteSkill.id,
        confidence: 1,
        command: {
          command: "run_skill",
          args: {
            skill_id: openSiteSkill.id,
            inputs: { url: explicitUrl },
          },
          display: `Abrindo página: ${explicitUrl}`,
        },
      };
    }

    return {
      skillId: "direct.open_url",
      confidence: 1,
      command: {
        command: "open_url",
        args: { url: explicitUrl },
        display: `Abrindo página: ${explicitUrl}`,
      },
    };
  }

  const intentHint = detectIntentCommandHint(text);
  const match = findBestSkillMatchWithFilter(text, allowedSkillIds, intentHint);
  if (!match || match.score < MIN_DIRECT_ROUTING_SCORE) {
    return null;
  }

  const inputs = inferInputs(text, match.skill, match.trigger);
  if (!inputs || Object.keys(inputs).length === 0) {
    return null;
  }

  return {
    skillId: match.skill.id,
    confidence: clamp(match.score, 0, 1),
    command: {
      command: "run_skill",
      args: {
        skill_id: match.skill.id,
        inputs,
      },
      display: `Executando skill ${match.skill.name}`,
    },
  };
}

function detectIntentCommandHint(text: string): CommandName | null {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  if (/\b(pasta|folder|diretorio|diretório)\b/.test(normalized)) {
    return "create_folder";
  }
  if (/\b(pesquise|pesquisar|buscar|procure)\b/.test(normalized)) {
    return "search_web";
  }
  if (/\b(abra|abrir|inicie|iniciar|execute)\b/.test(normalized) &&
      /\b(vscode|chrome|edge|firefox|terminal|spotify|slack|discord|bloco de notas|notepad)\b/.test(normalized)) {
    return "launch_app";
  }
  return null;
}

function inferInputs(
  utterance: string,
  skill: SkillDefinition,
  matchedTrigger: string
): Record<string, string | number | boolean> | null {
  if (skill.inputs.length === 0) {
    return {};
  }

  const tail = extractTailAfterTrigger(utterance, matchedTrigger);

  if (skill.inputs.length === 1) {
    const input = skill.inputs[0];
    let value = tail;
    if (!value) value = utterance.trim();

    if (input.key === "url") {
      const url = extractUrl(utterance) ?? value;
      value = url;
    } else if (input.key === "query") {
      value = cleanPrefixWords(value, ["sobre", "por", "a", "o"]);
    } else if (input.key === "name") {
      value = cleanPrefixWords(value, ["o", "a"]);
    }

    const finalValue = value.trim();
    if (!finalValue) return null;
    return { [input.key]: finalValue };
  }

  const result: Record<string, string> = {};
  for (const input of skill.inputs) {
    result[input.key] = "";
  }
  return result;
}

function extractTailAfterTrigger(text: string, trigger: string): string {
  const lowerText = text.toLowerCase();
  const lowerTrigger = trigger.toLowerCase();
  const idx = lowerText.indexOf(lowerTrigger);
  if (idx < 0) return "";
  const tail = text.slice(idx + trigger.length);
  return tail.replace(/^[:\s,-]+/, "").trim();
}

function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
}

function cleanPrefixWords(text: string, prefixes: string[]): string {
  let result = text.trim();
  const lower = result.toLowerCase();
  for (const prefix of prefixes) {
    if (lower.startsWith(`${prefix} `)) {
      result = result.slice(prefix.length).trim();
      break;
    }
  }
  return result;
}

function scoreTriggerMatch(utterance: string, trigger: string): number {
  if (!utterance || !trigger) return 0;
  const triggerLenBoost = Math.min(0.18, trigger.length / 80);
  if (utterance.startsWith(trigger)) {
    return 0.90 + triggerLenBoost;
  }
  if (utterance.includes(trigger)) {
    return 0.76 + triggerLenBoost;
  }

  const utteranceTokens = tokenize(utterance);
  const triggerTokens = tokenize(trigger);
  if (triggerTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of triggerTokens) {
    if (utteranceTokens.has(token)) {
      overlap += 1;
    }
  }
  const ratio = overlap / triggerTokens.size;
  if (ratio < 0.6) return 0;
  return 0.55 + (ratio * 0.25) + triggerLenBoost;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .split(/\s+/)
      .map((part) => part.trim())
      .filter((part) => part.length > 1)
  );
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

import type { CommandName, NexusCommand } from "./parser";
import { getSkillById, type SkillDefinition } from "./skillRegistry";

const GLOBAL_MAX_SKILL_STEPS = 5;
const GLOBAL_SKILL_TIMEOUT_MS = 12_000;

export interface PlannedSkillStep {
  command: CommandName;
  args: Record<string, string | number | boolean>;
}

export interface SkillPlan {
  skill: SkillDefinition;
  steps: PlannedSkillStep[];
  timeoutMs: number;
  requiresConfirmation: boolean;
}

export type SkillPlanResult =
  | { ok: true; plan: SkillPlan }
  | { ok: false; error: string };

export function resolveSkillPlan(command: NexusCommand): SkillPlanResult {
  if (command.command !== "run_skill") {
    return { ok: false, error: "Comando não é do tipo run_skill" };
  }

  const skill = getSkillById(command.args.skill_id);
  if (!skill) {
    return { ok: false, error: `Skill não encontrada: ${command.args.skill_id}` };
  }

  const normalizedInputs = normalizeInputs(skill, command.args.inputs);
  if (!normalizedInputs.ok) {
    return { ok: false, error: normalizedInputs.error };
  }

  const resolvedSteps: PlannedSkillStep[] = [];
  for (let index = 0; index < skill.steps.length; index += 1) {
    const step = skill.steps[index];
    const renderedArgs: Record<string, string | number | boolean> = {};
    for (const [argKey, rawTemplate] of Object.entries(step.argsTemplate)) {
      renderedArgs[argKey] = renderTemplate(rawTemplate, normalizedInputs.inputs);
    }

    const args = normalizeStepArgs(step.command, renderedArgs, skill);
    if (!args.ok) {
      return { ok: false, error: `Etapa ${index + 1}: ${args.error}` };
    }
    resolvedSteps.push({
      command: step.command,
      args: args.args,
    });
  }

  const effectiveMaxSteps = Math.min(skill.safety.maxSteps, GLOBAL_MAX_SKILL_STEPS);
  if (resolvedSteps.length > effectiveMaxSteps) {
    return {
      ok: false,
      error: `Skill excede limite de etapas (${resolvedSteps.length}/${effectiveMaxSteps})`,
    };
  }

  for (const step of resolvedSteps) {
    if (!skill.safety.allowedCommands.includes(step.command)) {
      return {
        ok: false,
        error: `Comando '${step.command}' fora da política de segurança da Skill`,
      };
    }
  }

  return {
    ok: true,
    plan: {
      skill,
      steps: resolvedSteps,
      timeoutMs: GLOBAL_SKILL_TIMEOUT_MS,
      requiresConfirmation: skill.safety.requiresConfirmation,
    },
  };
}

function normalizeInputs(
  skill: SkillDefinition,
  rawInputs: Record<string, string | number | boolean>
):
  | { ok: true; inputs: Record<string, string | number | boolean> }
  | { ok: false; error: string } {
  const normalized: Record<string, string | number | boolean> = {};
  const requiredTemplateKeys = extractTemplateInputKeys(skill);

  for (const inputDef of skill.inputs) {
    // Backward compatibility: ignore stale input definitions that are not used by any template.
    if (!requiredTemplateKeys.has(inputDef.key)) {
      continue;
    }

    const value = rawInputs[inputDef.key];
    if (value === undefined || value === null) {
      const inferred = inferMissingInput(skill, inputDef.key);
      if (inferred !== null) {
        normalized[inputDef.key] = inferred;
        continue;
      }
      if (inputDef.required) {
        return { ok: false, error: `Faltando input obrigatório: ${inputDef.key}` };
      }
      continue;
    }

    if (inputDef.type === "string") {
      const text = String(value).trim();
      if (!text && inputDef.required) {
        const inferred = inferMissingInput(skill, inputDef.key);
        if (inferred !== null) {
          normalized[inputDef.key] = inferred;
          continue;
        }
        return { ok: false, error: `Input '${inputDef.key}' não pode ser vazio` };
      }
      normalized[inputDef.key] = text;
      continue;
    }

    if (inputDef.type === "number") {
      const num = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(num)) {
        return { ok: false, error: `Input '${inputDef.key}' deve ser número` };
      }
      normalized[inputDef.key] = num;
      continue;
    }

    if (inputDef.type === "boolean") {
      if (typeof value === "boolean") {
        normalized[inputDef.key] = value;
        continue;
      }
      const text = String(value).trim().toLowerCase();
      if (text === "true" || text === "1" || text === "sim") {
        normalized[inputDef.key] = true;
        continue;
      }
      if (text === "false" || text === "0" || text === "nao" || text === "não") {
        normalized[inputDef.key] = false;
        continue;
      }
      return { ok: false, error: `Input '${inputDef.key}' deve ser boolean` };
    }
  }

  return { ok: true, inputs: normalized };
}

function normalizeStepArgs(
  command: CommandName,
  renderedArgs: Record<string, string | number | boolean>,
  skill: SkillDefinition
):
  | { ok: true; args: Record<string, string | number | boolean> }
  | { ok: false; error: string } {
  switch (command) {
    case "open_url": {
      const url = pickFirstString(renderedArgs, ["url"]);
      if (!url) return { ok: false, error: "URL ausente no passo open_url" };
      return { ok: true, args: { url } };
    }
    case "search_web": {
      const query = pickFirstString(renderedArgs, ["query", "q", "search"]);
      if (!query) return { ok: false, error: "query ausente no passo search_web" };
      return { ok: true, args: { query } };
    }
    case "create_folder": {
      const path = pickFirstString(renderedArgs, ["path", "folder", "directory"]);
      if (!path) return { ok: false, error: "path ausente no passo create_folder" };
      return { ok: true, args: { path } };
    }
    case "launch_app": {
      const rawName = pickFirstString(renderedArgs, [
        "name",
        "app_name",
        "app",
        "application",
        "program",
        "programa",
        "target",
        "cmd",
        "command",
        "path",
      ]) ?? detectLikelyLaunchTarget(skill);
      const name = normalizeLaunchTarget(rawName, skill);
      if (!name) return { ok: false, error: "name ausente no passo launch_app" };
      return { ok: true, args: { name } };
    }
    case "chat": {
      const message = pickFirstString(renderedArgs, ["message", "text", "prompt"]);
      if (!message) return { ok: false, error: "message ausente no passo chat" };
      return { ok: true, args: { message } };
    }
    case "run_skill":
      return { ok: false, error: "run_skill não é permitido dentro do plano resolvido" };
  }
}

function pickFirstString(
  values: Record<string, string | number | boolean>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = values[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (!text) continue;
    return text;
  }
  return null;
}

function extractTemplateInputKeys(skill: SkillDefinition): Set<string> {
  const set = new Set<string>();
  for (const step of skill.steps) {
    for (const template of collectRelevantTemplateValues(step.command, step.argsTemplate)) {
      const regex = /\{\{([a-zA-Z0-9_]+)\}\}/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(template)) !== null) {
        set.add(match[1]);
      }
    }
  }
  return set;
}

function collectRelevantTemplateValues(
  command: CommandName,
  argsTemplate: Record<string, string>
): string[] {
  switch (command) {
    case "open_url":
      return collectForKeys(argsTemplate, ["url"], []);
    case "search_web":
      return collectForKeys(argsTemplate, ["query"], ["q", "search"]);
    case "create_folder":
      return collectForKeys(argsTemplate, ["path"], ["folder", "directory"]);
    case "launch_app":
      return collectForKeys(
        argsTemplate,
        ["name"],
        ["app_name", "app", "application", "program", "programa", "target", "cmd", "command", "path"]
      );
    case "chat":
      return collectForKeys(argsTemplate, ["message"], ["text", "prompt"]);
    case "run_skill":
      return [];
  }
}

function collectForKeys(
  argsTemplate: Record<string, string>,
  primaryKeys: string[],
  aliases: string[]
): string[] {
  const values: string[] = [];
  for (const key of primaryKeys) {
    const primaryValue = argsTemplate[key];
    if (typeof primaryValue === "string" && primaryValue.trim()) {
      values.push(primaryValue);
      continue;
    }

    for (const alias of aliases) {
      const aliasValue = argsTemplate[alias];
      if (typeof aliasValue === "string" && aliasValue.trim()) {
        values.push(aliasValue);
        break;
      }
    }
  }
  return values;
}

function inferMissingInput(skill: SkillDefinition, inputKey: string): string | null {
  if (inputKey !== "name") return null;
  if (!skill.steps.some((step) => step.command === "launch_app")) return null;
  return detectLikelyLaunchTarget(skill);
}

function detectLikelyLaunchTarget(skill: SkillDefinition): string | null {
  const knownApps = [
    "steam",
    "vscode",
    "chrome",
    "edge",
    "firefox",
    "terminal",
    "notepad",
    "spotify",
    "slack",
    "discord",
    "calculator",
  ];

  const corpus = [
    skill.id,
    skill.name,
    skill.description,
    ...skill.triggers,
  ]
    .join(" ")
    .toLowerCase();

  for (const app of knownApps) {
    if (new RegExp(`\\b${escapeRegex(app)}\\b`).test(corpus)) {
      return app;
    }
  }

  const fromId = skill.id.match(/launch_app\.([a-z0-9_-]+)/i);
  if (fromId?.[1]) {
    const slug = fromId[1].replace(/_/g, "-");
    const parts = slug.split("-").filter(Boolean);
    const tail = parts.length > 0 ? parts[parts.length - 1] : "";
    if (tail && tail.length > 1) return tail;
  }

  return null;
}

function normalizeLaunchTarget(rawValue: string | null, skill: SkillDefinition): string | null {
  const fallback = detectLikelyLaunchTarget(skill);
  if (!rawValue) return fallback;

  const trimmed = rawValue.trim();
  if (!trimmed) return fallback;

  const lower = trimmed
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (
    lower.includes("\\.nexus\\skills")
    || lower.endsWith("\\skills")
    || lower.endsWith("/skills")
  ) {
    return fallback;
  }

  const looksLikePath =
    /[\\/]/.test(trimmed)
    || /\.(exe|cmd|bat|ps1|app|sh)$/i.test(trimmed);
  if (looksLikePath) {
    return trimmed;
  }

  const knownApps = [
    "steam",
    "vscode",
    "chrome",
    "edge",
    "firefox",
    "terminal",
    "notepad",
    "spotify",
    "slack",
    "discord",
    "calculator",
  ];
  for (const app of knownApps) {
    if (new RegExp(`\\b${escapeRegex(app)}\\b`).test(lower)) {
      return app;
    }
  }

  const cleaned = lower
    .replace(/^(abrir|abra|iniciar|inicie|executar|execute)\s+/, "")
    .replace(/^(o|a|um|uma)\s+/, "")
    .replace(/^(app|aplicativo|programa|script)\s+/, "")
    .trim();

  if (!cleaned) return fallback;

  return cleaned;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderTemplate(
  template: string,
  inputs: Record<string, string | number | boolean>
): string | number | boolean {
  const purePlaceholderMatch = template.match(/^\s*\{\{([a-zA-Z0-9_]+)\}\}\s*$/);
  if (purePlaceholderMatch) {
    const key = purePlaceholderMatch[1];
    const value = inputs[key];
    return value ?? "";
  }

  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_token, key) => {
    const value = inputs[key];
    return value === undefined ? "" : String(value);
  });
}

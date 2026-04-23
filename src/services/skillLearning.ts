import type { CommandName, NexusCommand } from "./parser";
import type { SkillDefinition } from "./skillRegistry";

export interface LearnedExecutionRecord {
  utterance: string;
  command: CommandName;
  args: Record<string, string | number | boolean>;
  timestamp: number;
}

export interface LearnedSkillDraft extends SkillDefinition {
  created_at: string;
  source: string;
  usage_count: number;
}

export interface LearningCandidate {
  draft: LearnedSkillDraft;
  reason: string;
}

const BLOCKED_COMMANDS: CommandName[] = ["chat", "run_skill"];

export function commandToLearnableRecord(
  utterance: string,
  command: NexusCommand
): LearnedExecutionRecord | null {
  if (BLOCKED_COMMANDS.includes(command.command)) {
    return null;
  }

  const args = command.args as Record<string, unknown>;
  const normalizedArgs: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(args)) {
    const type = typeof value;
    if (type === "string" || type === "number" || type === "boolean") {
      normalizedArgs[key] = value as string | number | boolean;
    }
  }

  if (Object.keys(normalizedArgs).length === 0) {
    return null;
  }

  return {
    utterance: utterance.trim(),
    command: command.command,
    args: normalizedArgs,
    timestamp: Date.now(),
  };
}

export function buildLearningCandidate(
  current: LearnedExecutionRecord,
  history: LearnedExecutionRecord[],
  existingSkillIds: string[]
): LearningCandidate | null {
  const sameCommandHistory = history
    .filter((item) => item.command === current.command)
    .slice(-5);

  const triggerSet = new Set<string>();
  for (const record of [...sameCommandHistory, current]) {
    const trigger = normalizeTrigger(record.utterance);
    if (trigger) {
      triggerSet.add(trigger);
    }
  }

  if (triggerSet.size === 0) {
    return null;
  }

  const inputKeys = Object.keys(current.args);
  if (inputKeys.length === 0) {
    return null;
  }

  const baseId = buildBaseSkillId(current);
  const uniqueId = ensureUniqueSkillId(baseId, existingSkillIds);

  const argsTemplate: Record<string, string> = {};
  const inputs = inputKeys.map((key) => {
    argsTemplate[key] = `{{${key}}}`;
    return {
      key,
      type: "string" as const,
      required: true,
      description: `Entrada para ${key}`,
    };
  });

  const draft: LearnedSkillDraft = {
    id: uniqueId,
    version: "1.0.0",
    name: buildSkillName(current.command),
    description: `Skill aprendida para executar '${current.command}' com entradas reutilizáveis.`,
    triggers: [...triggerSet].slice(0, 6),
    inputs,
    steps: [
      {
        command: current.command,
        argsTemplate,
      },
    ],
    safety: {
      requiresConfirmation: false,
      maxSteps: 1,
      allowedCommands: [current.command],
    },
    created_at: new Date().toISOString(),
    source: "learned-from-success",
    usage_count: 0,
  };

  const timesSeen = sameCommandHistory.length + 1;
  return {
    draft,
    reason: timesSeen > 1
      ? `Esse padrão apareceu ${timesSeen}x nesta sessão.`
      : "Esse comando pode virar atalho reutilizável.",
  };
}

function buildBaseSkillId(record: LearnedExecutionRecord): string {
  const slug = slugify(record.utterance).slice(0, 40);
  const suffix = slug || "custom";
  return `learned.${record.command}.${suffix}`;
}

function ensureUniqueSkillId(baseId: string, existingSkillIds: string[]): string {
  if (!existingSkillIds.includes(baseId)) {
    return baseId;
  }
  let counter = 2;
  while (existingSkillIds.includes(`${baseId}-${counter}`)) {
    counter += 1;
  }
  return `${baseId}-${counter}`;
}

function buildSkillName(command: CommandName): string {
  switch (command) {
    case "open_url":
      return "Abrir Site Personalizado";
    case "search_web":
      return "Pesquisa Personalizada";
    case "create_folder":
      return "Criar Pasta Personalizada";
    case "launch_app":
      return "Abrir App Personalizado";
    case "chat":
    case "run_skill":
      return "Skill Personalizada";
  }
}

function normalizeTrigger(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 80);
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

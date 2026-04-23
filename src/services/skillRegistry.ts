import { invoke } from "@tauri-apps/api/core";
import type { CommandName } from "./parser";

export type SkillInputType = "string" | "number" | "boolean";

export interface SkillInputDefinition {
  key: string;
  type: SkillInputType;
  required: boolean;
  description?: string;
}

export interface SkillStepDefinition {
  command: CommandName;
  argsTemplate: Record<string, string>;
}

export interface SkillSafetyDefinition {
  requiresConfirmation: boolean;
  maxSteps: number;
  allowedCommands: CommandName[];
}

export interface SkillDefinition {
  id: string;
  version: string;
  name: string;
  description: string;
  triggers: string[];
  inputs: SkillInputDefinition[];
  steps: SkillStepDefinition[];
  safety: SkillSafetyDefinition;
}

export interface RejectedSkill {
  source: string;
  id?: string;
  errors: string[];
}

export interface SkillRegistryResult {
  skills: SkillDefinition[];
  rejected: RejectedSkill[];
}

const IS_TAURI_RUNTIME = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const ALLOWED_COMMANDS: CommandName[] = [
  "open_url",
  "search_web",
  "create_folder",
  "launch_app",
  "chat",
];

const BUILTIN_SKILLS_RAW: unknown[] = [
  {
    id: "web.open-site",
    version: "1.0.0",
    name: "Abrir Site",
    description: "Abre uma URL informada pelo usuário.",
    triggers: ["abra o site", "abrir site", "open site"],
    inputs: [
      { key: "url", type: "string", required: true, description: "URL completa com https://" },
    ],
    steps: [
      { command: "open_url", argsTemplate: { url: "{{url}}" } },
    ],
    safety: {
      requiresConfirmation: false,
      maxSteps: 1,
      allowedCommands: ["open_url"],
    },
  },
  {
    id: "web.search-topic",
    version: "1.0.0",
    name: "Pesquisar Tema",
    description: "Pesquisa um assunto na web.",
    triggers: ["pesquise sobre", "buscar sobre", "procure por"],
    inputs: [
      { key: "query", type: "string", required: true, description: "Texto da pesquisa" },
    ],
    steps: [
      { command: "search_web", argsTemplate: { query: "{{query}}" } },
    ],
    safety: {
      requiresConfirmation: false,
      maxSteps: 1,
      allowedCommands: ["search_web"],
    },
  },
  {
    id: "files.create-folder-safe",
    version: "1.0.0",
    name: "Criar Pasta Segura",
    description: "Cria pasta em locais permitidos pelo Nexus.",
    triggers: ["crie uma pasta", "nova pasta", "create folder"],
    inputs: [
      { key: "path", type: "string", required: true, description: "Caminho alvo permitido" },
    ],
    steps: [
      { command: "create_folder", argsTemplate: { path: "{{path}}" } },
    ],
    safety: {
      requiresConfirmation: false,
      maxSteps: 1,
      allowedCommands: ["create_folder"],
    },
  },
  {
    id: "apps.launch-known-app",
    version: "1.0.0",
    name: "Abrir Programa",
    description: "Abre aplicativo, comando local ou script informado.",
    triggers: ["abra o programa", "inicie o app", "executar script"],
    inputs: [
      { key: "name", type: "string", required: true, description: "Nome, comando ou caminho do aplicativo/script" },
    ],
    steps: [
      { command: "launch_app", argsTemplate: { name: "{{name}}" } },
    ],
    safety: {
      requiresConfirmation: false,
      maxSteps: 1,
      allowedCommands: ["launch_app"],
    },
  },
  {
    id: "assistant.rewrite-text-ptbr",
    version: "1.0.0",
    name: "Reescrever Texto",
    description: "Reescreve texto em português claro.",
    triggers: ["reescreva", "melhore esse texto", "deixe mais claro"],
    inputs: [
      { key: "text", type: "string", required: true, description: "Texto de entrada" },
    ],
    steps: [
      { command: "chat", argsTemplate: { message: "Reescreva em pt-BR: {{text}}" } },
    ],
    safety: {
      requiresConfirmation: false,
      maxSteps: 1,
      allowedCommands: ["chat"],
    },
  },
  {
    id: "assistant.summarize-last-response",
    version: "1.0.0",
    name: "Resumir Resposta",
    description: "Gera resumo curto do último conteúdo.",
    triggers: ["resuma", "faça um resumo", "resumir resposta"],
    inputs: [
      { key: "text", type: "string", required: true, description: "Texto a resumir" },
    ],
    steps: [
      { command: "chat", argsTemplate: { message: "Resuma em pt-BR: {{text}}" } },
    ],
    safety: {
      requiresConfirmation: false,
      maxSteps: 1,
      allowedCommands: ["chat"],
    },
  },
];

let cachedRegistry: SkillRegistryResult | null = null;
const DISABLED_SKILLS_KEY = "nexus_disabled_skills";

export function getSkillRegistrySnapshot(): SkillRegistryResult {
  return cachedRegistry ?? { skills: [], rejected: [] };
}

export function getSkillById(id: string): SkillDefinition | null {
  const snapshot = getSkillRegistrySnapshot();
  const found = snapshot.skills.find((skill) => skill.id === id) ?? null;
  if (!found) return null;
  return isSkillEnabled(found.id) ? found : null;
}

export function buildSkillCatalogForPrompt(limit = 20): string {
  const snapshot = getSkillRegistrySnapshot();
  const activeSkills = snapshot.skills.filter((skill) => isSkillEnabled(skill.id));
  if (activeSkills.length === 0) {
    return "No skills available.";
  }

  const selected = activeSkills.slice(0, limit);
  return selected
    .map((skill) => {
      const triggers = skill.triggers.slice(0, 3).join(" | ");
      const inputs = skill.inputs.map((input) => `${input.key}:${input.type}`).join(", ");
      return `- ${skill.id} :: ${skill.description} :: triggers=${triggers} :: inputs=[${inputs}]`;
    })
    .join("\n");
}

export function getSkillStudioView(): Array<{ skill: SkillDefinition; enabled: boolean }> {
  const snapshot = getSkillRegistrySnapshot();
  return snapshot.skills.map((skill) => ({
    skill,
    enabled: isSkillEnabled(skill.id),
  }));
}

export function isSkillEnabled(skillId: string): boolean {
  const disabled = readDisabledSkillSet();
  return !disabled.has(skillId);
}

export function setSkillEnabled(skillId: string, enabled: boolean): void {
  const disabled = readDisabledSkillSet();
  if (enabled) {
    disabled.delete(skillId);
  } else {
    disabled.add(skillId);
  }
  writeDisabledSkillSet(disabled);
}

export async function initializeSkillRegistry(forceReload = false): Promise<SkillRegistryResult> {
  if (cachedRegistry && !forceReload) {
    return cachedRegistry;
  }

  const rejected: RejectedSkill[] = [];
  const accepted = new Map<string, SkillDefinition>();

  for (const raw of BUILTIN_SKILLS_RAW) {
    const parsed = validateSkillDefinition(raw);
    if (!parsed.ok) {
      rejected.push({ source: "builtin", id: parsed.id, errors: parsed.errors });
      continue;
    }
    mergeSkillVersion(accepted, parsed.skill);
  }

  const userSkillsRaw = await loadUserSkillsRaw();
  for (const raw of userSkillsRaw) {
    const parsed = validateSkillDefinition(raw);
    if (!parsed.ok) {
      rejected.push({ source: "user", id: parsed.id, errors: parsed.errors });
      continue;
    }
    mergeSkillVersion(accepted, parsed.skill);
  }

  const skills = [...accepted.values()].sort((a, b) => a.id.localeCompare(b.id));
  cachedRegistry = { skills, rejected };
  return cachedRegistry;
}

async function loadUserSkillsRaw(): Promise<unknown[]> {
  if (!IS_TAURI_RUNTIME) return [];
  try {
    return await invoke<unknown[]>("load_user_skills");
  } catch {
    return [];
  }
}

function mergeSkillVersion(target: Map<string, SkillDefinition>, incoming: SkillDefinition) {
  const existing = target.get(incoming.id);
  if (!existing) {
    target.set(incoming.id, incoming);
    return;
  }
  if (compareSemver(incoming.version, existing.version) > 0) {
    target.set(incoming.id, incoming);
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((part) => parseInt(part, 10));
  const pb = b.split(".").map((part) => parseInt(part, 10));
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i += 1) {
    const av = Number.isFinite(pa[i]) ? pa[i] : 0;
    const bv = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function validateSkillDefinition(raw: unknown):
  | { ok: true; skill: SkillDefinition }
  | { ok: false; id?: string; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: ["Skill deve ser um objeto JSON"] };
  }

  const id = readString(raw.id, "id", errors);
  const version = readString(raw.version, "version", errors);
  const name = readString(raw.name, "name", errors);
  const description = readString(raw.description, "description", errors);

  const triggers = readStringArray(raw.triggers, "triggers", errors);
  const inputs = readInputs(raw.inputs, errors);
  const steps = readSteps(raw.steps, errors);
  const safety = readSafety(raw.safety, errors);

  if (id && !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(id)) {
    errors.push("id inválido: usar lowercase/dígitos e separadores . _ -");
  }
  if (version && !/^\d+\.\d+\.\d+$/.test(version)) {
    errors.push("version inválida: usar semver ex. 1.0.0");
  }
  if (triggers.length === 0) {
    errors.push("triggers deve conter ao menos 1 frase");
  }
  if (steps.length === 0) {
    errors.push("steps deve conter ao menos 1 etapa");
  }

  if (safety) {
    if (steps.length > safety.maxSteps) {
      errors.push("steps excede safety.maxSteps");
    }
    for (const step of steps) {
      if (!safety.allowedCommands.includes(step.command)) {
        errors.push(`step command '${step.command}' fora de safety.allowedCommands`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, id: id || undefined, errors };
  }

  return {
    ok: true,
    skill: {
      id,
      version,
      name,
      description,
      triggers,
      inputs,
      steps,
      safety: safety as SkillSafetyDefinition,
    },
  };
}

function readInputs(value: unknown, errors: string[]): SkillInputDefinition[] {
  if (!Array.isArray(value)) {
    errors.push("inputs deve ser array");
    return [];
  }

  const parsed: SkillInputDefinition[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      errors.push("input inválido: item não é objeto");
      continue;
    }
    const key = readString(item.key, "inputs.key", errors);
    const typeRaw = readString(item.type, "inputs.type", errors);
    const required = typeof item.required === "boolean" ? item.required : true;
    const description = typeof item.description === "string" ? item.description.trim() : undefined;
    if (!["string", "number", "boolean"].includes(typeRaw)) {
      errors.push("inputs.type deve ser string|number|boolean");
      continue;
    }
    parsed.push({
      key,
      type: typeRaw as SkillInputType,
      required,
      description,
    });
  }

  return parsed;
}

function readSteps(value: unknown, errors: string[]): SkillStepDefinition[] {
  if (!Array.isArray(value)) {
    errors.push("steps deve ser array");
    return [];
  }

  const parsed: SkillStepDefinition[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      errors.push("step inválido: item não é objeto");
      continue;
    }

    const commandRaw = readString(item.command, "steps.command", errors);
    if (!ALLOWED_COMMANDS.includes(commandRaw as CommandName)) {
      errors.push(`steps.command inválido: ${commandRaw}`);
      continue;
    }

    if (!isRecord(item.argsTemplate)) {
      errors.push("steps.argsTemplate deve ser objeto");
      continue;
    }

    const argsTemplate: Record<string, string> = {};
    for (const [key, val] of Object.entries(item.argsTemplate)) {
      if (typeof val !== "string") {
        errors.push(`argsTemplate '${key}' deve ser string`);
        continue;
      }
      argsTemplate[key] = val;
    }

    parsed.push({
      command: commandRaw as CommandName,
      argsTemplate,
    });
  }

  return parsed;
}

function readSafety(value: unknown, errors: string[]): SkillSafetyDefinition | null {
  if (!isRecord(value)) {
    errors.push("safety deve ser objeto");
    return null;
  }

  const requiresConfirmation = typeof value.requiresConfirmation === "boolean"
    ? value.requiresConfirmation
    : false;

  const maxSteps = typeof value.maxSteps === "number" && Number.isFinite(value.maxSteps)
    ? Math.floor(value.maxSteps)
    : 0;
  if (maxSteps <= 0) {
    errors.push("safety.maxSteps deve ser inteiro > 0");
  }

  if (!Array.isArray(value.allowedCommands)) {
    errors.push("safety.allowedCommands deve ser array");
    return null;
  }

  const allowedCommands: CommandName[] = [];
  for (const item of value.allowedCommands) {
    if (typeof item !== "string" || !ALLOWED_COMMANDS.includes(item as CommandName)) {
      errors.push(`safety.allowedCommands contém comando inválido: ${String(item)}`);
      continue;
    }
    allowedCommands.push(item as CommandName);
  }

  if (allowedCommands.length === 0) {
    errors.push("safety.allowedCommands deve conter ao menos 1 comando");
  }

  return {
    requiresConfirmation,
    maxSteps,
    allowedCommands,
  };
}

function readString(value: unknown, field: string, errors: string[]): string {
  if (typeof value !== "string") {
    errors.push(`${field} deve ser string`);
    return "";
  }
  const normalized = value.trim();
  if (!normalized) {
    errors.push(`${field} não pode ser vazio`);
  }
  return normalized;
}

function readStringArray(value: unknown, field: string, errors: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${field} deve ser array`);
    return [];
  }

  const parsed: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      errors.push(`${field} deve conter apenas strings`);
      continue;
    }
    const normalized = item.trim();
    if (!normalized) {
      errors.push(`${field} contém string vazia`);
      continue;
    }
    parsed.push(normalized);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDisabledSkillSet(): Set<string> {
  if (typeof window === "undefined") return new Set<string>();
  const raw = window.localStorage.getItem(DISABLED_SKILLS_KEY);
  if (!raw) return new Set<string>();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((item) => typeof item === "string"));
  } catch {
    return new Set<string>();
  }
}

function writeDisabledSkillSet(set: Set<string>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(DISABLED_SKILLS_KEY, JSON.stringify([...set]));
}

import { invoke } from "@tauri-apps/api/core";
import type { CommandName } from "./parser";
import type { LearnedSkillDraft } from "./skillLearning";
import { config } from "./config";

type StudioCommand = Exclude<CommandName, "run_skill">;
type InputType = "string" | "number" | "boolean";

const MAX_STEPS = 4;

const STUDIO_COMMANDS: StudioCommand[] = [
  "open_url",
  "search_web",
  "create_folder",
  "launch_app",
  "chat",
];

const REQUIRED_ARGS: Record<StudioCommand, string[]> = {
  open_url: ["url"],
  search_web: ["query"],
  create_folder: ["path"],
  launch_app: ["name"],
  chat: ["message"],
};

const ARG_ALIASES: Partial<Record<StudioCommand, Record<string, string[]>>> = {
  search_web: { query: ["q", "search", "tema"] },
  create_folder: { path: ["folder", "dir", "directory"] },
  launch_app: {
    name: ["app_name", "app", "application", "program", "programa", "target", "cmd", "command", "path"],
  },
  chat: { message: ["text", "prompt"] },
};

const KNOWN_APP_TARGETS = [
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

const IS_TAURI_RUNTIME = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface DraftInput {
  key: string;
  type: InputType;
  required: boolean;
  description?: string;
}

interface DraftStep {
  command: StudioCommand;
  argsTemplate: Record<string, string>;
}

interface RawModelStep {
  command?: unknown;
  argsTemplate?: unknown;
}

interface RawModelInput {
  key?: unknown;
  type?: unknown;
  required?: unknown;
  description?: unknown;
}

interface RawModelDraft {
  name?: unknown;
  description?: unknown;
  triggers?: unknown;
  inputs?: unknown;
  steps?: unknown;
  requires_confirmation?: unknown;
}

export interface SkillPackImportResult {
  imported: number;
  updated: number;
  skipped: number;
}

export interface GuidedSkillPreview {
  draft: LearnedSkillDraft;
  generationMode: "llm" | "fallback";
  summary: {
    title: string;
    triggerPhrase: string;
    stepLines: string[];
  };
}

export async function exportSkillPackJson(): Promise<string> {
  const pack = await invoke<Record<string, unknown>>("export_skill_pack");
  return JSON.stringify(pack, null, 2);
}

export async function importSkillPackJson(rawJson: string): Promise<SkillPackImportResult> {
  const parsed = JSON.parse(rawJson);
  return invoke<SkillPackImportResult>("import_skill_pack", { pack: parsed });
}

export async function updateUserSkill(draft: LearnedSkillDraft): Promise<void> {
  await invoke("update_user_skill", { skill: draft });
}

export async function createUserSkill(draft: LearnedSkillDraft): Promise<void> {
  await invoke("save_user_skill", { skill: draft });
}

export async function openSkillsDirectory(): Promise<string> {
  return invoke<string>("open_skills_directory");
}

export async function createSkillDraftFromPrompt(
  prompt: string,
  existingIds: string[]
): Promise<LearnedSkillDraft> {
  const preview = await createGuidedSkillFromPrompt(prompt, existingIds);
  return preview.draft;
}

export async function createGuidedSkillFromPrompt(
  prompt: string,
  existingIds: string[],
  activationHint = ""
): Promise<GuidedSkillPreview> {
  const clean = prompt.trim();
  const cleanActivationHint = activationHint.trim();
  if (!clean) {
    throw new Error("Pedido vazio para gerar Skill.");
  }

  const llmDraft = await tryBuildDraftWithLLM(clean, existingIds, cleanActivationHint);
  if (llmDraft) {
    const enriched = await enrichLaunchTargets(llmDraft, clean, cleanActivationHint);
    return {
      draft: enriched,
      generationMode: "llm",
      summary: buildPreviewSummary(enriched, cleanActivationHint),
    };
  }

  const fallback = createSkillDraftFallback(clean, existingIds, cleanActivationHint);
  const enrichedFallback = await enrichLaunchTargets(fallback, clean, cleanActivationHint);
  return {
    draft: enrichedFallback,
    generationMode: "fallback",
    summary: buildPreviewSummary(enrichedFallback, cleanActivationHint),
  };
}

export async function createRecoverySkillFromFailure(
  request: string,
  failedTarget: string,
  failureMessage: string,
  existingIds: string[]
): Promise<GuidedSkillPreview | null> {
  const cleanRequest = request.trim();
  const cleanFailedTarget = failedTarget.trim();
  if (!cleanRequest) return null;

  const fallbackDraft = await createRecoveryFallbackDraft(
    cleanRequest,
    cleanFailedTarget,
    existingIds
  );
  const llmDraft = await tryBuildRecoveryDraftWithLLM(
    cleanRequest,
    cleanFailedTarget,
    failureMessage.trim(),
    existingIds
  );
  const baseDraft = llmDraft ?? fallbackDraft;
  const stabilized = await stabilizeRecoveryDraft(
    baseDraft,
    fallbackDraft,
    cleanRequest,
    cleanFailedTarget
  );
  const enriched = await enrichLaunchTargets(stabilized, cleanRequest, cleanRequest);
  const finalized = concretizeRecoveryDraft(enriched, cleanRequest, cleanFailedTarget);
  return {
    draft: finalized,
    generationMode: llmDraft ? "llm" : "fallback",
    summary: buildPreviewSummary(finalized, cleanRequest),
  };
}

async function tryBuildDraftWithLLM(
  prompt: string,
  existingIds: string[],
  activationHint: string
): Promise<LearnedSkillDraft | null> {
  if (!config.isConfigured()) return null;

  const apiKey = config.getApiKey();
  const model = config.getModel();
  const baseUrl = config.getBaseUrl();

  const systemPrompt = `Você cria Skills para usuários finais do Nexus.
Responda APENAS JSON bruto válido com este schema:
{
  "name":"string",
  "description":"string",
  "triggers":["string"],
  "inputs":[
    {"key":"string","type":"string|number|boolean","required":true,"description":"string"}
  ],
  "steps":[
    {
      "command":"open_url|search_web|create_folder|launch_app|chat",
      "argsTemplate":{"arg":"valor ou {{input_key}}"}
    }
  ],
  "requires_confirmation":false
}

Regras:
- Não use markdown.
- Skill pode ter 1 etapa ou cadeia de etapas (até 4).
- steps precisa estar em ordem de execução.
- Para URL explícita (http/https), inclua etapa open_url.
- launch_app pode receber nome de app conhecido, comando local ou caminho de script/aplicativo.
- triggers: frases naturais em pt-BR.
- Evite termos técnicos; escreva para usuário comum.`;

  const userPrompt = [
    `Pedido: "${prompt}"`,
    activationHint ? `Frase preferida de ativação: "${activationHint}"` : "",
    "Monte uma Skill funcional para esse pedido.",
  ]
    .filter(Boolean)
    .join("\n");

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/nexus-app",
      "X-Title": "Nexus Skill Studio",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 900,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }

  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return null;
  }

  return normalizeDraftFromModel(parsed, prompt, existingIds, activationHint, "guided-studio-llm");
}

async function tryBuildRecoveryDraftWithLLM(
  request: string,
  failedTarget: string,
  failureMessage: string,
  existingIds: string[]
): Promise<LearnedSkillDraft | null> {
  if (!config.isConfigured()) return null;

  const apiKey = config.getApiKey();
  const model = config.getModel();
  const baseUrl = config.getBaseUrl();

  const systemPrompt = `Você é um especialista em recuperação de automações no Nexus.
O usuário tentou abrir algo e falhou. Gere uma Skill de recuperação para chegar no objetivo.
Responda APENAS JSON bruto válido com este schema:
{
  "name":"string",
  "description":"string",
  "triggers":["string"],
  "inputs":[],
  "steps":[
    {
      "command":"open_url|search_web|create_folder|launch_app|chat",
      "argsTemplate":{"arg":"valor concreto"}
    }
  ],
  "requires_confirmation":false
}

Regras obrigatórias:
- Não use placeholders {{...}}.
- Nunca use https://example.com ou URL genérica.
- steps pode ter cadeia de ações (até 4).
- Se for jogo/aplicativo de plataforma, você pode abrir launcher e depois protocolo/URL do item.
- Se não conseguir inferir o app exato, termine com search_web usando o pedido do usuário.
- Não use markdown.`;

  const userPrompt = [
    `Pedido original: "${request}"`,
    `Alvo que falhou: "${failedTarget || "desconhecido"}"`,
    `Erro retornado: "${failureMessage || "sem detalhes"}"`,
    "Gere uma Skill de recuperação para tentar novamente sem pedir dados técnicos ao usuário.",
  ].join("\n");

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/nexus-app",
      "X-Title": "Nexus Skill Recovery",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 900,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  if (typeof raw !== "string" || !raw.trim()) return null;

  const parsed = parseJsonObject(raw);
  if (!parsed) return null;

  const draft = normalizeDraftFromModel(
    parsed,
    request,
    existingIds,
    request,
    "guided-recovery-llm"
  );
  return draft;
}

async function createRecoveryFallbackDraft(
  request: string,
  failedTarget: string,
  existingIds: string[]
): Promise<LearnedSkillDraft> {
  const cleanRequest = request.trim();
  const cleanFailedTarget = failedTarget.trim();
  const likelyGameIntent = isLikelyGameIntent(cleanRequest, cleanFailedTarget);
  const explicitUrl = extractUrl(cleanRequest);
  const explicitTarget = detectExplicitLaunchTarget(`${cleanRequest} ${cleanFailedTarget}`.trim());
  const resolvedTarget = explicitTarget ? await resolveLaunchTarget(explicitTarget) : null;
  const steps: DraftStep[] = [];

  if (resolvedTarget) {
    steps.push({
      command: "launch_app",
      argsTemplate: { name: resolvedTarget },
    });
  } else if (explicitTarget && !likelyGameIntent) {
    steps.push({
      command: "launch_app",
      argsTemplate: { name: explicitTarget },
    });
  }

  if (explicitUrl) {
    steps.push({
      command: "open_url",
      argsTemplate: { url: explicitUrl },
    });
  } else if (likelyGameIntent) {
    if (!steps.some((step) => step.command === "launch_app")) {
      steps.push({
        command: "launch_app",
        argsTemplate: { name: "steam" },
      });
    }
    steps.push({
      command: "search_web",
      argsTemplate: { query: `${cleanRequest} steam` },
    });
  } else {
    steps.push({
      command: "search_web",
      argsTemplate: { query: cleanRequest },
    });
  }

  const boundedSteps = steps.slice(0, MAX_STEPS);
  const idBase = buildGuidedSkillId(
    cleanRequest || cleanFailedTarget || "recovery",
    boundedSteps[0]?.command ?? "search_web"
  );
  const id = ensureUniqueId(idBase, existingIds);
  const allowedCommands = [...new Set(boundedSteps.map((step) => step.command))];

  return {
    id,
    version: "1.0.0",
    name: "Recuperação Automática",
    description: "Skill criada automaticamente para recuperar um comando que falhou.",
    triggers: [cleanRequest.slice(0, 90) || "recuperar comando"],
    inputs: [],
    steps: boundedSteps.length ? boundedSteps : [{
      command: "search_web",
      argsTemplate: { query: cleanRequest || cleanFailedTarget || "abrir aplicativo" },
    }],
    safety: {
      requiresConfirmation: false,
      maxSteps: Math.max(1, boundedSteps.length),
      allowedCommands: allowedCommands.length ? allowedCommands : ["search_web"],
    },
    created_at: new Date().toISOString(),
    source: "guided-recovery-fallback",
    usage_count: 0,
  };
}

async function stabilizeRecoveryDraft(
  primary: LearnedSkillDraft,
  fallback: LearnedSkillDraft,
  request: string,
  failedTarget: string
): Promise<LearnedSkillDraft> {
  const next: LearnedSkillDraft = {
    ...primary,
    triggers: [...primary.triggers],
    inputs: [...primary.inputs],
    steps: primary.steps.map((step) => ({
      command: step.command,
      argsTemplate: { ...step.argsTemplate },
    })),
    safety: {
      ...primary.safety,
      allowedCommands: [...primary.safety.allowedCommands],
    },
  };

  const likelyGameIntent = isLikelyGameIntent(request, failedTarget);
  const fallbackLaunch = fallback.steps.find((step) => step.command === "launch_app");

  if (!next.steps.some((step) => step.command === "launch_app") && fallbackLaunch) {
    next.steps.unshift({
      command: "launch_app",
      argsTemplate: { ...fallbackLaunch.argsTemplate },
    });
  }

  let launchStep = next.steps.find((step) => step.command === "launch_app");
  const launchHint = detectExplicitLaunchTarget(`${request} ${failedTarget}`.trim())
    || failedTarget.trim()
    || request.trim();

  if (!launchStep && launchHint) {
    launchStep = {
      command: "launch_app",
      argsTemplate: { name: launchHint },
    };
    next.steps.unshift(launchStep);
  }

  if (launchStep) {
    const rawName = (launchStep.argsTemplate.name ?? "").trim();
    const candidate = (!rawName || containsPlaceholder(rawName))
      ? launchHint
      : rawName;

    if (candidate) {
      const resolved = await resolveLaunchTarget(candidate);
      if (resolved) {
        launchStep.argsTemplate.name = resolved;
      } else if (likelyGameIntent) {
        launchStep.argsTemplate.name = "steam";
      } else {
        launchStep.argsTemplate.name = candidate;
      }
    } else if (likelyGameIntent) {
      launchStep.argsTemplate.name = "steam";
    }
  }

  if (likelyGameIntent) {
    if (!next.steps.some((step) => step.command === "launch_app")) {
      next.steps.unshift({
        command: "launch_app",
        argsTemplate: { name: "steam" },
      });
    }
    if (!next.steps.some((step) => step.command === "search_web")) {
      next.steps.push({
        command: "search_web",
        argsTemplate: { query: `${request} steam` },
      });
    }
  }

  next.steps = next.steps.slice(0, MAX_STEPS);
  next.inputs = [];
  const allowedCommands = [...new Set(next.steps.map((step) => step.command))];
  next.safety = {
    ...next.safety,
    maxSteps: Math.max(1, next.steps.length),
    allowedCommands: allowedCommands.length ? allowedCommands : ["search_web"],
  };

  return next;
}

function normalizeDraftFromModel(
  raw: RawModelDraft,
  prompt: string,
  existingIds: string[],
  activationHint: string,
  source: string
): LearnedSkillDraft {
  const explicitUrl = extractUrl(prompt);
  const explicitLaunchTarget = detectExplicitLaunchTarget(`${activationHint} ${prompt}`.trim());
  const fallback = createSkillDraftFallback(prompt, existingIds, activationHint);
  const fallbackSteps = toDraftSteps(fallback.steps);

  const steps = normalizeSteps(raw.steps, explicitUrl, fallbackSteps).slice(0, MAX_STEPS);
  applyExplicitLaunchTarget(steps, explicitLaunchTarget);
  const inputs = normalizeInputs(raw.inputs, steps, fallback.inputs);
  const triggers = normalizeTriggers(raw.triggers, prompt, activationHint, fallback.triggers);

  const name = readNonEmptyString(raw.name) || fallback.name;
  const description = readNonEmptyString(raw.description) || fallback.description;
  const requiresConfirmation = typeof raw.requires_confirmation === "boolean"
    ? raw.requires_confirmation
    : includesSensitiveStep(steps);

  const idBase = buildGuidedSkillId(name || prompt, steps[0]?.command ?? "chat");
  const id = ensureUniqueId(idBase, existingIds);
  const allowedCommands = [...new Set(steps.map((step) => step.command))];

  return {
    id,
    version: "1.0.0",
    name,
    description,
    triggers,
    inputs,
    steps,
    safety: {
      requiresConfirmation,
      maxSteps: Math.max(1, steps.length),
      allowedCommands: allowedCommands.length ? allowedCommands : ["chat"],
    },
    created_at: new Date().toISOString(),
    source,
    usage_count: 0,
  };
}

function createSkillDraftFallback(
  prompt: string,
  existingIds: string[],
  activationHint: string
): LearnedSkillDraft {
  const clean = prompt.trim();
  const lower = clean.toLowerCase();
  const explicitUrl = extractUrl(clean);
  const explicitLaunchTarget = detectExplicitLaunchTarget(`${activationHint} ${clean}`.trim());
  const steps: DraftStep[] = [];
  const inputs: DraftInput[] = [];

  if (explicitUrl) {
    steps.push({
      command: "open_url",
      argsTemplate: { url: explicitUrl },
    });
  } else if (mentionsSearch(lower)) {
    addInputIfMissing(inputs, "query", "string", "Assunto para pesquisar");
    steps.push({
      command: "search_web",
      argsTemplate: { query: "{{query}}" },
    });
  } else if (mentionsFolder(lower)) {
    addInputIfMissing(inputs, "path", "string", "Pasta a ser criada");
    steps.push({
      command: "create_folder",
      argsTemplate: { path: "{{path}}" },
    });
  } else if (mentionsLaunchApp(lower)) {
    addInputIfMissing(inputs, "name", "string", "App, comando ou script para abrir");
    steps.push({
      command: "launch_app",
      argsTemplate: { name: "{{name}}" },
    });
  } else {
    addInputIfMissing(inputs, "message", "string", "Mensagem para o Nexus");
    steps.push({
      command: "chat",
      argsTemplate: { message: "{{message}}" },
    });
  }

  if (mentionsLaunchApp(lower) && mentionsSearch(lower) && steps.length < MAX_STEPS) {
    if (!steps.some((step) => step.command === "launch_app")) {
      addInputIfMissing(inputs, "name", "string", "App, comando ou script para abrir");
      steps.unshift({
        command: "launch_app",
        argsTemplate: { name: "{{name}}" },
      });
    }
    if (!steps.some((step) => step.command === "search_web")) {
      addInputIfMissing(inputs, "query", "string", "Assunto para pesquisar");
      steps.push({
        command: "search_web",
        argsTemplate: { query: "{{query}}" },
      });
    }
  }

  applyExplicitLaunchTarget(steps, explicitLaunchTarget);

  const firstCommand = steps[0]?.command ?? "chat";
  const idBase = buildGuidedSkillId(clean, firstCommand);
  const id = ensureUniqueId(idBase, existingIds);
  const trigger = activationHint.trim() || clean.slice(0, 80) || "minha skill";
  const allowedCommands = [...new Set(steps.map((step) => step.command))];

  return {
    id,
    version: "1.0.0",
    name: buildFriendlyName(firstCommand),
    description: buildFriendlyDescription(steps),
    triggers: [trigger],
    inputs,
    steps,
    safety: {
      requiresConfirmation: includesSensitiveStep(steps),
      maxSteps: Math.max(1, steps.length),
      allowedCommands,
    },
    created_at: new Date().toISOString(),
    source: "guided-studio-fallback",
    usage_count: 0,
  };
}

function normalizeSteps(
  value: unknown,
  explicitUrl: string | null,
  fallback: DraftStep[]
): DraftStep[] {
  const rawSteps = Array.isArray(value) ? value as RawModelStep[] : [];
  const steps: DraftStep[] = [];

  for (const rawStep of rawSteps) {
    if (!rawStep || typeof rawStep !== "object") continue;
    const command = parseStudioCommand(rawStep.command);
    if (!command) continue;

    const argsTemplate = normalizeArgsTemplate(rawStep.argsTemplate);
    const completedArgs = ensureRequiredArgs(command, argsTemplate);
    steps.push({ command, argsTemplate: completedArgs });
    if (steps.length >= MAX_STEPS) break;
  }

  const resolved = steps.length ? steps : [...fallback];

  if (explicitUrl) {
    const hasExplicitOpenStep = resolved.some((step) => step.command === "open_url");
    if (!hasExplicitOpenStep) {
      resolved.unshift({
        command: "open_url",
        argsTemplate: { url: explicitUrl },
      });
    } else {
      for (const step of resolved) {
        if (step.command !== "open_url") continue;
        step.argsTemplate.url = explicitUrl;
        break;
      }
    }
  }

  return resolved.slice(0, MAX_STEPS);
}

function normalizeInputs(
  value: unknown,
  steps: DraftStep[],
  fallback: DraftInput[]
): DraftInput[] {
  const rawInputs = Array.isArray(value) ? value as RawModelInput[] : [];
  const inputs: DraftInput[] = [];
  const placeholders = extractPlaceholdersFromSteps(steps);

  for (const rawInput of rawInputs) {
    if (!rawInput || typeof rawInput !== "object") continue;
    const key = sanitizeInputKey(rawInput.key);
    if (!key) continue;
    const type = parseInputType(rawInput.type);
    const required = typeof rawInput.required === "boolean" ? rawInput.required : true;
    const description = readNonEmptyString(rawInput.description) || `Entrada para ${key}`;
    addInputIfMissing(inputs, key, type, description, required);
  }

  for (const key of placeholders) {
    addInputIfMissing(inputs, key, "string", `Entrada para ${key}`);
  }

  if (inputs.length === 0) {
    for (const item of fallback) {
      addInputIfMissing(inputs, item.key, item.type, item.description, item.required);
    }
  }

  if (placeholders.size === 0) {
    return [];
  }

  return inputs.filter((input) => placeholders.has(input.key));
}

function normalizeTriggers(
  value: unknown,
  prompt: string,
  activationHint: string,
  fallback: string[]
): string[] {
  const triggerSet = new Set<string>();
  const parsed = Array.isArray(value) ? value : [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const clean = item.trim().slice(0, 90);
    if (!clean) continue;
    triggerSet.add(clean);
    if (triggerSet.size >= 6) break;
  }

  if (activationHint.trim()) {
    triggerSet.add(activationHint.trim().slice(0, 90));
  }
  if (triggerSet.size === 0) {
    triggerSet.add(prompt.trim().slice(0, 90));
  }
  if (triggerSet.size === 0) {
    for (const item of fallback) {
      if (item.trim()) triggerSet.add(item.trim().slice(0, 90));
      if (triggerSet.size >= 6) break;
    }
  }

  return [...triggerSet].slice(0, 6);
}

function ensureRequiredArgs(
  command: StudioCommand,
  argsTemplate: Record<string, string>
): Record<string, string> {
  const result = { ...argsTemplate };
  const required = REQUIRED_ARGS[command];
  const defaultKey = inferInputKey(command);
  const aliasMap = ARG_ALIASES[command] ?? {};

  for (const key of required) {
    const current = readRequiredValue(result, key, aliasMap[key] ?? []);
    if (current) {
      result[key] = current;
      continue;
    }
    if (command === "open_url") {
      result[key] = "{{url}}";
      continue;
    }
    result[key] = `{{${defaultKey}}}`;
  }

  const filtered: Record<string, string> = {};
  for (const key of required) {
    const value = result[key];
    if (typeof value === "string" && value.trim()) {
      filtered[key] = value.trim();
    }
  }
  return filtered;
}

function readRequiredValue(
  argsTemplate: Record<string, string>,
  key: string,
  aliases: string[]
): string | null {
  const direct = argsTemplate[key];
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  for (const alias of aliases) {
    const value = argsTemplate[alias];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function normalizeArgsTemplate(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const args: Record<string, string> = {};
  for (const [arg, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") continue;
    const cleanArg = arg.trim();
    const cleanValue = raw.trim();
    if (!cleanArg || !cleanValue) continue;
    args[cleanArg] = cleanValue;
  }
  return args;
}

function parseStudioCommand(value: unknown): StudioCommand | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return STUDIO_COMMANDS.includes(normalized as StudioCommand)
    ? (normalized as StudioCommand)
    : null;
}

function toDraftSteps(
  steps: Array<{ command: CommandName; argsTemplate: Record<string, string> }>
): DraftStep[] {
  const normalized: DraftStep[] = [];
  for (const step of steps) {
    const command = parseStudioCommand(step.command);
    if (!command) continue;
    normalized.push({
      command,
      argsTemplate: step.argsTemplate,
    });
  }
  return normalized;
}

function parseInputType(value: unknown): InputType {
  if (value === "number") return "number";
  if (value === "boolean") return "boolean";
  return "string";
}

function extractPlaceholdersFromSteps(steps: DraftStep[]): Set<string> {
  const set = new Set<string>();
  for (const step of steps) {
    for (const rawTemplate of Object.values(step.argsTemplate)) {
      for (const key of extractPlaceholders(rawTemplate)) {
        set.add(key);
      }
    }
  }
  return set;
}

function extractPlaceholders(template: string): string[] {
  const found: string[] = [];
  const regex = /\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(template)) !== null) {
    found.push(match[1]);
  }
  return found;
}

function addInputIfMissing(
  inputs: DraftInput[],
  key: string,
  type: InputType,
  description = "",
  required = true
) {
  if (inputs.some((input) => input.key === key)) return;
  inputs.push({
    key,
    type,
    required,
    description: description || `Entrada para ${key}`,
  });
}

function sanitizeInputKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[^a-zA-Z0-9_]/g, "_");
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(normalized)) return null;
  return normalized;
}

function includesSensitiveStep(steps: DraftStep[]): boolean {
  return steps.some((step) => step.command === "create_folder");
}

function buildGuidedSkillId(seed: string, command: StudioCommand): string {
  return `guided.${command}.${slugify(seed).slice(0, 36) || "custom"}`;
}

function ensureUniqueId(base: string, existingIds: string[]): string {
  if (!existingIds.includes(base)) return base;
  let suffix = 2;
  while (existingIds.includes(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function inferInputKey(command: StudioCommand): string {
  switch (command) {
    case "open_url":
      return "url";
    case "search_web":
      return "query";
    case "create_folder":
      return "path";
    case "launch_app":
      return "name";
    case "chat":
      return "message";
  }
}

function buildFriendlyName(command: StudioCommand): string {
  switch (command) {
    case "open_url":
      return "Abrir uma página";
    case "search_web":
      return "Pesquisar na web";
    case "create_folder":
      return "Criar pasta";
    case "launch_app":
      return "Abrir programa";
    case "chat":
      return "Responder no Nexus";
  }
}

function buildFriendlyDescription(steps: DraftStep[]): string {
  if (steps.length <= 1) {
    return `Skill com ação única: ${buildStepLabel(steps[0])}.`;
  }
  return `Skill com fluxo em ${steps.length} etapas.`;
}

function buildPreviewSummary(
  draft: LearnedSkillDraft,
  activationHint: string
): GuidedSkillPreview["summary"] {
  const triggerPhrase = activationHint.trim() || draft.triggers[0] || "sem frase definida";
  const normalizedSteps = toDraftSteps(draft.steps);
  return {
    title: draft.name,
    triggerPhrase,
    stepLines: normalizedSteps.map((step, idx) => `${idx + 1}. ${buildStepLabel(step)}`),
  };
}

function buildStepLabel(step: { command: StudioCommand; argsTemplate: Record<string, string> }): string {
  switch (step.command) {
    case "open_url":
      return `Abrir a página ${step.argsTemplate.url ?? ""}`.trim();
    case "search_web":
      return `Pesquisar por ${step.argsTemplate.query ?? ""}`.trim();
    case "create_folder":
      return `Criar a pasta ${step.argsTemplate.path ?? ""}`.trim();
    case "launch_app":
      return `Abrir programa/script ${step.argsTemplate.name ?? ""}`.trim();
    case "chat":
      return "Gerar resposta no Nexus";
  }
}

function applyExplicitLaunchTarget(steps: DraftStep[], target: string | null): void {
  if (!target) return;
  for (const step of steps) {
    if (step.command !== "launch_app") continue;
    const current = step.argsTemplate.name?.trim() ?? "";
    if (!current || /\{\{[^}]+\}\}/.test(current)) {
      step.argsTemplate.name = target;
    }
  }
}

async function enrichLaunchTargets(
  draft: LearnedSkillDraft,
  prompt: string,
  activationHint: string
): Promise<LearnedSkillDraft> {
  const nextDraft: LearnedSkillDraft = {
    ...draft,
    steps: draft.steps.map((step) => ({
      command: step.command,
      argsTemplate: { ...step.argsTemplate },
    })),
    inputs: draft.inputs.map((input) => ({ ...input })),
  };

  const hintTarget = detectExplicitLaunchTarget(`${activationHint} ${prompt}`.trim());

  for (const step of nextDraft.steps) {
    if (step.command !== "launch_app") continue;
    let target = step.argsTemplate.name?.trim() ?? "";
    if (!target || /\{\{[^}]+\}\}/.test(target)) {
      target = hintTarget ?? target;
    }
    if (!target || /\{\{[^}]+\}\}/.test(target)) continue;

    const resolved = await resolveLaunchTarget(target);
    if (resolved && resolved.trim()) {
      step.argsTemplate.name = resolved.trim();
    } else {
      step.argsTemplate.name = target.trim();
    }
  }

  const placeholders = extractPlaceholdersFromSteps(toDraftSteps(nextDraft.steps));
  nextDraft.inputs = nextDraft.inputs.filter((input) => placeholders.has(input.key));
  nextDraft.safety.allowedCommands = [
    ...new Set(nextDraft.steps.map((step) => step.command).filter((cmd): cmd is StudioCommand => cmd !== "run_skill")),
  ];

  return nextDraft;
}

function concretizeRecoveryDraft(
  draft: LearnedSkillDraft,
  request: string,
  failedTarget: string
): LearnedSkillDraft {
  const explicitUrl = extractUrl(request);
  const launchHint = detectExplicitLaunchTarget(`${request} ${failedTarget}`.trim());
  const normalizedSteps: DraftStep[] = [];

  for (const originalStep of draft.steps) {
    const command = parseStudioCommand(originalStep.command);
    if (!command) continue;
    const requiredArgs = ensureRequiredArgs(command, originalStep.argsTemplate);
    const argsTemplate = { ...requiredArgs };

    switch (command) {
      case "launch_app": {
        const raw = argsTemplate.name ?? "";
        if (!raw || containsPlaceholder(raw)) {
          argsTemplate.name = launchHint || failedTarget || "steam";
        }
        break;
      }
      case "open_url": {
        const raw = argsTemplate.url ?? "";
        if (!raw || containsPlaceholder(raw) || isGenericPlaceholderUrl(raw)) {
          argsTemplate.url = explicitUrl || buildSearchUrl(request);
        }
        break;
      }
      case "search_web": {
        const raw = argsTemplate.query ?? "";
        if (!raw || containsPlaceholder(raw)) {
          argsTemplate.query = request;
        }
        break;
      }
      case "create_folder": {
        const raw = argsTemplate.path ?? "";
        if (!raw || containsPlaceholder(raw)) {
          argsTemplate.path = `~/Desktop/${slugify(request).slice(0, 24) || "nexus-task"}`;
        }
        break;
      }
      case "chat": {
        const raw = argsTemplate.message ?? "";
        if (!raw || containsPlaceholder(raw)) {
          argsTemplate.message = `Vou tentar te ajudar com: ${request}`;
        }
        break;
      }
    }

    normalizedSteps.push({
      command,
      argsTemplate,
    });
    if (normalizedSteps.length >= MAX_STEPS) break;
  }

  if (normalizedSteps.length === 0) {
    normalizedSteps.push({
      command: "search_web",
      argsTemplate: { query: request },
    });
  }

  const safeTriggers = [request.trim().slice(0, 90)].filter(Boolean);
  const allowedCommands = [...new Set(normalizedSteps.map((step) => step.command))];

  return {
    ...draft,
    triggers: safeTriggers.length ? safeTriggers : draft.triggers,
    inputs: [],
    steps: normalizedSteps,
    safety: {
      ...draft.safety,
      maxSteps: Math.max(1, normalizedSteps.length),
      allowedCommands,
    },
    source: "guided-recovery-llm",
  };
}

function containsPlaceholder(value: string): boolean {
  return /\{\{[^}]+\}\}/.test(value);
}

function isGenericPlaceholderUrl(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "https://example.com"
    || normalized === "http://example.com"
    || normalized === "https://example.org"
    || normalized === "http://example.org";
}

function buildSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

async function resolveLaunchTarget(query: string): Promise<string | null> {
  if (!IS_TAURI_RUNTIME) return null;
  try {
    const resolved = await invoke<string | null>("resolve_launch_target", { query });
    if (typeof resolved === "string" && resolved.trim()) {
      return resolved.trim();
    }
    return null;
  } catch {
    return null;
  }
}

function detectExplicitLaunchTarget(text: string): string | null {
  const clean = text.trim();
  if (!clean) return null;

  const quoted = clean.match(/"([^"]+)"|'([^']+)'/);
  if (quoted) {
    const value = (quoted[1] ?? quoted[2] ?? "").trim();
    if (value) return value;
  }

  const windowsPath = clean.match(/[a-zA-Z]:\\[^\n"']+\.(exe|bat|cmd|ps1)\b/i);
  if (windowsPath?.[0]) {
    return windowsPath[0].trim();
  }

  const unixPath = clean.match(/\/[^\s"']+\.(app|sh)\b/i);
  if (unixPath?.[0]) {
    return unixPath[0].trim();
  }

  const normalized = clean
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  for (const app of KNOWN_APP_TARGETS) {
    if (new RegExp(`\\b${escapeRegex(app)}\\b`).test(normalized)) {
      return app;
    }
  }

  const commandMatch = normalized.match(
    /\b(?:abrir|abra|iniciar|inicie|executar|execute)\b[^a-z0-9]+(?:o|a|um|uma|app|aplicativo|programa|script)?[^a-z0-9]*([a-z0-9._-]{2,40})\b/i
  );
  if (commandMatch?.[1]) {
    const candidate = commandMatch[1].trim();
    if (!isGenericLaunchWord(candidate)) {
      return candidate;
    }
  }

  return null;
}

function isGenericLaunchWord(value: string): boolean {
  return [
    "app",
    "aplicativo",
    "programa",
    "script",
    "computador",
    "pc",
    "notebook",
  ].includes(value.toLowerCase());
}

function isLikelyGameIntent(request: string, failedTarget: string): boolean {
  const text = `${request} ${failedTarget}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (/\b(jogo|game|jogar|steam|epic|battle\.?net|origin|uplay)\b/.test(text)) {
    return true;
  }

  const token = failedTarget.trim().toLowerCase();
  if (/^[a-z0-9._-]{2,8}$/.test(token) && /\d/.test(token)) {
    return true;
  }

  return false;
}

function mentionsSearch(text: string): boolean {
  return /\b(pesquis|buscar|procure|google)\b/.test(text);
}

function mentionsFolder(text: string): boolean {
  return /\b(pasta|diretorio|diretório|folder)\b/.test(text);
}

function mentionsLaunchApp(text: string): boolean {
  return /\b(app|aplicativo|programa|script|executar|abrir)\b/.test(text);
}

function readNonEmptyString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function parseJsonObject(raw: string): RawModelDraft | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  const candidate = trimmed.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as RawModelDraft;
  } catch {
    return null;
  }
}

function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// App.tsx — Nexus Ghost UI Orchestrator (M3)
// Full LLM integration: user types → LLM classifies intent → Rust executes

import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { CommandBar } from "./components/CommandBar";
import { ResponseDisplay } from "./components/ResponseDisplay";
import { SettingsPanel } from "./components/SettingsPanel";
import { useBrowserShortcut } from "./hooks/useGlobalShortcut";
import { sendToLLM, sessionContext, type LLMRequestContext } from "./services/llm";
import { describeCommand, type NexusCommand } from "./services/parser";
import { config } from "./services/config";
import { isDictating, isSupported as isSttSupported, startDictation, stopDictation } from "./services/stt";
import { refineDictationWithLLM } from "./services/dictationRefiner";
import { getSkillRegistrySnapshot, initializeSkillRegistry } from "./services/skillRegistry";
import { resolveSkillPlan } from "./services/skillPlanner";
import { buildLearningCandidate, commandToLearnableRecord, type LearnedExecutionRecord } from "./services/skillLearning";
import { evaluateSkillRoutingAccuracy, routeSkillFromText } from "./services/skillRouter";
import { createRecoverySkillFromFailure } from "./services/skillStudio";
import type { NexusStatus } from "./components/StatusIndicator";
import "./App.css";

// ── Window height constants ───────────────────────────────────────────────

const WIN_H_BASE      = 200; // idle: command bar only
const WIN_H_RESPONSE  = 380; // with response panel
const WIN_H_SETTINGS  = 520; // minimum when settings panel is visible
const WIN_W           = 800;
const IS_TAURI_RUNTIME = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const DICTATION_SILENCE_MS = 3500;
const DICTATION_MAX_MS = 15_000;
const AUTO_SUBMIT_AFTER_DICTATION_MS = 1000;
const CPU_SAMPLE_INTERVAL_MS = 1800;
const CPU_TARGET_PERCENT = 10;
const STT_LOG_PREFIX = "[nexus-stt]";
const SKILLS_LOG_PREFIX = "[nexus-skills]";
const SKILLS_ROUTING_LOG_PREFIX = "[nexus-skills-routing]";
const PROCESSING_HINT_ROTATE_MS = 2200;

const REMOTE_WAIT_HINTS = [
  "Mandando seu pedido e já volto...",
  "Batendo na porta certa...",
  "Puxando uma ideia fresquinha...",
  "Só um instante, estou consultando...",
];

const LOCAL_WORK_HINTS = [
  "Organizando tudo por aqui...",
  "Ajustando os detalhes finais...",
  "Deixando sua ação no jeito...",
  "Quase lá, conferindo tudinho...",
];

const THINKING_HINTS = [
  "Entendendo o que você pediu...",
  "Pensando no melhor caminho...",
  "Ligando os pontos rapidinho...",
  "Montando sua resposta com carinho...",
];

const KNOWN_SITE_ALIASES: Record<string, string> = {
  "youtube": "https://www.youtube.com",
  "you tube": "https://www.youtube.com",
  "gmail": "https://mail.google.com",
  "google": "https://www.google.com",
  "github": "https://github.com",
  "git hub": "https://github.com",
  "reddit": "https://www.reddit.com",
  "linkedin": "https://www.linkedin.com",
  "twitter": "https://x.com",
  "x.com": "https://x.com",
  "instagram": "https://www.instagram.com",
  "facebook": "https://www.facebook.com",
  "netflix": "https://www.netflix.com",
  "prime video": "https://www.primevideo.com",
  "amazon prime video": "https://www.primevideo.com",
  "chatgpt": "https://chatgpt.com",
};

const MULTI_ACTION_SPLIT_REGEX = /(?:\b(?:e|and|depois|entao|então|tambem|também)\b|[,;+])/i;

function normalizeIntentText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s./:-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractExplicitUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
}

function extractKnownSiteUrl(text: string): string | null {
  const normalized = normalizeIntentText(text);
  if (!normalized) return null;

  const padded = ` ${normalized} `;
  for (const [alias, url] of Object.entries(KNOWN_SITE_ALIASES)) {
    const normalizedAlias = normalizeIntentText(alias);
    if (!normalizedAlias) continue;
    if (padded.includes(` ${normalizedAlias} `)) {
      return url;
    }
  }

  return null;
}

function hasOpenUrlIntent(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return /\b(abra|abrir|open|acesse|acessar|visite|visitar|ir para|site|pagina)\b/.test(normalized);
}

function extractChainedActionTargets(text: string): string[] {
  const normalized = normalizeIntentText(text);

  if (!/\b(abra|abrir|inicie|iniciar|execute|executar)\b/.test(normalized)) {
    return [];
  }

  if (!MULTI_ACTION_SPLIT_REGEX.test(normalized)) {
    return [];
  }

  const pieces = text.split(MULTI_ACTION_SPLIT_REGEX);
  if (pieces.length < 2) return [];

  const generic = new Set([
    "app",
    "aplicativo",
    "programa",
    "script",
    "coisa",
    "coisas",
    "tambem",
    "também",
  ]);

  const unique = new Set<string>();
  const targets: string[] = [];

  for (const part of pieces) {
    const cleaned = part
      .replace(/\b(?:abra|abrir|inicie|iniciar|execute|executar|acesse|acessar|visite|visitar)\b/gi, " ")
      .replace(/\b(?:o|a|os|as|um|uma)\b/gi, " ")
      .replace(/\b(?:app|aplicativo|programa|script|site|pagina|página)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned) continue;
    const key = normalizeIntentText(cleaned);
    if (!key || generic.has(key)) continue;
    if (unique.has(key)) continue;
    unique.add(key);
    targets.push(cleaned);
  }

  return targets.length >= 2 ? targets.slice(0, 4) : [];
}

function buildFallbackActionCommand(target: string): NexusCommand {
  const inferredUrl = extractExplicitUrl(target) ?? extractKnownSiteUrl(target);
  if (inferredUrl) {
    return {
      command: "open_url",
      args: { url: inferredUrl },
      display: `Abrindo página: ${inferredUrl}`,
    };
  }

  return {
    command: "launch_app",
    args: { name: target },
    display: `Abrindo ${target}`,
  };
}

function mapRunSkillToSystemCommand(command: NexusCommand): NexusCommand | null {
  if (command.command !== "run_skill") return command;

  const { skill_id, inputs } = command.args;
  const readInput = (key: string): string | null => {
    const value = inputs[key];
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed || null;
  };

  if (skill_id === "web.open-site") {
    const url = readInput("url");
    if (!url) return null;
    return {
      command: "open_url",
      args: { url },
      display: `Abrindo página: ${url}`,
    };
  }

  if (skill_id === "web.search-topic") {
    const query = readInput("query");
    if (!query) return null;
    return {
      command: "search_web",
      args: { query },
      display: `Pesquisando: ${query}`,
    };
  }

  if (skill_id === "files.create-folder-safe") {
    const path = readInput("path");
    if (!path) return null;
    return {
      command: "create_folder",
      args: { path },
      display: `Criando pasta: ${path}`,
    };
  }

  if (skill_id === "apps.launch-known-app") {
    const name = readInput("name");
    if (!name) return null;
    return {
      command: "launch_app",
      args: { name },
      display: `Abrindo ${name}`,
    };
  }

  return null;
}

function toExecutableSystemCommand(command: NexusCommand): NexusCommand | null {
  const mapped = mapRunSkillToSystemCommand(command);
  if (!mapped) return null;
  if (mapped.command === "chat" || mapped.command === "run_skill") {
    return null;
  }
  return mapped;
}

function buildFullRequestContext(text: string): LLMRequestContext {
  const hints: string[] = [];
  if (extractExplicitUrl(text)) {
    hints.push("contains_explicit_url");
  }
  if (extractKnownSiteUrl(text) && hasOpenUrlIntent(text)) {
    hints.push("contains_named_site");
  }
  const segments = extractChainedActionTargets(text);
  if (segments.length >= 2) {
    hints.push(`contains_multi_action:${segments.length}`);
  }
  return {
    source: "full_request",
    intentHints: hints,
  };
}

function buildMultiActionSegmentContext(
  fullRequest: string,
  target: string,
  index: number,
  total: number
): LLMRequestContext {
  const hints: string[] = ["split_action_segment"];
  if (extractExplicitUrl(target)) {
    hints.push("segment_has_explicit_url");
  }
  if (extractKnownSiteUrl(target)) {
    hints.push("segment_likely_named_site");
  }
  return {
    source: "multi_action_segment",
    originalUserMessage: fullRequest,
    segmentIndex: index,
    segmentTotal: total,
    intentHints: hints,
  };
}

function applyCommandSafetyGuards(userText: string, command: NexusCommand): NexusCommand {
  const explicitUrl = extractExplicitUrl(userText);
  const namedSiteUrl = hasOpenUrlIntent(userText) ? extractKnownSiteUrl(userText) : null;
  const inferredUrl = explicitUrl ?? namedSiteUrl;
  if (!inferredUrl) return command;

  if (command.command === "open_url") {
    return {
      ...command,
      args: { url: inferredUrl },
    };
  }

  if (command.command === "run_skill" && command.args.skill_id === "web.open-site") {
    return {
      ...command,
      args: {
        ...command.args,
        inputs: {
          ...command.args.inputs,
          url: inferredUrl,
        },
      },
    };
  }

  const shouldForceOpenUrl =
    command.command === "create_folder" ||
    command.command === "launch_app" ||
    command.command === "search_web" ||
    (command.command === "run_skill" && command.args.skill_id !== "web.open-site") ||
    hasOpenUrlIntent(userText);

  if (!shouldForceOpenUrl) return command;

  return {
    command: "open_url",
    args: { url: inferredUrl },
    display: `Abrindo página: ${inferredUrl}`,
  };
}

async function resizeWindow(height: number) {
  try {
    const win = getCurrentWindow();
    await win.setSize(new LogicalSize(WIN_W, height));
  } catch { /* dev browser mode — no-op */ }
}

// ── Backend command output type ───────────────────────────────────────────

interface CommandOutput {
  success: boolean;
  message: string;
  error_code?: string | null;
}

interface SkillPlanStepOutput {
  index: number;
  command: string;
  success: boolean;
  message: string;
  error_code?: string | null;
}

interface SkillPlanOutput {
  success: boolean;
  skill_id: string;
  steps: SkillPlanStepOutput[];
  message: string;
  error_code?: string | null;
}

interface SkillStepProgressPayload {
  skill_id: string;
  step_index: number;
  total_steps: number;
}

function isRecoverableLaunchFailure(errorCode: string | null | undefined, message: string): boolean {
  const normalized = message.toLowerCase();
  if (errorCode === "EXECUTION_FAILED" || errorCode === "INVALID_APP_TARGET") {
    return true;
  }
  return normalized.includes("program not found")
    || normalized.includes("aplicativo ou script invalido")
    || normalized.includes("failed to execute")
    || normalized.includes("falha ao executar");
}

// ── App ────────────────────────────────────────────────────────────────────

function App() {
  const [input,        setInput]        = useState("");
  const [status,       setStatus]       = useState<NexusStatus>("idle");
  const [response,     setResponse]     = useState<string>("");
  const [micActive,    setMicActive]    = useState(false);
  const [sttSupported, setSttSupported] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [processingHint, setProcessingHint] = useState("");
  const overlayRef = useRef<HTMLDivElement>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const sessionTimerRef = useRef<number | null>(null);
  const autoSubmitTimerRef = useRef<number | null>(null);
  const cpuSampleTimerRef = useRef<number | null>(null);
  const cpuSamplesRef = useRef<number[]>([]);
  const ignoreDictationCallbacksRef = useRef(false);
  const dictationStartedAtRef = useRef<number | null>(null);
  const firstPartialLoggedRef = useRef(false);
  const dictationCommitIdRef = useRef(0);
  const inputRef = useRef("");
  const statusRef = useRef<NexusStatus>("idle");
  const showSettingsRef = useRef(false);
  const micActiveRef = useRef(false);
  const handleSubmitRef = useRef<(text: string) => void>(() => {});
  const handleMicToggleRef = useRef<() => void>(() => {});
  const learningHistoryRef = useRef<LearnedExecutionRecord[]>([]);
  const learningSuggestionCooldownRef = useRef(0);

  const resizeToOverlayContent = useCallback(async (fallbackHeight: number) => {
    const overlay = overlayRef.current;
    if (!overlay) {
      await resizeWindow(fallbackHeight);
      return;
    }

    const measured = Math.ceil(overlay.scrollHeight);
    await resizeWindow(Math.max(fallbackHeight, measured));
  }, []);

  // ── Window resize helpers ───────────────────────────────────────────────

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    showSettingsRef.current = showSettings;
  }, [showSettings]);

  useEffect(() => {
    micActiveRef.current = micActive;
  }, [micActive]);

  useEffect(() => {
    setSttSupported(isSttSupported());
    void initializeSkillRegistry()
      .then((registry) => {
        console.info(
          `${SKILLS_LOG_PREFIX} loaded=${registry.skills.length} rejected=${registry.rejected.length}`
        );
        const benchmark = evaluateSkillRoutingAccuracy();
        console.info(
          `${SKILLS_ROUTING_LOG_PREFIX} matched=${benchmark.matched}/${benchmark.total} accuracy=${(benchmark.accuracy * 100).toFixed(1)}%`
        );
        if (registry.rejected.length > 0) {
          for (const item of registry.rejected) {
            console.warn(
              `${SKILLS_LOG_PREFIX} source=${item.source} id=${item.id ?? "unknown"} errors=${item.errors.join(" | ")}`
            );
          }
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`${SKILLS_LOG_PREFIX} init_failed=${msg}`);
      });

    return () => {
      if (silenceTimerRef.current) {
        window.clearTimeout(silenceTimerRef.current);
      }
      if (sessionTimerRef.current) {
        window.clearTimeout(sessionTimerRef.current);
      }
      if (autoSubmitTimerRef.current) {
        window.clearTimeout(autoSubmitTimerRef.current);
      }
      if (cpuSampleTimerRef.current) {
        window.clearInterval(cpuSampleTimerRef.current);
      }
      if (isDictating()) {
        stopDictation();
      }
    };
  }, []);

  const clearDictationTimers = useCallback(() => {
    if (silenceTimerRef.current) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (sessionTimerRef.current) {
      window.clearTimeout(sessionTimerRef.current);
      sessionTimerRef.current = null;
    }
  }, []);

  const clearAutoSubmitTimer = useCallback(() => {
    if (autoSubmitTimerRef.current) {
      window.clearTimeout(autoSubmitTimerRef.current);
      autoSubmitTimerRef.current = null;
    }
  }, []);

  const clearCpuSampling = useCallback(() => {
    if (cpuSampleTimerRef.current) {
      window.clearInterval(cpuSampleTimerRef.current);
      cpuSampleTimerRef.current = null;
    }
  }, []);

  const finishCpuSampling = useCallback(() => {
    clearCpuSampling();
    const samples = cpuSamplesRef.current;
    if (!samples.length) {
      cpuSamplesRef.current = [];
      return;
    }

    const avg = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const peak = Math.max(...samples);
    const targetOk = avg <= CPU_TARGET_PERCENT;
    console.info(
      `${STT_LOG_PREFIX} avg_cpu_pct=${avg.toFixed(1)} peak_cpu_pct=${peak.toFixed(1)} target_lt_${CPU_TARGET_PERCENT}=${targetOk}`
    );
    cpuSamplesRef.current = [];
  }, [clearCpuSampling]);

  const startCpuSampling = useCallback(() => {
    clearCpuSampling();
    cpuSamplesRef.current = [];
    if (!IS_TAURI_RUNTIME) return;

    const capture = () => {
      void invoke<number>("sample_process_cpu_percent")
        .then((value) => {
          if (!Number.isFinite(value)) return;
          if (value < 0) return;
          cpuSamplesRef.current.push(value);
        })
        .catch(() => {
          // Ignore sample errors to keep dictation flow uninterrupted.
        });
    };

    capture();
    cpuSampleTimerRef.current = window.setInterval(capture, CPU_SAMPLE_INTERVAL_MS);
  }, [clearCpuSampling]);

  const scheduleSilenceStop = useCallback(() => {
    if (silenceTimerRef.current) {
      window.clearTimeout(silenceTimerRef.current);
    }
    silenceTimerRef.current = window.setTimeout(() => {
      if (isDictating()) {
        stopDictation();
      }
    }, DICTATION_SILENCE_MS);
  }, []);

  useEffect(() => {
    let frameA = 0;
    let frameB = 0;

    if (showSettings) {
      frameA = requestAnimationFrame(() => {
        frameB = requestAnimationFrame(() => {
          void resizeToOverlayContent(WIN_H_SETTINGS);
        });
      });
    } else if (response) {
      resizeWindow(WIN_H_RESPONSE);
    } else {
      resizeWindow(WIN_H_BASE);
    }

    return () => {
      if (frameA) cancelAnimationFrame(frameA);
      if (frameB) cancelAnimationFrame(frameB);
    };
  }, [showSettings, response, resizeToOverlayContent]);

  // ── Window control ──────────────────────────────────────────────────────

  const hideWindow = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      await win.hide();
    } catch { /* dev mode */ }
  }, []);

  const clearOverlay = useCallback(() => {
    ignoreDictationCallbacksRef.current = true;
    clearDictationTimers();
    clearAutoSubmitTimer();
    clearCpuSampling();
    if (isDictating()) {
      stopDictation();
    }
    setInput("");
    setResponse("");
    setStatus("idle");
    setMicActive(false);
    setShowSettings(false);
    dictationStartedAtRef.current = null;
    firstPartialLoggedRef.current = false;
    cpuSamplesRef.current = [];
  }, [clearAutoSubmitTimer, clearCpuSampling, clearDictationTimers]);

  const handleEscape = useCallback(async () => {
    if (showSettings) {
      setShowSettings(false);
      return;
    }
    clearOverlay();
    await hideWindow();
  }, [showSettings, clearOverlay, hideWindow]);

  // ── Alt+Space shortcut (dev mode) ───────────────────────────────────────

  useBrowserShortcut(["Alt", "Space"], useCallback(() => {
    document.getElementById("nexus-command-input")?.focus();
  }, []), !IS_TAURI_RUNTIME);

  // ── Settings ────────────────────────────────────────────────────────────

  const handleSettingsOpen  = useCallback(() => setShowSettings(true),  []);
  const handleSettingsClose = useCallback(() => {
    setShowSettings(false);
    // Re-focus input after closing
    setTimeout(() => document.getElementById("nexus-command-input")?.focus(), 50);
  }, []);

  // ── LLM + Command execution ─────────────────────────────────────────────

  const maybeLearnSkillFromCommand = useCallback(async (
    utterance: string,
    command: NexusCommand
  ): Promise<string | null> => {
    const learnable = commandToLearnableRecord(utterance, command);
    if (!learnable) {
      return null;
    }

    const now = Date.now();
    if (now < learningSuggestionCooldownRef.current) {
      learningHistoryRef.current.push(learnable);
      learningHistoryRef.current = learningHistoryRef.current.slice(-20);
      return null;
    }

    const history = learningHistoryRef.current;
    const existingIds = getSkillRegistrySnapshot().skills.map((skill) => skill.id);
    const candidate = buildLearningCandidate(learnable, history, existingIds);
    learningHistoryRef.current.push(learnable);
    learningHistoryRef.current = learningHistoryRef.current.slice(-20);

    if (!candidate) {
      return null;
    }

    const confirmed = window.confirm(
      `Quer que eu salve isso como Skill reutilizável?\n\n` +
      `Nome: ${candidate.draft.name}\n` +
      `ID: ${candidate.draft.id}\n\n` +
      `${candidate.reason}`
    );

    if (!confirmed) {
      learningSuggestionCooldownRef.current = now + 15_000;
      return null;
    }

    try {
      await invoke<string>("save_user_skill", { skill: candidate.draft });
      await initializeSkillRegistry(true);
      learningSuggestionCooldownRef.current = now + 30_000;
      return `✓ Skill aprendida: ${candidate.draft.name}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `⚠ Não consegui salvar a Skill: ${msg}`;
    }
  }, []);

  const tryRecoverFailedIntent = useCallback(async (
    utterance: string,
    failedTarget: string,
    failureMessage: string
  ): Promise<string | null> => {
    if (!config.isConfigured()) return null;

    try {
      const existingIds = getSkillRegistrySnapshot().skills.map((skill) => skill.id);
      const preview = await createRecoverySkillFromFailure(
        utterance,
        failedTarget,
        failureMessage,
        existingIds
      );
      if (!preview) return null;
      const recoverySteps = preview.draft.steps.map((step) => ({
        command: step.command,
        args: Object.fromEntries(
          Object.entries(step.argsTemplate).map(([k, v]) => [k, v as string | number | boolean])
        ),
      }));
      const execution = await invoke<SkillPlanOutput>("execute_skill_plan", {
        input: {
          skill_id: preview.draft.id,
          steps: recoverySteps,
        },
      });

      if (!execution.success) return null;

      let saved = false;
      try {
        await invoke<string>("save_user_skill", { skill: preview.draft });
        await initializeSkillRegistry(true);
        saved = true;
      } catch {
        // Recovery can still be successful even if persistence fails.
      }

      const outputs = execution.steps
        .map((step) => step.message?.trim())
        .filter((msg): msg is string => Boolean(msg));

      if (outputs.length === 0) {
        return saved
          ? `✓ Interpretei seu pedido e executei uma recuperação automática.\n✓ Nova Skill criada: ${preview.draft.name}`
          : "✓ Interpretei seu pedido e executei uma recuperação automática.";
      }

      const lines = [
        "✓ Interpretei seu pedido e executei uma recuperação automática.",
        ...outputs,
      ];
      if (saved) {
        lines.push(`✓ Nova Skill criada: ${preview.draft.name}`);
      }
      return lines.join("\n");
    } catch {
      return null;
    }
  }, []);

  const handleSubmit = useCallback(async (text: string) => {
    clearAutoSubmitTimer();
    if (!text.trim()) return;

    // Guard: require API key
    if (!config.isConfigured()) {
      setShowSettings(true);
      setResponse("Configure sua API Key antes de continuar.");
      return;
    }

    setStatus("processing");
    setResponse("");
    setInput("");

    let hintTimer: number | null = null;
    const pickHint = (pool: string[]) => pool[Math.floor(Math.random() * pool.length)];
    const startHintRotation = (pool: string[]) => {
      setProcessingHint(pickHint(pool));
      if (hintTimer) {
        window.clearInterval(hintTimer);
      }
      hintTimer = window.setInterval(() => {
        setProcessingHint(pickHint(pool));
      }, PROCESSING_HINT_ROTATE_MS);
    };
    const stopHintRotation = () => {
      if (hintTimer) {
        window.clearInterval(hintTimer);
        hintTimer = null;
      }
      setProcessingHint("");
    };

    startHintRotation(THINKING_HINTS);

    try {
      const chainedActionTargets = extractChainedActionTargets(text);
      if (chainedActionTargets.length >= 2) {
        stopHintRotation();
        startHintRotation(LOCAL_WORK_HINTS);

        const lines: string[] = ["✓ Entendi seu pedido com múltiplas ações."];
        let successCount = 0;

        for (let index = 0; index < chainedActionTargets.length; index += 1) {
          const target = chainedActionTargets[index];
          const fallbackCommand = buildFallbackActionCommand(target);
          let executableCommand = fallbackCommand;

          try {
            const llmResult = await sendToLLM(
              target,
              buildMultiActionSegmentContext(text, target, index + 1, chainedActionTargets.length)
            );
            const guarded = applyCommandSafetyGuards(target, llmResult.command);
            const candidate = toExecutableSystemCommand(guarded);
            if (candidate) {
              const shouldPreserveFallbackUrl =
                fallbackCommand.command === "open_url"
                && candidate.command === "launch_app"
                && !extractExplicitUrl(target);

              executableCommand = shouldPreserveFallbackUrl ? fallbackCommand : candidate;
            }
          } catch {
            // Fall back to deterministic local classification for each segment.
          }

          const result = await invoke<CommandOutput>("execute_command", {
            input: {
              command: executableCommand.command,
              args: executableCommand.args,
            },
          });

          if (result.success) {
            successCount += 1;
            lines.push(`✓ ${result.message}`);
            continue;
          }

          if (
            executableCommand.command === "launch_app"
            && isRecoverableLaunchFailure(result.error_code, result.message)
          ) {
            setProcessingHint(`Tentando recuperar: ${target}...`);
            const recoveredText = await tryRecoverFailedIntent(target, target, result.message);
            if (recoveredText) {
              successCount += 1;
              lines.push(recoveredText);
              continue;
            }
          }

          lines.push(`⚠ ${target}: ${result.message}`);
        }

        stopHintRotation();
        setStatus("idle");
        if (successCount > 0) {
          setResponse(lines.join("\n"));
        } else {
          setResponse(lines.slice(1).join("\n") || "⚠ Não consegui executar as ações solicitadas.");
        }
        return;
      }

      // Step 1: route by skill triggers when confidence is high, fallback to LLM
      let command: NexusCommand;
      const directSkillRoute = routeSkillFromText(text);
      if (directSkillRoute && directSkillRoute.confidence >= 0.78) {
        command = directSkillRoute.command;
      } else {
        window.setTimeout(() => {
          if (statusRef.current === "processing") {
            startHintRotation(REMOTE_WAIT_HINTS);
          }
        }, 700);
        const llmResult = await sendToLLM(text, buildFullRequestContext(text));
        command = llmResult.command;
      }

      command = applyCommandSafetyGuards(text, command);

      if (command.command === "run_skill") {
        stopHintRotation();

        const planResult = resolveSkillPlan(command);
        if (!planResult.ok) {
          setProcessingHint("");
          setStatus("idle");
          setResponse(`⚠ ${planResult.error}`);
          return;
        }

        const { plan } = planResult;
        if (plan.requiresConfirmation) {
          const approved = window.confirm(
            `Executar a Skill "${plan.skill.name}" com ${plan.steps.length} etapa(s)?`
          );
          if (!approved) {
            setProcessingHint("");
            setStatus("idle");
            setResponse("Tudo certo, execução cancelada.");
            return;
          }
        }

        setProcessingHint(`Skill ${plan.skill.name} · preparando execução...`);

        let unlistenProgress: UnlistenFn | null = null;
        let timeoutRef: number | null = null;
        try {
          if (IS_TAURI_RUNTIME) {
            unlistenProgress = await listen<SkillStepProgressPayload>("nexus://skill-step-progress", (event) => {
              const payload = event.payload;
              if (payload.skill_id !== plan.skill.id) return;
              setProcessingHint(`Skill ${plan.skill.name} · etapa ${payload.step_index}/${payload.total_steps}`);
            });
          }

          const timeoutPromise = new Promise<never>((_resolve, reject) => {
            timeoutRef = window.setTimeout(() => {
              reject(new Error("A Skill demorou mais que o esperado e foi interrompida."));
            }, plan.timeoutMs);
          });

          const execution = await Promise.race([
            invoke<SkillPlanOutput>("execute_skill_plan", {
              input: {
                skill_id: plan.skill.id,
                steps: plan.steps,
              },
            }),
            timeoutPromise,
          ]);

          if (!execution.success) {
            const failedStep = execution.steps.find((step) => !step.success) ?? null;
            if (failedStep && failedStep.command === "launch_app") {
              const plannedStep = plan.steps[failedStep.index];
              const failedTargetRaw = plannedStep?.args?.name;
              const failedTarget = typeof failedTargetRaw === "string" ? failedTargetRaw : text;
              if (isRecoverableLaunchFailure(failedStep.error_code, failedStep.message)) {
                setProcessingHint("Tentando entender melhor e recuperar sua intenção...");
                const recoveredText = await tryRecoverFailedIntent(text, failedTarget, failedStep.message);
                if (recoveredText) {
                  setProcessingHint("");
                  setStatus("idle");
                  setResponse(recoveredText);
                  return;
                }
              }
            }
            throw new Error(execution.message);
          }

          const outputs = execution.steps
            .map((step) => step.message?.trim())
            .filter((msg): msg is string => Boolean(msg));

          setProcessingHint("");
          setStatus("idle");
          if (outputs.length === 0) {
            setResponse(`✓ Skill ${plan.skill.name} concluída.`);
          } else {
            setResponse(`✓ Skill ${plan.skill.name}\n${outputs.join("\n")}`);
          }
          return;
        } finally {
          if (timeoutRef) {
            window.clearTimeout(timeoutRef);
          }
          if (unlistenProgress) {
            unlistenProgress();
          }
        }
      }

      setStatus("responding");

      // Step 2: If it's a system command, validate via Rust backend
      if (command.command !== "chat") {
        startHintRotation(LOCAL_WORK_HINTS);
        const result = await invoke<CommandOutput>("execute_command", {
          input: {
            command: command.command,
            args: command.args,
          },
        });

        const displayText = describeCommand(command);
        if (result.success) {
          let responseText = `✓ ${displayText}`;
          const learningMessage = await maybeLearnSkillFromCommand(text, command);
          if (learningMessage) {
            responseText = `${responseText}\n${learningMessage}`;
          }
          setResponse(responseText);
        } else {
          if (
            command.command === "launch_app"
            && isRecoverableLaunchFailure(result.error_code, result.message)
          ) {
            const failedTarget = typeof command.args.name === "string" ? command.args.name : text;
            setProcessingHint("Tentando entender melhor e recuperar sua intenção...");
            const recoveredText = await tryRecoverFailedIntent(text, failedTarget, result.message);
            if (recoveredText) {
              setResponse(recoveredText);
            } else {
              setResponse(`⚠ ${result.message}`);
            }
          } else {
            setResponse(`⚠ ${result.message}`);
          }
        }
      } else {
        // It's a chat response — display it directly
        setResponse(command.args.message);
      }

      stopHintRotation();
      setStatus("idle");

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stopHintRotation();
      setStatus("error");
      setResponse(`Erro: ${msg}`);
    }
  }, [clearAutoSubmitTimer, maybeLearnSkillFromCommand, tryRecoverFailedIntent]);

  const handleMicToggle = useCallback(() => {
    if (status === "processing" || showSettings) return;

    if (!sttSupported) {
      setStatus("error");
      setResponse("Reconhecimento de voz indisponível neste ambiente.");
      return;
    }

    if (micActive || isDictating()) {
      clearDictationTimers();
      clearAutoSubmitTimer();
      clearCpuSampling();
      ignoreDictationCallbacksRef.current = false;
      stopDictation();
      setMicActive(false);
      setStatus("idle");
      return;
    }

    try {
      ignoreDictationCallbacksRef.current = false;
      clearAutoSubmitTimer();
      setResponse("");
      setMicActive(true);
      setStatus("listening");
      dictationStartedAtRef.current = performance.now();
      firstPartialLoggedRef.current = false;
      startCpuSampling();

      startDictation({
        initialText: input,
        onText: (nextText) => {
          if (ignoreDictationCallbacksRef.current) return;
          if (!firstPartialLoggedRef.current && nextText.trim()) {
            firstPartialLoggedRef.current = true;
            if (dictationStartedAtRef.current !== null) {
              const firstPartialMs = Math.round(performance.now() - dictationStartedAtRef.current);
              console.info(`${STT_LOG_PREFIX} first_partial_ms=${firstPartialMs}`);
            }
          }
          setInput(nextText);
          setStatus("listening");
          scheduleSilenceStop();
        },
        onError: (message) => {
          if (ignoreDictationCallbacksRef.current) return;
          clearDictationTimers();
          clearAutoSubmitTimer();
          finishCpuSampling();
          setMicActive(false);
          setStatus("idle");
          setResponse(message);
          dictationStartedAtRef.current = null;
          firstPartialLoggedRef.current = false;
        },
        onEnd: (finalText) => {
          const ignored = ignoreDictationCallbacksRef.current;
          ignoreDictationCallbacksRef.current = false;
          clearDictationTimers();
          finishCpuSampling();
          setMicActive(false);
          if (dictationStartedAtRef.current !== null) {
            const finalMs = Math.round(performance.now() - dictationStartedAtRef.current);
            console.info(`${STT_LOG_PREFIX} final_text_ms=${finalMs}`);
          }
          dictationStartedAtRef.current = null;
          firstPartialLoggedRef.current = false;
          if (ignored) return;
          setInput(finalText);
          setStatus("idle");
          const commitId = ++dictationCommitIdRef.current;
          const baseline = finalText.trim();
          if (baseline) {
            void refineDictationWithLLM(finalText).then((refinedText) => {
              if (commitId !== dictationCommitIdRef.current) return;
              if (isDictating() || micActiveRef.current) return;
              if (statusRef.current === "processing") return;
              if (showSettingsRef.current) return;

              const current = inputRef.current.trim();
              if (current !== baseline) return;

              const refined = refinedText.trim();
              if (!refined || refined === baseline) return;
              setInput(refined);
            }).catch(() => {
              // Silent fallback to baseline dictated text.
            });
          }
          clearAutoSubmitTimer();
          autoSubmitTimerRef.current = window.setTimeout(() => {
            if (isDictating()) return;
            if (statusRef.current === "processing") return;
            if (showSettingsRef.current) return;

            const commandText = inputRef.current.trim();
            if (!commandText) return;
            void handleSubmitRef.current(commandText);
          }, AUTO_SUBMIT_AFTER_DICTATION_MS);
        },
      });

      scheduleSilenceStop();
      sessionTimerRef.current = window.setTimeout(() => {
        if (isDictating()) {
          stopDictation();
        }
      }, DICTATION_MAX_MS);
    } catch (err) {
      clearDictationTimers();
      clearAutoSubmitTimer();
      finishCpuSampling();
      setMicActive(false);
      setStatus("error");
      setResponse(err instanceof Error ? err.message : "Falha ao iniciar reconhecimento de voz.");
      dictationStartedAtRef.current = null;
      firstPartialLoggedRef.current = false;
    }
  }, [clearAutoSubmitTimer, clearCpuSampling, clearDictationTimers, finishCpuSampling, input, micActive, scheduleSilenceStop, showSettings, startCpuSampling, status, sttSupported]);

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  useEffect(() => {
    handleMicToggleRef.current = handleMicToggle;
  }, [handleMicToggle]);

  useEffect(() => {
    if (!IS_TAURI_RUNTIME) return;

    let disposed = false;
    const unlistenFns: UnlistenFn[] = [];

    const registerListeners = async () => {
      try {
        const unlistenToggleMic = await listen("nexus://toggle-mic", () => {
          handleMicToggleRef.current();
        });
        if (disposed) {
          unlistenToggleMic();
          return;
        }
        unlistenFns.push(unlistenToggleMic);

        const unlistenWindowOpened = await listen("nexus://window-opened", () => {
          clearAutoSubmitTimer();
          setInput("");
        });
        if (disposed) {
          unlistenWindowOpened();
          return;
        }
        unlistenFns.push(unlistenWindowOpened);
      } catch {
        // No-op: if event bridge is unavailable, manual controls still work.
      }
    };

    void registerListeners();

    return () => {
      disposed = true;
      unlistenFns.forEach((unlisten) => unlisten());
    };
  }, [clearAutoSubmitTimer]);

  // ── Alt+V shortcut for push-to-talk in dev mode ─────────────────────────

  useBrowserShortcut(["Alt", "v"], useCallback(() => {
    handleMicToggle();
  }, [handleMicToggle]), !IS_TAURI_RUNTIME);

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div ref={overlayRef} className="nexus-overlay" data-tauri-drag-region>
      <CommandBar
        value={input}
        status={status}
        micActive={micActive}
        micAvailable={sttSupported}
        processingHint={processingHint}
        onInput={setInput}
        onSubmit={handleSubmit}
        onMicToggle={handleMicToggle}
        onEscape={handleEscape}
        onSettingsOpen={handleSettingsOpen}
      />

      {/* Settings panel */}
      {showSettings && (
        <SettingsPanel onClose={handleSettingsClose} />
      )}

      {/* LLM / command response */}
      {!showSettings && response && (
        <ResponseDisplay text={response} animate={status !== "error"} />
      )}

      {/* Context counter — shows active session turns */}
      {!showSettings && !response && status === "idle" && (
        <div className="hint-bar" aria-label="Atalhos disponíveis">
          <span className="hint">
            <kbd>Enter</kbd> executar
          </span>
          <span className="hint">
            <kbd>Esc</kbd> fechar
          </span>
          <span className="hint">
            <kbd>Alt</kbd><kbd>Space</kbd> ativar
          </span>
          {sttSupported && (
            <span className="hint">
              <kbd>Alt</kbd><kbd>V</kbd> ditado
            </span>
          )}
          {!sttSupported && (
            <span className="hint">
              Voz indisponível neste ambiente
            </span>
          )}
          {config.isConfigured() && (
            <span className="hint hint--right" title="Limpar contexto da sessão">
              <button
                className="hint-btn"
                onClick={() => { sessionContext.clear(); }}
                type="button"
              >
                Limpar sessão
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default App;

// SettingsPanel.tsx — API config + Skill Studio assistido

import { useEffect, useRef, useState } from "react";
import { config } from "../services/config";
import { initializeSkillRegistry } from "../services/skillRegistry";
import {
  createGuidedSkillFromPrompt,
  createUserSkill,
  openSkillsDirectory,
  type GuidedSkillPreview,
} from "../services/skillStudio";

interface SettingsPanelProps {
  onClose: () => void;
}

const MODEL_SUGGESTIONS = [
  "google/gemma-3-27b-it:free",
  "google/gemma-3-12b-it:free",
  "google/gemma-3-4b-it:free",
  "meta-llama/llama-4-scout:free",
  "meta-llama/llama-4-maverick:free",
  "mistralai/mistral-7b-instruct:free",
  "deepseek/deepseek-r1:free",
  "google/gemini-2.0-flash-001",
  "google/gemini-2.5-pro-exp-03-25",
  "openai/gpt-4o-mini",
  "openai/gpt-4o",
  "anthropic/claude-3.5-haiku",
  "anthropic/claude-3.7-sonnet",
];

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [apiKey, setApiKey] = useState(config.getApiKey());
  const [model, setModel] = useState(config.getModel());
  const [baseUrl, setBaseUrl] = useState(config.getBaseUrl());
  const [saved, setSaved] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [skillPrompt, setSkillPrompt] = useState("");
  const [skillActivationHint, setSkillActivationHint] = useState("");
  const [guidedPreview, setGuidedPreview] = useState<GuidedSkillPreview | null>(null);
  const [guidedGenerating, setGuidedGenerating] = useState(false);
  const [guidedSaving, setGuidedSaving] = useState(false);
  const [studioMessage, setStudioMessage] = useState("");
  const [existingSkillIds, setExistingSkillIds] = useState<string[]>([]);
  const [skillsCount, setSkillsCount] = useState(0);

  useEffect(() => {
    inputRef.current?.focus();
    void refreshSkillStats();
  }, []);

  async function refreshSkillStats() {
    const registry = await initializeSkillRegistry(true);
    setExistingSkillIds(registry.skills.map((skill) => skill.id));
    setSkillsCount(registry.skills.length);
  }

  function handleSaveSettings() {
    config.setApiKey(apiKey.trim());
    config.setModel(model);
    config.setBaseUrl(baseUrl.trim());
    setSaved(true);
    setTimeout(() => {
      setSaved(false);
      onClose();
    }, 900);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      handleSaveSettings();
    }
    if (e.key === "Escape") onClose();
  }

  async function handleGenerateGuidedSkill() {
    if (!skillPrompt.trim()) {
      setStudioMessage("Descreva o que você quer que a Skill faça.");
      return;
    }

    setGuidedGenerating(true);
    setStudioMessage("");
    try {
      const preview = await createGuidedSkillFromPrompt(
        skillPrompt,
        existingSkillIds,
        skillActivationHint
      );
      setGuidedPreview(preview);
      const modeLabel = preview.generationMode === "llm" ? "assistido por IA" : "modo de segurança";
      setStudioMessage(`Plano de Skill criado (${modeLabel}).`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStudioMessage(`Não consegui montar a Skill: ${msg}`);
      setGuidedPreview(null);
    } finally {
      setGuidedGenerating(false);
    }
  }

  async function handleSaveGuidedSkill() {
    if (!guidedPreview) {
      setStudioMessage("Gere o plano da Skill antes de salvar.");
      return;
    }

    setGuidedSaving(true);
    try {
      const confirmMessage =
        `Salvar esta Skill?\n\n` +
        `Nome: ${guidedPreview.summary.title}\n` +
        `Ativação: ${guidedPreview.summary.triggerPhrase}\n` +
        `Etapas: ${guidedPreview.draft.steps.length}`;
      if (!window.confirm(confirmMessage)) {
        return;
      }

      await createUserSkill(guidedPreview.draft);
      await refreshSkillStats();
      setStudioMessage(`Skill salva e pronta para uso: ${guidedPreview.summary.title}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStudioMessage(`Falha ao salvar Skill: ${msg}`);
    } finally {
      setGuidedSaving(false);
    }
  }

  async function handleOpenSkillsFolder() {
    try {
      const path = await openSkillsDirectory();
      setStudioMessage(`Pasta de skills aberta: ${path}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStudioMessage(`Não consegui abrir a pasta de skills: ${msg}`);
    }
  }

  return (
    <div
      className="settings-panel"
      role="dialog"
      aria-label="Configurações do Nexus"
      onKeyDown={handleKeyDown}
    >
      <div className="settings-header">
        <span className="settings-title">Configurações</span>
        <button className="settings-close" onClick={onClose} aria-label="Fechar configurações">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="settings-body settings-body--scroll">
        <div className="settings-field">
          <label className="settings-label" htmlFor="nexus-api-key">
            OpenRouter API Key
          </label>
          <div className="settings-input-row">
            <input
              ref={inputRef}
              id="nexus-api-key"
              className="settings-input"
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-or-..."
              autoComplete="off"
              spellCheck={false}
            />
            <button
              className="settings-eye"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? "Ocultar chave" : "Mostrar chave"}
              type="button"
            >
              {showKey ? "Ocultar" : "Mostrar"}
            </button>
          </div>
        </div>

        <div className="settings-field">
          <label className="settings-label" htmlFor="nexus-model">
            Modelo
            <a
              className="settings-link"
              href="https://openrouter.ai/models"
              target="_blank"
              rel="noreferrer"
              title="Ver todos os modelos disponíveis no OpenRouter"
            >
              ver todos ↗
            </a>
          </label>
          <input
            id="nexus-model"
            className="settings-input"
            type="text"
            list="nexus-model-list"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="google/gemma-3-27b-it:free"
            autoComplete="off"
            spellCheck={false}
          />
          <datalist id="nexus-model-list">
            {MODEL_SUGGESTIONS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>

        <div className="settings-field settings-field--sm">
          <label className="settings-label" htmlFor="nexus-base-url">
            Base URL <span className="settings-badge">opcional</span>
          </label>
          <input
            id="nexus-base-url"
            className="settings-input settings-input--sm"
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://openrouter.ai/api/v1"
            autoComplete="off"
          />
        </div>

        <div className="settings-section">
          <div className="settings-title-row">
            <span className="settings-title-sm">Skill Studio Assistido</span>
            <span className="settings-counter">{skillsCount} skills disponíveis</span>
          </div>

          <p className="settings-help">
            Descreva em linguagem natural. O Nexus cria uma Skill pronta, com uma ação única
            ou fluxo de várias etapas.
          </p>

          <div className="skill-editor">
            <label className="settings-label">O que você quer automatizar?</label>
            <textarea
              className="settings-textarea"
              rows={3}
              value={skillPrompt}
              onChange={(e) => setSkillPrompt(e.target.value)}
              placeholder="Ex: quando eu pedir, abrir o VS Code e pesquisar documentação de Tauri"
            />

            <label className="settings-label">Frase para acionar (opcional)</label>
            <input
              className="settings-input"
              type="text"
              value={skillActivationHint}
              onChange={(e) => setSkillActivationHint(e.target.value)}
              placeholder="Ex: preparar meu ambiente de estudo"
              autoComplete="off"
            />

            <div className="settings-input-row">
              <button
                className="settings-btn settings-btn--ghost"
                type="button"
                onClick={() => void handleGenerateGuidedSkill()}
                disabled={guidedGenerating}
              >
                {guidedGenerating ? "Criando plano..." : "Criar plano da Skill"}
              </button>
              <button
                className="settings-btn settings-btn--ghost"
                type="button"
                onClick={() => void handleSaveGuidedSkill()}
                disabled={!guidedPreview || guidedSaving}
              >
                {guidedSaving ? "Salvando..." : "Salvar Skill"}
              </button>
              <button
                className="settings-btn settings-btn--ghost"
                type="button"
                onClick={() => void handleOpenSkillsFolder()}
              >
                Abrir pasta de skills
              </button>
            </div>
          </div>

          {guidedPreview && (
            <div className="skill-preview-card">
              <div className="skill-preview-title">{guidedPreview.summary.title}</div>
              <div className="skill-preview-subtitle">
                Ativação sugerida: {guidedPreview.summary.triggerPhrase}
              </div>
              <div className="skill-preview-steps">
                {guidedPreview.summary.stepLines.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </div>
            </div>
          )}

          {studioMessage && (
            <div className="settings-msg">{studioMessage}</div>
          )}
        </div>
      </div>

      <div className="settings-footer">
        <button className="settings-btn settings-btn--ghost" onClick={onClose} type="button">
          Cancelar
        </button>
        <button
          className={`settings-btn settings-btn--primary ${saved ? "saved" : ""}`}
          onClick={handleSaveSettings}
          type="button"
        >
          {saved ? "Salvo" : "Salvar"}
        </button>
      </div>
    </div>
  );
}

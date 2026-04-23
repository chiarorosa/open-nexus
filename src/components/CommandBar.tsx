// CommandBar.tsx — Main Nexus input component
// The central UI element: receives text input, dispatches to backend.

import { useRef, useEffect, type KeyboardEvent } from "react";
import { StatusIndicator, type NexusStatus } from "./StatusIndicator";
import { MicButton } from "./MicButton";

interface CommandBarProps {
  value: string;
  status: NexusStatus;
  micActive: boolean;
  micAvailable?: boolean;
  processingHint?: string;
  onInput: (value: string) => void;
  onSubmit: (value: string) => void;
  onMicToggle: () => void;
  onEscape: () => void;
  onSettingsOpen: () => void;
}

export function CommandBar({
  value,
  status,
  micActive,
  micAvailable = true,
  processingHint = "",
  onInput,
  onSubmit,
  onMicToggle,
  onEscape,
  onSettingsOpen,
}: CommandBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus when rendered
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && value.trim()) {
      e.preventDefault();
      onSubmit(value.trim());
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onEscape();
    }
  }

  const isLoading = status === "processing";
  const micTitle = !micAvailable
    ? "Reconhecimento de voz indisponível neste ambiente"
    : micActive
      ? "Parar (Esc)"
      : "Falar (Alt+V)";

  return (
    <div
      className="command-bar"
      role="search"
      aria-label="Nexus Command Bar"
    >
      {/* Nexus logo icon */}
      <div className="nexus-icon" aria-hidden="true">
        ⬡
      </div>

      {/* Main text input */}
      <input
        ref={inputRef}
        id="nexus-command-input"
        className="command-input"
        type="text"
        value={value}
        placeholder={micActive ? "Ouvindo..." : "O que você quer fazer?"}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={isLoading || micActive}
        onChange={(e) => onInput(e.target.value)}
        onKeyDown={handleKeyDown}
        aria-label="Comando em linguagem natural"
        aria-busy={isLoading}
      />

      {/* Loading spinner or status indicator */}
      {isLoading ? (
        <div className="loader-state" aria-live="polite" aria-label="Processando">
          <div className="spinner" aria-hidden="true" />
          {processingHint && (
            <span className="loader-hint">{processingHint}</span>
          )}
        </div>
      ) : (
        <StatusIndicator status={status} />
      )}

      <div className="divider" aria-hidden="true" />

      {/* Mic toggle button (visual placeholder for M5 STT) */}
      <MicButton
        active={micActive}
        onClick={onMicToggle}
        disabled={isLoading || !micAvailable}
        title={micTitle}
      />

      {/* Settings gear button */}
      <button
        id="nexus-settings-button"
        className="icon-button"
        onClick={onSettingsOpen}
        aria-label="Configurações"
        title="Configurações (API Key)"
        type="button"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </div>
  );
}

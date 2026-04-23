// MicButton.tsx — Voice input trigger
// Placeholder for M5 (STT). Shows visual state without actual recording yet.

interface MicButtonProps {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}

export function MicButton({ active, onClick, disabled = false, title }: MicButtonProps) {
  const buttonTitle = title ?? (active ? "Parar (Esc)" : "Falar (Alt+V)");

  return (
    <button
      id="nexus-mic-button"
      className={`mic-button ${active ? "active" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={active ? "Parar gravação de voz" : "Iniciar gravação de voz"}
      aria-pressed={active}
      title={buttonTitle}
      type="button"
    >
      {active ? (
        // Waveform icon (recording)
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="8"  y1="6"  x2="8"  y2="18" />
          <line x1="12" y1="3"  x2="12" y2="21" />
          <line x1="16" y1="8"  x2="16" y2="16" />
          <line x1="4"  y1="10" x2="4"  y2="14" />
          <line x1="20" y1="10" x2="20" y2="14" />
        </svg>
      ) : (
        // Mic icon (idle)
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 10a7 7 0 0 0 14 0" />
          <line x1="12" y1="19" x2="12" y2="22" />
          <line x1="8"  y1="22" x2="16" y2="22" />
        </svg>
      )}
    </button>
  );
}

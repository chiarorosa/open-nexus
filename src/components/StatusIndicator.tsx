// StatusIndicator.tsx — Nexus UI state display
// States: idle | listening | processing | responding | error

export type NexusStatus = "idle" | "listening" | "processing" | "responding" | "error";

const STATUS_LABELS: Record<NexusStatus, string> = {
  idle:       "Nexus",
  listening:  "Ouvindo",
  processing: "Processando",
  responding: "Respondendo",
  error:      "Erro",
};

interface StatusIndicatorProps {
  status: NexusStatus;
}

export function StatusIndicator({ status }: StatusIndicatorProps) {
  return (
    <div className="status-indicator" aria-live="polite" aria-label={`Status: ${STATUS_LABELS[status]}`}>
      <div className="status-dot" data-status={status} />
      <span className="status-label" data-status={status}>
        {STATUS_LABELS[status]}
      </span>
    </div>
  );
}

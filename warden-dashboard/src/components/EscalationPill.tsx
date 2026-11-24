interface EscalationPillProps {
  escalatedAt: string | null;
}

/** Renders only from the server's escalatedAt; the client never infers delivery. */
export default function EscalationPill({ escalatedAt }: EscalationPillProps) {
  if (!escalatedAt) {
    return null;
  }

  return (
    <span
      className="flex items-center gap-1 rounded-full bg-red-700 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-white"
      title={`Escalation SMS confirmed sent at ${new Date(escalatedAt).toLocaleTimeString()}`}
    >
      SMS sent {new Date(escalatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
    </span>
  );
}

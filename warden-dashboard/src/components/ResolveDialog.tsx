import { useState } from 'react';

const MIN_NOTE = 10;
const MAX_NOTE = 500;

interface ResolveDialogProps {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (resolutionNote: string) => void;
}

/**
 * Inline resolution note form for an ACKNOWLEDGED alert.
 *
 * The 10-char floor mirrors PATCH /alerts/:id/resolve, which rejects anything
 * shorter with a 400 — so the button stays disabled rather than letting the
 * warden discover the rule via an error. The note is trimmed before submission
 * so the client and server agree on the length they are validating.
 */
export default function ResolveDialog({
  busy,
  onCancel,
  onSubmit,
}: ResolveDialogProps) {
  const [note, setNote] = useState('');

  const trimmed = note.trim();
  const valid = trimmed.length >= MIN_NOTE && trimmed.length <= MAX_NOTE;

  return (
    <div className="mt-5 rounded-xl border border-emerald-900/60 bg-emerald-950/20 p-4">
      <label
        htmlFor="resolution-note"
        className="block text-sm font-semibold text-emerald-200"
      >
        Resolve this case
      </label>
      <p className="mt-1 text-xs text-slate-400">
        Record what you did. This becomes part of the audit trail.
      </p>

      <textarea
        id="resolution-note"
        autoFocus
        rows={4}
        maxLength={MAX_NOTE}
        value={note}
        disabled={busy}
        onChange={(event) => setNote(event.target.value)}
        placeholder="What did you do? e.g., Escorted to campus clinic, stable."
        className="mt-3 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-600 focus:outline-none disabled:opacity-60"
      />

      <div className="mt-1 flex items-center justify-between text-xs">
        <span className={valid ? 'text-emerald-300' : 'text-slate-500'}>
          {trimmed.length < MIN_NOTE
            ? `${MIN_NOTE - trimmed.length} more character${
                MIN_NOTE - trimmed.length === 1 ? '' : 's'
              } required`
            : 'Minimum met'}
        </span>
        <span className="text-slate-400" aria-live="polite">
          {note.length}/{MAX_NOTE}
        </span>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={!valid || busy}
          onClick={() => onSubmit(trimmed)}
          className="flex-1 rounded-lg bg-emerald-600 py-2.5 font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? 'Resolving...' : 'Submit resolution'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm text-slate-300 transition hover:bg-slate-800 disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
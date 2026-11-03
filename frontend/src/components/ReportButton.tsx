import { useState } from 'react';
import { Flag, X } from 'lucide-react';
import { api, REPORT_REASONS, type ReportReason } from '~/lib/api';
import { useAuth } from '~/hooks/useAuth';
import { SignInModal } from '~/components/SignInModal';
import { ErrorNote } from '~/components/ui';

/**
 * "Report" on a seed, peko, person, or group page (gap map B2). Signed out,
 * it asks to sign in first; signed in, it sends a reason and an optional
 * note to the moderators.
 *
 * `target` is the thing's ID: `alice/ada[@1.0.0]`, `@alice/ada`, `@alice`,
 * or a group's ID.
 */
export function ReportButton({ target, className = '' }: { target: string; className?: string }) {
  const { isAuthenticated } = useAuth();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`btn-ghost btn-sm text-slate-500 hover:text-slate-200 ${className}`}
      >
        <Flag className="h-3.5 w-3.5" />
        Report
      </button>
      {open &&
        (isAuthenticated ? (
          <ReportDialog target={target} onClose={() => setOpen(false)} />
        ) : (
          <SignInModal isOpen onClose={() => setOpen(false)} />
        ))}
    </>
  );
}

function ReportDialog({ target, onClose }: { target: string; onClose: () => void }) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (!reason) return;
    setSending(true);
    setError(null);
    try {
      await api.fileReport({ target, reason, note: note.trim() || undefined });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t go through');
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-950/80 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="card animate-scale-in relative w-full max-w-md bg-ink-900 p-7 shadow-lifted"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Report ${target}`}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-md p-1 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>

        <h2 className="text-lg font-semibold tracking-tight text-slate-50">
          Report <span className="font-mono text-base">{target}</span>
        </h2>

        {sent ? (
          <>
            <p className="mt-4 text-sm text-slate-300">Thanks. A PekoHub moderator will take a look.</p>
            <div className="mt-6 flex justify-end">
              <button type="button" onClick={onClose} className="btn-secondary btn-sm">
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <fieldset className="mt-5">
              <legend className="field-label">What’s wrong?</legend>
              <div className="mt-2 space-y-1.5">
                {REPORT_REASONS.map((option) => (
                  <label key={option.value} className="flex items-center gap-2.5 text-sm text-slate-300">
                    <input
                      type="radio"
                      name="report-reason"
                      value={option.value}
                      checked={reason === option.value}
                      onChange={() => setReason(option.value)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>

            <label htmlFor="report-note" className="field-label mt-5 block">
              Details <span className="text-slate-600">(optional)</span>
            </label>
            <textarea
              id="report-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={2000}
              rows={3}
              className="textarea mt-2 text-sm"
            />

            {error && (
              <div className="mt-4">
                <ErrorNote>{error}</ErrorNote>
              </div>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="btn-ghost btn-sm">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void send()}
                disabled={!reason || sending}
                className="btn-primary btn-sm"
              >
                {sending ? 'Sending…' : 'Send report'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Terms-of-service gate.
 *
 * Blocks the composer until the visitor acknowledges the peko's terms.
 * The acknowledgement is persisted per `ownerId/pekoName` so repeat
 * visitors skip it; every message after acceptance carries
 * `tos_acknowledged: true` so the backend's 428 path never trips.
 */

import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';

interface TermsGateProps {
  owner: string;
  pekoName: string;
  tosText: string;
  onAccept: () => void;
}

const STORAGE_PREFIX = 'pekohub:tos_acked:';

export function storageKey(owner: string, pekoName: string): string {
  return `${STORAGE_PREFIX}${owner}/${pekoName}`;
}

export function hasAcknowledged(owner: string, pekoName: string): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(storageKey(owner, pekoName)) === 'true';
}

export function TermsGate({ owner, pekoName, tosText, onAccept }: TermsGateProps) {
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    setAccepted(hasAcknowledged(owner, pekoName));
  }, [owner, pekoName]);

  const handleAccept = () => {
    localStorage.setItem(storageKey(owner, pekoName), 'true');
    setAccepted(true);
    onAccept();
  };

  if (accepted) return null;

  return (
    <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-5">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="eyebrow text-amber-300">before you start</p>
          <h2 className="mt-1.5 text-sm font-semibold text-slate-100">Terms of Service</h2>
          <div className="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-ink-950/60 p-3.5 text-[13px] leading-relaxed text-slate-400">
            {tosText}
          </div>
          <button onClick={handleAccept} className="btn-primary mt-4" data-testid="terms-accept">
            I agree — start chatting
          </button>
        </div>
      </div>
    </div>
  );
}

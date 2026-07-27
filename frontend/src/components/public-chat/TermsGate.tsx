/**
 * Terms-of-service gate (PR-C4).
 *
 * Renders a blocking modal before exposing the chat input when the
 * principal requires a ToS acknowledgment. The acknowledgment is
 * persisted to `localStorage` keyed by `${owner}/${principalName}`
 * so repeat visitors skip the gate; on submit the next message
 * carries `tos_acknowledged: true` so the server-side 428 path
 * (`backend/src/routes/api/instances.ts:1075`) doesn't trip.
 */

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";

interface TermsGateProps {
  owner: string;
  principalName: string;
  tosText: string;
  onAccept: () => void;
}

const STORAGE_PREFIX = "pekohub:tos_acked:";

export function storageKey(owner: string, principalName: string): string {
  return `${STORAGE_PREFIX}${owner}/${principalName}`;
}

export function hasAcknowledged(owner: string, principalName: string): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(storageKey(owner, principalName)) === "true";
}

export function TermsGate({
  owner,
  principalName,
  tosText,
  onAccept,
}: TermsGateProps) {
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    setAccepted(hasAcknowledged(owner, principalName));
  }, [owner, principalName]);

  const handleAccept = () => {
    localStorage.setItem(storageKey(owner, principalName), "true");
    setAccepted(true);
    onAccept();
  };

  if (accepted) return null;

  return (
    <div className="card p-5">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-peko-600" />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-gray-900">
            Terms of Service
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
            {tosText}
          </p>
          <button
            onClick={handleAccept}
            className="btn-primary mt-4"
            data-testid="terms-accept"
          >
            I agree — start chatting
          </button>
        </div>
      </div>
    </div>
  );
}
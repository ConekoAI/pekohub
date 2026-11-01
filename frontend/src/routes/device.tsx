/**
 * `/device` — approve a sign-in started on another device (RFC 8628).
 *
 * `peko runtime register` prints a code and this page's address. The user
 * signs in here, types (or arrives with) the code, and allows the request;
 * the CLI, polling the token endpoint, then receives its tokens.
 */

import { createFileRoute } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useAuth } from '~/hooks/useAuth';
import { api, type OAuthDeviceRequest } from '~/lib/api';
import {
  ConsentDone,
  ConsentLoading,
  ConsentProblem,
  ConsentPrompt,
  ConsentShell,
  ConsentSignIn,
} from '~/components/oauth/ConsentCard';
import { Spinner } from '~/components/ui';

export const Route = createFileRoute('/device')({
  component: DevicePage,
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search.code === 'string' ? search.code : undefined,
  }),
});

/** `abcdefgh` / `ABCD EFGH` → `ABCD-EFGH` while typing. */
export function formatUserCodeInput(raw: string): string {
  const letters = raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8);
  return letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
}

function DevicePage() {
  const { code: initialCode } = Route.useSearch();
  const { user, isLoading, logout } = useAuth();
  const [code, setCode] = useState(formatUserCodeInput(initialCode ?? ''));
  const [request, setRequest] = useState<OAuthDeviceRequest | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<'approved' | 'denied' | 'failed' | null>(null);

  if (isLoading) {
    return (
      <ConsentShell>
        <ConsentLoading label="Loading…" />
      </ConsentShell>
    );
  }
  if (!user) {
    return (
      <ConsentShell>
        <ConsentSignIn appName="Peko" />
      </ConsentShell>
    );
  }

  if (outcome === 'approved') {
    return (
      <ConsentShell>
        <ConsentDone
          title={`${request?.client.name ?? 'Peko'} is signed in`}
          body="Go back to your terminal — it continues on its own. You can close this tab."
        />
      </ConsentShell>
    );
  }
  if (outcome === 'denied') {
    return (
      <ConsentShell>
        <ConsentProblem title="Request denied" body="Nothing was signed in. You can close this tab." />
      </ConsentShell>
    );
  }
  if (outcome === 'failed') {
    return (
      <ConsentShell>
        <ConsentProblem
          title="That didn't go through"
          body="The code may have expired. Run the command in your terminal again for a new one."
        />
      </ConsentShell>
    );
  }

  if (request) {
    const decide = async (approve: boolean) => {
      setBusy(true);
      try {
        const { status } = await api.decideDeviceCode(request.userCode, approve);
        setOutcome(status);
      } catch {
        setOutcome('failed');
      } finally {
        setBusy(false);
      }
    };
    return (
      <ConsentShell>
        <ConsentPrompt
          appName={request.client.name}
          user={user}
          busy={busy}
          onDecide={(approve) => void decide(approve)}
          onSignOut={() => void logout()}
          note={
            <>
              Code <span className="font-mono text-slate-300">{request.userCode}</span>. Only allow this if
              you started it yourself and the code matches your terminal.
            </>
          }
        />
      </ConsentShell>
    );
  }

  const lookUp = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setLookupError(null);
    try {
      setRequest(await api.describeDeviceCode(code));
    } catch {
      setLookupError('That code is not valid or has expired. Check the code in your terminal.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConsentShell>
      <p className="eyebrow">connect a device</p>
      <h1 className="display mt-2 text-xl">Enter the code from your terminal</h1>
      <p className="lede mt-1.5">
        Signing in as <span className="text-slate-200">@{user.namespace}</span>.
      </p>
      <form onSubmit={(event) => void lookUp(event)} className="mt-6 space-y-3">
        <label htmlFor="user-code" className="sr-only">
          Device code
        </label>
        <input
          id="user-code"
          value={code}
          onChange={(event) => setCode(formatUserCodeInput(event.target.value))}
          placeholder="ABCD-EFGH"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          className="input text-center font-mono text-lg tracking-[0.3em]"
          aria-invalid={lookupError !== null}
          aria-describedby={lookupError ? 'user-code-error' : undefined}
        />
        {lookupError && (
          <p id="user-code-error" className="text-2xs text-rose-300">
            {lookupError}
          </p>
        )}
        <button type="submit" disabled={busy || code.length !== 9} className="btn-primary w-full justify-center">
          {busy ? <Spinner className="h-4 w-4" /> : null}
          Continue
        </button>
      </form>
    </ConsentShell>
  );
}

/**
 * `/welcome` — choose your handle, once, after first sign-in.
 *
 * First sign-in suggests a handle from the GitHub login or the Google
 * name. The handle is the person's ID (`@alice`) and names their seeds
 * and public pekos, so they keep it or pick another before going on.
 * It can change here until something is published under it.
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { UserProfile } from '@pekohub/shared';
import { useAuth } from '~/hooks/useAuth';
import { api, isApiError, setAuthToken, type HandleRefusal } from '~/lib/api';
import { ErrorNote, Spinner } from '~/components/ui';

export const Route = createFileRoute('/welcome')({
  head: () => ({ meta: [{ title: 'Choose your handle — PekoHub' }] }),
  component: WelcomePage,
  validateSearch: (search: Record<string, unknown>) => ({
    next:
      typeof search.next === 'string' && search.next.startsWith('/') && !search.next.startsWith('//')
        ? search.next
        : undefined,
  }),
});

const HANDLE_MAX = 39;
const FORMAT = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

const REFUSALS: Record<HandleRefusal, string> = {
  invalid: 'Use 2 to 39 lowercase letters, digits, - or _, starting and ending with a letter or digit.',
  reserved: 'That handle is kept for PekoHub itself.',
  taken: 'Someone already has that handle.',
  locked: 'Your handle is fixed: something is already published under it.',
};

/** What the person typed, as a handle: lowercase, no leading `@`, no spaces. */
function normalize(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase().replace(/\s+/g, '-');
}

function formatProblem(handle: string): HandleRefusal | null {
  return handle.length < 2 || handle.length > HANDLE_MAX || !FORMAT.test(handle) ? 'invalid' : null;
}

/** `value`, once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

function WelcomePage() {
  const { user, isLoading } = useAuth();
  const navigate = useNavigate();
  const { next } = Route.useSearch();

  useEffect(() => {
    if (!isLoading && !user) void navigate({ to: '/', replace: true });
  }, [isLoading, user, navigate]);

  return (
    <div className="mx-auto flex min-h-[72vh] max-w-md flex-col justify-center px-5 py-12">
      <div className="card w-full animate-fade-up p-7 sm:p-8">
        {user ? (
          <HandleForm user={user} next={next} />
        ) : (
          <div className="flex justify-center py-8 text-slate-500">
            <Spinner className="h-5 w-5" />
          </div>
        )}
      </div>
    </div>
  );
}

function HandleForm({ user, next }: { user: UserProfile; next: string | undefined }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [input, setInput] = useState(user.namespace);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<{ handle: string; reason: HandleRefusal } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const locked = user.handleLocked === true;

  const handle = normalize(input);
  const isCurrent = handle === user.namespace;
  const localProblem = isCurrent ? null : formatProblem(handle);
  const settled = useSettled(handle, 300);
  const check = useQuery({
    queryKey: ['handle-check', settled],
    queryFn: () => api.checkHandle(settled),
    enabled: !locked && !isCurrent && !localProblem && settled === handle,
    staleTime: 10_000,
    retry: false,
  });

  const checking = !isCurrent && !localProblem && (settled !== handle || check.isFetching);
  const problem: HandleRefusal | null =
    localProblem ??
    (refused?.handle === handle ? refused.reason : null) ??
    (!isCurrent && check.data && !check.data.available && check.data.handle === handle
      ? check.data.reason
      : null);
  const canSubmit = !saving && !problem && !checking && (isCurrent || check.data?.available === true);

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setFailed(null);
    try {
      const chosen = await api.chooseHandle(handle);
      setAuthToken(chosen.token);
      queryClient.setQueryData<UserProfile | null>(['auth', 'me'], (me) =>
        me
          ? { ...me, namespace: chosen.namespace, handleChosen: true, handleLocked: chosen.handleLocked }
          : me,
      );
      void queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      if (next) await navigate({ href: next, replace: true });
      else await navigate({ to: '/dashboard', replace: true });
    } catch (error) {
      const code = isApiError(error) ? (error.body as { code?: unknown } | undefined)?.code : undefined;
      if (typeof code === 'string' && code in REFUSALS) {
        setRefused({ handle, reason: code as HandleRefusal });
      } else {
        setFailed(error instanceof Error ? error.message : 'Could not save your handle');
      }
    } finally {
      setSaving(false);
    }
  };

  const host = typeof window === 'undefined' ? 'pekohub.ai' : window.location.host;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h1 className="text-lg font-semibold text-slate-50">
        {locked ? 'Your handle' : user.handleChosen ? 'Change your handle' : 'Choose your handle'}
      </h1>
      <p className="mt-1.5 text-sm text-slate-400">
        {locked
          ? 'People find you by it, and your seeds and public pekos are named under it, so it stays as it is.'
          : 'People find you by it, and your seeds and public pekos will be named under it. You can change it until you publish something.'}
      </p>

      <label htmlFor="handle" className="field-label mt-6 block">
        Handle
      </label>
      <div className="relative mt-1.5">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-slate-500">@</span>
        <input
          id="handle"
          className="input pl-7 pr-9 font-mono"
          value={input}
          onChange={(event) => {
            // Handles are lowercase; show it as it will be.
            setInput(event.target.value.replace(/^@+/, '').toLowerCase());
            setFailed(null);
          }}
          maxLength={HANDLE_MAX + 1}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus={!locked}
          readOnly={locked}
          aria-invalid={problem ? true : undefined}
          aria-describedby="handle-status"
        />
        <span className="absolute inset-y-0 right-3 flex items-center" aria-hidden>
          {checking ? (
            <Spinner className="h-3.5 w-3.5 text-slate-500" />
          ) : problem ? (
            <X className="h-4 w-4 text-rose-300" />
          ) : handle ? (
            <Check className="h-4 w-4 text-slate-100" />
          ) : null}
        </span>
      </div>
      <p id="handle-status" className="mt-2 min-h-[2.5rem] text-xs" aria-live="polite">
        {problem ? (
          <span className="text-rose-300">{REFUSALS[problem]}</span>
        ) : check.isError && !isCurrent ? (
          <span className="text-rose-300">Couldn&apos;t check that handle. Try again.</span>
        ) : (
          <span className="text-slate-500">
            Your page: <span className="font-mono text-slate-300">{host}/@{handle || '…'}</span>
          </span>
        )}
      </p>

      {failed && (
        <div className="mt-2">
          <ErrorNote>{failed}</ErrorNote>
        </div>
      )}

      <button type="submit" className="btn-primary mt-4 w-full" disabled={!canSubmit}>
        {saving && <Spinner className="h-4 w-4" />}
        {isCurrent ? `Continue as @${user.namespace}` : `Continue as @${handle || '…'}`}
      </button>
    </form>
  );
}

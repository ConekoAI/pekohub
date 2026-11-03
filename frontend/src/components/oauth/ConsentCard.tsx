import type { ReactNode } from 'react';
import { CheckCircle2, Cpu, Globe, KeyRound, ShieldAlert } from 'lucide-react';
import type { UserProfile } from '@pekohub/shared';
import { Avatar, Spinner } from '~/components/ui';
import { SignInOptions } from '~/components/SignInModal';

/** Centered single-card layout shared by the sign-in consent pages. */
export function ConsentShell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[72vh] max-w-md flex-col justify-center px-5 py-12">
      <div className="card w-full animate-fade-up p-7 sm:p-8">{children}</div>
    </div>
  );
}

export function ConsentLoading({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-sm text-slate-500">
      <Spinner className="h-5 w-5" />
      {label}
    </div>
  );
}

/** A dead end with a clear next step — never a raw error string. */
export function ConsentProblem({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div className="text-center">
      <ShieldAlert className="mx-auto h-7 w-7 text-rose-300" />
      <h1 className="mt-4 text-lg font-semibold text-slate-50">{title}</h1>
      <p className="mt-1.5 text-sm text-slate-400">{body}</p>
    </div>
  );
}

export function ConsentDone({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div className="text-center">
      <CheckCircle2 className="mx-auto h-7 w-7 text-peko-300" />
      <h1 className="mt-4 text-lg font-semibold text-slate-50">{title}</h1>
      <p className="mt-1.5 text-sm text-slate-400">{body}</p>
    </div>
  );
}

/** Signed out: sign in here, then come straight back to this request. */
export function ConsentSignIn({ appName }: { appName: string }) {
  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-50">Sign in to continue to {appName}</h1>
      <div className="mt-6">
        <SignInOptions />
      </div>
    </div>
  );
}

/** What an app can do once the user allows it. */
const GRANTS = [
  { icon: Cpu, text: 'Register your computers' },
  { icon: Globe, text: 'Put your pekos online and reach others' },
  { icon: KeyRound, text: 'Publish and manage your seeds' },
];

/** "<app> wants to sign in as <you>" with Allow / Cancel. */
export function ConsentPrompt({
  appName,
  user,
  note,
  busy,
  onDecide,
  onSignOut,
}: {
  appName: string;
  user: UserProfile;
  note?: ReactNode;
  busy: boolean;
  onDecide: (approve: boolean) => void;
  onSignOut: () => void;
}) {
  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-50">{appName} wants to use your PekoHub account</h1>

      <div className="mt-5 flex items-center gap-3 rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-3">
        <Avatar name={user.displayName ?? user.namespace} src={user.avatarUrl ?? undefined} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-slate-200">{user.displayName ?? user.namespace}</p>
          <p className="truncate text-xs text-slate-500">@{user.namespace}</p>
        </div>
        <button type="button" onClick={onSignOut} className="text-xs text-slate-500 hover:text-slate-300">
          Not you?
        </button>
      </div>

      <ul className="mt-5 space-y-2.5">
        {GRANTS.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-start gap-2.5 text-[13px] text-slate-300">
            <Icon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-slate-500" />
            {text}
          </li>
        ))}
      </ul>

      {note && <p className="mt-5 text-xs leading-relaxed text-slate-500">{note}</p>}

      <div className="mt-6 flex gap-2.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide(false)}
          className="btn-secondary flex-1 justify-center"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide(true)}
          className="btn-primary flex-1 justify-center"
        >
          {busy ? <Spinner className="h-4 w-4" /> : null}
          Allow
        </button>
      </div>
    </div>
  );
}

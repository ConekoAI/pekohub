import type { ReactNode } from 'react';
import { CheckCircle2, Cpu, Globe, KeyRound, ShieldAlert } from 'lucide-react';
import type { UserProfile } from '@pekohub/shared';
import { Avatar, Backdrop, Spinner } from '~/components/ui';
import { SignInOptions } from '~/components/SignInModal';

/** Centered single-card layout shared by the sign-in consent pages. */
export function ConsentShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate">
      <Backdrop />
      <div className="mx-auto flex min-h-[72vh] max-w-md flex-col justify-center px-4 py-12">
        <div className="panel w-full animate-fade-up p-7 sm:p-8">{children}</div>
      </div>
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
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-rose-400/25 bg-rose-500/[0.08]">
        <ShieldAlert className="h-6 w-6 text-rose-400" />
      </div>
      <h1 className="display mt-5 text-xl">{title}</h1>
      <p className="lede mt-2">{body}</p>
    </div>
  );
}

export function ConsentDone({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div className="text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-emerald-400/25 bg-emerald-500/[0.08]">
        <CheckCircle2 className="h-6 w-6 text-emerald-400" />
      </div>
      <h1 className="display mt-5 text-xl">{title}</h1>
      <p className="lede mt-2">{body}</p>
    </div>
  );
}

/** Signed out: sign in here, then come straight back to this request. */
export function ConsentSignIn({ appName }: { appName: string }) {
  return (
    <div>
      <p className="eyebrow">PekoHub account</p>
      <h1 className="display mt-2 text-xl">Sign in to continue to {appName}</h1>
      <p className="lede mt-1.5">After you sign in, you&apos;ll confirm this request here.</p>
      <div className="mt-6">
        <SignInOptions />
      </div>
    </div>
  );
}

/** What an app can do once the user allows it. */
const GRANTS = [
  { icon: Cpu, text: 'Register runtimes on your computers under your account' },
  { icon: Globe, text: 'List your pekos in the directory and look up others' },
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
      <p className="eyebrow">sign-in request</p>
      <h1 className="display mt-2 text-xl">{appName} wants to use your PekoHub account</h1>

      <div className="mt-5 flex items-center gap-3 rounded-lg border border-white/[0.07] bg-ink-900/60 px-3.5 py-3">
        <Avatar name={user.displayName ?? user.namespace} src={user.avatarUrl ?? undefined} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-slate-200">{user.displayName ?? user.namespace}</p>
          <p className="truncate font-mono text-2xs text-slate-500">@{user.namespace}</p>
        </div>
        <button type="button" onClick={onSignOut} className="text-2xs text-slate-500 hover:text-slate-300">
          Not you?
        </button>
      </div>

      <ul className="mt-5 space-y-2.5">
        {GRANTS.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-start gap-2.5 text-[13px] text-slate-300">
            <Icon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-peko-300" />
            {text}
          </li>
        ))}
      </ul>

      {note && <p className="mt-5 text-2xs leading-relaxed text-slate-500">{note}</p>}

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

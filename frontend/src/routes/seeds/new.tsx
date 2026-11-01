/**
 * `/seeds/new` — publish a seed.
 *
 * Paste or drop the `<name>.seed.toml` that `peko seed <name>` writes, pick
 * a version, optionally add a README. The Hub checks the seed — it refuses
 * one that carries an identity, an owner, or grants — and publishes it as
 * `<your handle>/<name>`.
 */

import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, type DragEvent, type FormEvent } from 'react';
import { ArrowLeft, FileUp, Terminal } from 'lucide-react';
import { api } from '~/lib/api';
import { useAuth } from '~/hooks/useAuth';
import { PageHeader, PageShell } from '~/components/PageShell';
import { SignInOptions } from '~/components/SignInModal';
import { Spinner } from '~/components/ui';

export const Route = createFileRoute('/seeds/new')({
  head: () => ({ meta: [{ title: 'Publish a seed — PekoHub' }] }),
  component: PublishSeedPage,
});

const MAX_BYTES = 64 * 1024;
const VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;

function PublishSeedPage() {
  const { user, isLoading } = useAuth();

  return (
    <PageShell width="narrow">
      <Link
        to="/seeds"
        className="inline-flex items-center gap-1.5 font-mono text-2xs text-slate-500 transition-colors hover:text-peko-300"
      >
        <ArrowLeft className="h-3 w-3" />
        all seeds
      </Link>
      <div className="mt-5">
        <PageHeader
          eyebrow="registry"
          title="Publish a seed"
          description="Share what one of your pekos grows from. Others get its definition — never its identity, memory, or keys."
        />
      </div>
      <div className="mt-8">
        {isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner className="h-5 w-5" />
          </div>
        ) : user ? (
          <PublishForm handle={user.namespace} />
        ) : (
          <div className="panel max-w-sm p-6">
            <p className="text-sm text-slate-300">Sign in to publish under your handle.</p>
            <div className="mt-4">
              <SignInOptions />
            </div>
          </div>
        )}
      </div>
    </PageShell>
  );
}

function PublishForm({ handle }: { handle: string }) {
  const navigate = useNavigate();
  const [seed, setSeed] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [readme, setReadme] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const versionValid = VERSION_PATTERN.test(version);
  const tooBig = new Blob([seed]).size > MAX_BYTES;

  const readFile = async (file: File) => {
    if (file.size > MAX_BYTES) {
      setError('A seed is at most 64 KB.');
      return;
    }
    setSeed(await file.text());
    setError(null);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void readFile(file);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const published = await api.publishSeed({
        seed,
        version,
        ...(readme.trim() ? { readme } : {}),
      });
      void navigate({ to: '/seeds/$', params: { _splat: `${published.owner}/${published.name}` } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Publishing failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-6">
      <div className="panel flex items-start gap-3 p-4 text-[13px] text-slate-400">
        <Terminal className="mt-0.5 h-4 w-4 flex-shrink-0 text-peko-300" />
        <p>
          Export the seed from your peko first:{' '}
          <code className="code-inline">peko seed &lt;name&gt; -o &lt;name&gt;.seed.toml</code>. It
          strips the identity, owner, and grants for you.
        </p>
      </div>

      <div>
        <label htmlFor="seed-toml" className="text-sm font-medium text-slate-200">
          Seed
        </label>
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`mt-2 rounded-lg border ${dragging ? 'border-peko-400/60 bg-peko-400/[0.04]' : 'border-transparent'}`}
        >
          <textarea
            id="seed-toml"
            value={seed}
            onChange={(event) => setSeed(event.target.value)}
            rows={12}
            spellCheck={false}
            className="textarea font-mono text-xs"
            placeholder={'name = "ada"\npreferred_model_id = "…"\n\n[identity]\ndisplay_name = "Ada"\ndescription = "…"'}
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-2xs text-slate-500">
          <label className="inline-flex cursor-pointer items-center gap-1.5 hover:text-slate-300">
            <FileUp className="h-3.5 w-3.5" />
            Choose a file, or drop it on the box
            <input
              type="file"
              accept=".toml,text/plain,application/toml"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readFile(file);
              }}
            />
          </label>
          {tooBig && <span className="text-rose-300">Over 64 KB</span>}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="seed-version" className="text-sm font-medium text-slate-200">
            Version
          </label>
          <input
            id="seed-version"
            value={version}
            onChange={(event) => setVersion(event.target.value.trim())}
            className="input mt-2 font-mono"
            aria-invalid={!versionValid}
          />
          <p className={`mt-1.5 text-2xs ${versionValid ? 'text-slate-500' : 'text-rose-300'}`}>
            Like 1.0.0. Published versions can&apos;t change.
          </p>
        </div>
        <div>
          <p className="text-sm font-medium text-slate-200">Published as</p>
          <p className="mt-2 rounded-lg border border-white/[0.07] bg-ink-900/60 px-3 py-2 font-mono text-[13px] text-slate-300">
            {handle}/<span className="text-slate-500">&lt;its name&gt;</span>
          </p>
        </div>
      </div>

      <div>
        <label htmlFor="seed-readme" className="text-sm font-medium text-slate-200">
          README <span className="font-normal text-slate-500">(optional, Markdown)</span>
        </label>
        <textarea
          id="seed-readme"
          value={readme}
          onChange={(event) => setReadme(event.target.value)}
          rows={6}
          className="textarea mt-2 text-sm"
          placeholder="What this peko is good at, and how to get the most out of it."
        />
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-rose-400/25 bg-rose-500/[0.06] px-3.5 py-2.5 text-[13px] text-rose-200">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || !seed.trim() || !versionValid || tooBig}
        className="btn-primary w-full justify-center"
      >
        {busy ? <Spinner className="h-4 w-4" /> : null}
        Publish
      </button>
    </form>
  );
}

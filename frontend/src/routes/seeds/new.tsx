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
import { ArrowLeft, FileUp } from 'lucide-react';
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
      <Link to="/dashboard/seeds" className="back-link">
        <ArrowLeft className="h-3.5 w-3.5" />
        Your seeds
      </Link>
      <PageHeader title="Publish a seed" />
      <div className="mt-8">
        {isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner className="h-5 w-5" />
          </div>
        ) : user ? (
          <PublishForm handle={user.namespace} />
        ) : (
          <div className="max-w-xs">
            <SignInOptions />
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
      void navigate({ to: '/$owner/$name', params: { owner: published.owner, name: published.name } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Publishing failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-6">
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor="seed-toml" className="field-label">
            Seed
          </label>
          <code className="text-xs text-slate-500">peko seed &lt;name&gt;</code>
        </div>
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`mt-2 rounded-lg ring-2 transition-shadow ${dragging ? 'ring-peko-500/50' : 'ring-transparent'}`}
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
        <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
          <label className="inline-flex cursor-pointer items-center gap-1.5 hover:text-slate-300">
            <FileUp className="h-3.5 w-3.5" />
            Choose a file
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
          <label htmlFor="seed-version" className="field-label">
            Version
          </label>
          <input
            id="seed-version"
            value={version}
            onChange={(event) => setVersion(event.target.value.trim())}
            className="input mt-2 font-mono"
            aria-invalid={!versionValid}
          />
          {!versionValid && <p className="mt-1.5 text-xs text-rose-300">Like 1.0.0</p>}
        </div>
        <div>
          <p className="field-label">Published as</p>
          <p className="mt-2 rounded-lg border border-ink-700 px-3 py-2 font-mono text-[13px] text-slate-300">
            {handle}/<span className="text-slate-500">&lt;name&gt;</span>
          </p>
        </div>
      </div>

      <div>
        <label htmlFor="seed-readme" className="field-label">
          README <span className="font-normal text-slate-500">(optional)</span>
        </label>
        <textarea
          id="seed-readme"
          value={readme}
          onChange={(event) => setReadme(event.target.value)}
          rows={6}
          className="textarea mt-2 text-sm"
          placeholder="Markdown"
        />
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-rose-400/20 bg-rose-400/[0.06] px-3.5 py-2.5 text-[13px] text-rose-200">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || !seed.trim() || !versionValid || tooBig}
        className="btn-primary"
      >
        {busy ? <Spinner className="h-4 w-4" /> : null}
        Publish
      </button>
    </form>
  );
}

import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, Cpu, Download, FileCode2, GitBranch, Terminal, Trash2 } from 'lucide-react';
import { api, isApiError, type SeedDetail } from '~/lib/api';
import { useAuth } from '~/hooks/useAuth';
import { useSeed } from '~/hooks/useSeed';
import { compactNumber, formatBytes, formatDate, relativeTime, shortDigest } from '~/lib/format';
import { PageShell } from '~/components/PageShell';
import { Avatar, Badge, CopyButton, ErrorNote, Spinner, Stat } from '~/components/ui';

/**
 * Seed detail — `/seeds/<owner>/<name>`.
 *
 * What the seed is, what it contains, and the two steps to grow one:
 * download the file, then `peko create <name> -s <file>`. The publisher
 * also gets version actions (deprecate, delete) here.
 *
 * Routing note: a splat inside `seeds/` (not a flat `seeds_.$.tsx`), so
 * bare `/seeds` stays the directory. Legacy `/bundles/*` and
 * `/templates/*` links redirect here.
 */
export const Route = createFileRoute('/seeds/$')({
  component: SeedDetailPage,
});

function SeedDetailPage() {
  const { _splat } = Route.useParams();
  const segments = (_splat ?? '').split('/').filter(Boolean);
  const [owner, name] = segments.length === 2 ? segments : ['', ''];
  const seed = useSeed(owner, name);

  if (!owner || !name) throw notFound();
  if (seed.isLoading) {
    return (
      <PageShell width="default">
        <div className="flex items-center justify-center gap-2.5 py-32 text-sm text-slate-500">
          <Spinner className="h-4 w-4" />
          Loading seed…
        </div>
      </PageShell>
    );
  }
  if (seed.isError) {
    if (isApiError(seed.error) && seed.error.status === 404) throw notFound();
    return (
      <PageShell width="default">
        <ErrorNote>PekoHub isn&apos;t answering right now. Try again in a moment.</ErrorNote>
      </PageShell>
    );
  }
  if (!seed.data) throw notFound();

  return (
    <PageShell width="default">
      <SeedBody data={seed.data} />
    </PageShell>
  );
}

function SeedBody({ data }: { data: SeedDetail }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showToml, setShowToml] = useState(false);
  const owner = data.owner.handle;
  const isPublisher = user?.namespace === owner;
  const fileName = `${data.name}.seed.toml`;

  const run = async (key: string, action: () => Promise<unknown>, after?: () => void) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ['seed', owner, data.name] });
      after?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t go through');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Link
        to="/seeds"
        className="inline-flex items-center gap-1.5 font-mono text-2xs text-slate-500 transition-colors hover:text-peko-300"
      >
        <ArrowLeft className="h-3 w-3" />
        all seeds
      </Link>

      <header className="mt-5 flex flex-wrap items-start gap-4">
        <span className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl border border-iris-400/25 bg-iris-400/[0.07] text-2xl">
          {data.avatar ?? <span className="font-mono text-base text-iris-300">{data.name.slice(0, 2)}</span>}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="display truncate text-2xl">{data.displayName ?? data.name}</h1>
            <Badge tone="iris">seed</Badge>
          </div>
          <p className="mt-1 font-mono text-2xs text-slate-500">
            {owner}/{data.name} · v{data.latestVersion}
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <Avatar name={data.owner.displayName} src={data.owner.avatarUrl} size="xs" />
            <span className="text-[13px] text-slate-400">
              published by <span className="font-medium text-slate-300">{data.owner.displayName}</span>
            </span>
          </div>
        </div>
      </header>

      {data.description && (
        <p className="mt-5 max-w-2xl text-sm leading-relaxed text-slate-300">{data.description}</p>
      )}

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <section className="panel p-6">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-slate-100">
              <Terminal className="h-4 w-4 text-peko-300" />
              Grow a peko from this seed
            </h2>
            <ol className="mt-4 space-y-4 text-[13px] text-slate-400">
              <li>
                <p>
                  <span className="mr-2 font-mono text-slate-600">1</span>Download{' '}
                  <span className="font-mono text-slate-300">{fileName}</span>
                </p>
                <a href={data.downloadUrl} download={fileName} className="btn-secondary btn-sm mt-2">
                  <Download className="h-3.5 w-3.5" />
                  Download v{data.latestVersion}
                </a>
              </li>
              <li>
                <p>
                  <span className="mr-2 font-mono text-slate-600">2</span>Create your peko from it — it
                  gets a new identity, and you own it
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <code className="code-block flex-1 text-xs">{data.createCommand}</code>
                  <CopyButton value={data.createCommand} label="Copy" className="btn-ghost btn-sm" />
                </div>
                {data.model && (
                  <p className="mt-2 flex items-center gap-1.5 text-2xs text-slate-500">
                    <Cpu className="h-3 w-3" />
                    Written for <span className="font-mono text-slate-400">{data.model}</span>. Add{' '}
                    <code className="code-inline">--model</code> to use another.
                  </p>
                )}
              </li>
            </ol>
          </section>

          {data.readme && (
            <section className="panel p-6">
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.readme}</ReactMarkdown>
              </div>
            </section>
          )}

          <section className="panel p-6">
            <button
              type="button"
              onClick={() => setShowToml((v) => !v)}
              className="flex w-full items-center gap-2 text-left text-[15px] font-semibold text-slate-100"
              aria-expanded={showToml}
            >
              <FileCode2 className="h-4 w-4 text-iris-300" />
              What&apos;s in it
              <span className="ml-auto text-2xs font-normal text-slate-500">{showToml ? 'Hide' : 'Show'} the TOML</span>
            </button>
            {showToml && (
              <pre className="code-block mt-4 max-h-[28rem] overflow-auto whitespace-pre text-xs">{data.content}</pre>
            )}
          </section>
        </div>

        <aside className="space-y-6">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="downloads" value={compactNumber(data.pullCount.allTime)} />
            <Stat label="this week" value={compactNumber(data.pullCount.weekly)} />
          </div>

          <section className="panel p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <GitBranch className="h-4 w-4 text-slate-400" />
              Versions
            </h2>
            {error && <p className="mt-3 text-2xs text-rose-300">{error}</p>}
            <ul className="mt-3 divide-y divide-white/[0.05]">
              {data.versions.map((v) => (
                <li key={v.version} className="py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[13px] text-slate-200">v{v.version}</span>
                    {v.deprecated && <Badge tone="warn">deprecated</Badge>}
                    <span className="ml-auto text-2xs text-slate-500" title={formatDate(v.createdAt)}>
                      {relativeTime(v.createdAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 font-mono text-2xs text-slate-600">
                    {shortDigest(v.digest)} · {formatBytes(v.size)}
                  </p>
                  {v.deprecatedMessage && <p className="mt-1 text-2xs text-amber-200/70">{v.deprecatedMessage}</p>}
                  {isPublisher && (
                    <div className="mt-1.5 flex gap-3 text-2xs">
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(`deprecate:${v.version}`, () =>
                            api.setSeedVersionDeprecated(owner, data.name, v.version, !v.deprecated),
                          )
                        }
                        className="text-slate-500 hover:text-slate-300"
                      >
                        {v.deprecated ? 'Undeprecate' : 'Deprecate'}
                      </button>
                      {data.versions.length > 1 && (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => {
                            if (!window.confirm(`Delete v${v.version}? This can't be undone.`)) return;
                            void run(`delete:${v.version}`, () => api.deleteSeedVersion(owner, data.name, v.version));
                          }}
                          className="text-slate-500 hover:text-rose-300"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {isPublisher && (
            <section className="panel space-y-2.5 p-5">
              <Link to="/seeds/new" className="btn-secondary btn-sm w-full justify-center">
                Publish a new version
              </Link>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  if (!window.confirm(`Delete ${owner}/${data.name} and every version? This can't be undone.`)) return;
                  void run('delete:seed', () => api.deleteSeed(owner, data.name), () =>
                    void navigate({ to: '/seeds' }),
                  );
                }}
                className="btn-ghost btn-sm w-full justify-center text-rose-300 hover:text-rose-200"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete seed
              </button>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}

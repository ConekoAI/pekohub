import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, ChevronDown, Download } from 'lucide-react';
import { parseHubRef } from '@pekohub/shared';
import { api, isApiError, type SeedDetail } from '~/lib/api';
import { useAuth } from '~/hooks/useAuth';
import { useSeed } from '~/hooks/useSeed';
import { compactNumber, formatDate, relativeTime } from '~/lib/format';
import { PageShell } from '~/components/PageShell';
import { Avatar, Badge, CopyField, Loading, Tile, Unavailable } from '~/components/ui';

/**
 * Seed detail — `/alice/ada`, the seed's ID (hub ADR-009); a version,
 * `/alice/ada@1.2.0`, offers that version's file. The old
 * `/seeds/alice/ada` links (and `/bundles/…`, `/templates/…`) redirect here.
 *
 * What the seed is, what it contains, and the two steps to grow one:
 * download the file, then `peko create <name> -s <file>`. The publisher
 * also gets version actions (deprecate, delete) here.
 *
 * Routing note: `/@alice/ada` (a peko) is its own, more specific route;
 * every other two-segment path that isn't a page of its own lands here
 * and is not found unless it names a seed.
 */
export const Route = createFileRoute('/$owner/$name')({
  head: ({ params }) => ({ meta: [{ title: `${params.owner}/${params.name} — Seeds — PekoHub` }] }),
  component: SeedDetailPage,
});

function SeedDetailPage() {
  const params = Route.useParams();
  const ref = parseHubRef(`${params.owner}/${params.name}`);
  const [owner, name, version] = ref?.kind === 'seed' ? [ref.owner, ref.name, ref.version] : ['', '', undefined];
  const seed = useSeed(owner, name);

  if (!owner || !name) throw notFound();
  if (seed.isLoading) {
    return (
      <PageShell width="default">
        <Loading />
      </PageShell>
    );
  }
  if (seed.isError) {
    if (isApiError(seed.error) && seed.error.status === 404) throw notFound();
    return (
      <PageShell width="default">
        <Unavailable />
      </PageShell>
    );
  }
  if (!seed.data) throw notFound();
  if (version && !seed.data.versions.some((v) => v.version === version)) throw notFound();

  return (
    <PageShell width="default">
      <SeedBody data={seed.data} version={version ?? seed.data.latestVersion} />
    </PageShell>
  );
}

function SeedBody({ data, version }: { data: SeedDetail; version: string }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showToml, setShowToml] = useState(false);
  const owner = data.owner.handle;
  const isPublisher = user?.namespace === owner;
  const fileName = `${data.name}.seed.toml`;
  const downloadUrl = data.downloadUrl.replace(
    /\/versions\/[^/]+\/seed\.toml$/,
    `/versions/${encodeURIComponent(version)}/seed.toml`,
  );

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
      <Link to="/seeds" className="back-link">
        <ArrowLeft className="h-3.5 w-3.5" />
        Seeds
      </Link>

      <header className="flex flex-wrap items-start gap-5">
        <Tile avatar={data.avatar} name={data.name} size="lg" />
        <div className="min-w-[13rem] flex-1">
          <h1 className="h-page truncate">{data.displayName ?? data.name}</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-500">
            <span className="font-mono text-[13px]">
              {owner}/{data.name}
            </span>
            <span aria-hidden>·</span>
            <Link to="/@{$owner}" params={{ owner }} className="inline-flex items-center gap-1.5 whitespace-nowrap hover:text-slate-200">
              <Avatar name={data.owner.displayName} src={data.owner.avatarUrl} size="xs" />
              {data.owner.displayName}
            </Link>
          </p>
        </div>
        <a href={downloadUrl} download={fileName} className="btn-primary w-full sm:w-auto">
          <Download className="h-4 w-4" />
          Download v{version}
        </a>
      </header>

      {data.description && <p className="mt-6 max-w-2xl text-[15px] leading-relaxed text-slate-300">{data.description}</p>}

      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="min-w-0 space-y-10">
          <section>
            <h2 className="h-section mb-3">Grow a peko</h2>
            <CopyField value={data.createCommand} />
            {data.model && (
              <p className="mt-2 text-xs text-slate-500">
                Written for <span className="text-slate-400">{data.model}</span>
              </p>
            )}
          </section>

          {data.readme && (
            <section className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.readme}</ReactMarkdown>
            </section>
          )}

          <section className="border-t border-ink-700 pt-6">
            <button
              type="button"
              onClick={() => setShowToml((v) => !v)}
              className="flex items-center gap-1.5 text-sm text-slate-400 transition-colors hover:text-slate-100"
              aria-expanded={showToml}
            >
              <ChevronDown className={`h-4 w-4 transition-transform ${showToml ? '' : '-rotate-90'}`} />
              {fileName}
              {version !== data.latestVersion && <span className="text-slate-600">(v{data.latestVersion})</span>}
            </button>
            {showToml && (
              <pre className="code-block mt-4 max-h-[28rem] overflow-auto whitespace-pre text-xs">{data.content}</pre>
            )}
          </section>
        </div>

        <aside className="space-y-8 text-sm">
          <dl className="grid grid-cols-2 gap-4">
            <div>
              <dt className="text-xs text-slate-500">Downloads</dt>
              <dd className="mt-1 text-lg font-semibold text-slate-100">{compactNumber(data.pullCount.allTime)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">This week</dt>
              <dd className="mt-1 text-lg font-semibold text-slate-100">{compactNumber(data.pullCount.weekly)}</dd>
            </div>
          </dl>

          <section>
            <h2 className="mb-2 text-xs text-slate-500">Versions</h2>
            {error && <p className="mb-2 text-xs text-rose-300">{error}</p>}
            <ul className="divide-y divide-ink-700">
              {data.versions.map((v) => (
                <li key={v.version} className="py-2.5">
                  <div className="flex items-center gap-2">
                    <Link
                      to="/$owner/$name"
                      params={{ owner, name: `${data.name}@${v.version}` }}
                      className={`font-mono text-[13px] hover:text-peko-200 ${v.version === version ? 'text-peko-300' : 'text-slate-300'}`}
                    >
                      {v.version}
                    </Link>
                    {v.deprecated && <Badge>deprecated</Badge>}
                    <span className="ml-auto text-xs text-slate-500" title={formatDate(v.createdAt)}>
                      {relativeTime(v.createdAt)}
                    </span>
                  </div>
                  {v.deprecatedMessage && <p className="mt-1 text-xs text-slate-500">{v.deprecatedMessage}</p>}
                  {isPublisher && (
                    <div className="mt-1 flex gap-3 text-xs">
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(`deprecate:${v.version}`, () =>
                            api.setSeedVersionDeprecated(owner, data.name, v.version, !v.deprecated),
                          )
                        }
                        className="text-slate-500 hover:text-slate-200"
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
            <section className="flex flex-col items-start gap-1 border-t border-ink-700 pt-6">
              <Link to="/seeds/new" className="btn-ghost btn-sm -ml-2.5">
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
                className="btn-danger btn-sm -ml-2.5"
              >
                Delete seed
              </button>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}

import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft,
  Boxes,
  Download,
  FileCode2,
  GitBranch,
  Terminal,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { api } from '~/lib/api';
import { useAuth } from '~/hooks/useAuth';
import { useTemplate, useTemplateVersions } from '~/hooks/useTemplate';
import { classifyRepo, laneLabel, splitInstallRef } from '~/lib/repo';
import { compactNumber, formatBytes, formatDate, relativeTime, shortDigest } from '~/lib/format';
import { PageShell } from '~/components/PageShell';
import { Badge, CopyButton, EmptyState, ErrorNote, Spinner, Stat } from '~/components/ui';

/**
 * Template detail.
 *
 * Read-mostly: a template's identity, its version history, its README
 * and the exact commands needed to use it. Publisher actions
 * (deprecate / delete a version, delete the template) are offered to
 * signed-in users and authorized server-side by publisher key.
 *
 * Deliberately absent: the pre-pivot extension surface (hook points,
 * runtime compatibility matrix, extension type) — capabilities are
 * workspace files now (runtime ADR-047 §5, ADR-050) and never travelled
 * through the registry as a package.
 *
 * Routing note: this lives in the `templates/` directory alongside
 * `index.tsx` rather than as a flat `templates_.$.tsx`. A splat matches
 * zero segments, so a flat `$` route would also match bare `/templates`
 * and shadow the directory listing.
 */
export const Route = createFileRoute('/templates/$')({
  component: TemplateDetailPage,
});

function TemplateDetailPage() {
  const { _splat } = Route.useParams();
  const segments = (_splat ?? '').split('/').filter(Boolean);
  const name = segments[segments.length - 1] ?? '';
  const namespace = segments.slice(0, -1).join('/');

  const template = useTemplate(namespace, name);

  if (!namespace || !name) throw notFound();

  if (template.isLoading) {
    return (
      <PageShell width="default">
        <div className="flex items-center justify-center gap-2.5 py-32 text-sm text-slate-500">
          <Spinner className="h-4 w-4" />
          Loading template…
        </div>
      </PageShell>
    );
  }

  if (template.isError || !template.data) throw notFound();

  return (
    <PageShell width="default">
      <TemplateBody
        namespace={template.data.namespace}
        name={template.data.name}
        data={template.data}
      />
    </PageShell>
  );
}

function TemplateBody({
  namespace,
  name,
  data,
}: {
  namespace: string;
  name: string;
  data: Awaited<ReturnType<typeof api.getBundle>>;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const repo = `${namespace}/${name}`;
  const ref = classifyRepo(repo);

  const versions = useTemplateVersions(namespace, name);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['template', namespace, name] });

  const onDeprecate = async (version: string, deprecated: boolean) => {
    setBusy(`deprecate:${version}`);
    setError(null);
    try {
      await api.deprecateVersion(namespace, name, version, deprecated);
      await invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the version');
    } finally {
      setBusy(null);
    }
  };

  const onDeleteVersion = async (version: string) => {
    if (!window.confirm(`Delete version ${version}? This cannot be undone.`)) return;
    setBusy(`delete:${version}`);
    setError(null);
    try {
      await api.deleteVersion(namespace, name, version);
      await invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the version');
    } finally {
      setBusy(null);
    }
  };

  const onDeleteTemplate = async () => {
    if (!window.confirm(`Delete ${repo} and every version? This cannot be undone.`)) return;
    setBusy('delete:template');
    setError(null);
    try {
      await api.deleteBundle(namespace, name);
      await invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the template');
    } finally {
      setBusy(null);
    }
  };

  const latest = data.versions[0]?.version ?? data.metadata.version ?? 'latest';
  const parsedRef = splitInstallRef(data.installCommand);
  const pullRef = parsedRef ? `${parsedRef.repo}:${parsedRef.tag ?? latest}` : data.installCommand;
  const createCommand = `peko create my-peko -f ${name}.template.toml`;
  const isDeprecated = data.metadata.deprecated === true;

  return (
    <div className="animate-fade-up">
      <Link
        to="/templates"
        className="inline-flex items-center gap-1.5 font-mono text-2xs text-slate-500 transition-colors hover:text-peko-300"
      >
        <ArrowLeft className="h-3 w-3" />
        all templates
      </Link>

      <header className="mt-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="iris">template</Badge>
          {ref && <Badge tone="neutral">{laneLabel(ref.lane)}</Badge>}
          {isDeprecated && (
            <Badge tone="warn">
              <TriangleAlert className="h-2.5 w-2.5" />
              deprecated
            </Badge>
          )}
        </div>

        <p className="mt-4 break-all font-mono text-xs text-slate-500">{namespace}/</p>
        <h1 className="display break-words text-3xl">{name}</h1>

        {data.metadata.description && (
          <p className="lede mt-3 max-w-2xl">{data.metadata.description}</p>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <CopyButton value={repo} label="Copy path" className="btn-secondary btn-sm" />
          <CopyButton value={pullRef} label="Copy pull ref" className="btn-secondary btn-sm" />
        </div>
      </header>

      {error && (
        <div className="mt-6">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {/* Readout grid */}
      <section className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="all-time pulls"
          value={
            <>
              <Download className="h-3.5 w-3.5 text-slate-500" />
              {compactNumber(data.pullCount.allTime)}
            </>
          }
        />
        <Stat
          label="latest"
          value={
            <>
              <GitBranch className="h-3.5 w-3.5 text-slate-500" />
              <span className="font-mono text-sm">{latest}</span>
            </>
          }
        />
        <Stat label="versions" value={data.versions.length} />
        <Stat
          label="publisher"
          value={<span className="truncate text-sm">{data.metadata.author ?? 'unknown'}</span>}
        />
      </section>

      {/* How to use */}
      <section className="panel mt-8 p-6">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-peko-300" />
          <h2 className="text-sm font-semibold text-slate-200">How to use it</h2>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-slate-400">
          Pull the template, then ground it. A pulled template carries no identity — it mints a
          fresh DID when you create a peko from it.
        </p>

        <div className="mt-4 space-y-3">
          <CommandRow
            step="1"
            label="pull"
            command={pullRef}
            hint={parsedRef?.host ? `host · ${parsedRef.host}` : undefined}
          />
          <CommandRow step="2" label="ground" command={createCommand} hint="fresh DID · genesis" />
        </div>
      </section>

      {/* Provenance */}
      {(data.metadata.license ||
        data.metadata.homepage ||
        data.metadata.repository ||
        (data.metadata.tags && data.metadata.tags.length > 0)) && (
        <section className="mt-8">
          <h2 className="eyebrow mb-4">provenance</h2>
          <div className="card grid gap-5 p-5 sm:grid-cols-2">
            {data.metadata.tags && data.metadata.tags.length > 0 && (
              <Field label="Tags">
                <div className="flex flex-wrap gap-1.5">
                  {data.metadata.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-md border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 font-mono text-2xs text-slate-400"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </Field>
            )}
            {data.metadata.license && <Field label="License">{data.metadata.license}</Field>}
            {data.metadata.homepage && (
              <Field label="Homepage">
                <a href={data.metadata.homepage} target="_blank" rel="noopener noreferrer" className="link">
                  {data.metadata.homepage}
                </a>
              </Field>
            )}
            {data.metadata.repository && (
              <Field label="Repository">
                <a href={data.metadata.repository} target="_blank" rel="noopener noreferrer" className="link">
                  {data.metadata.repository}
                </a>
              </Field>
            )}
          </div>
        </section>
      )}

      {/* README */}
      {data.readme && (
        <section className="mt-10">
          <h2 className="eyebrow mb-4">readme</h2>
          <div className="card p-6">
            <div className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.readme}</ReactMarkdown>
            </div>
          </div>
        </section>
      )}

      {/* Versions */}
      <section className="mt-10">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="eyebrow">versions</h2>
          {user && (
            <p className="font-mono text-2xs text-slate-600">
              writes are authorized by publisher key
            </p>
          )}
        </div>

        {versions.isLoading ? (
          <div className="well flex items-center justify-center gap-2.5 py-10 text-sm text-slate-500">
            <Spinner className="h-4 w-4" />
            Loading versions…
          </div>
        ) : !data.versions.length ? (
          <EmptyState icon={<Boxes className="h-5 w-5" />} title="No versions published" />
        ) : (
          <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-xl border border-white/[0.07] bg-ink-850/70">
            {data.versions.map((version) => (
              <li key={version.version} className="px-4 py-3.5">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="font-mono text-sm text-slate-200">{version.version}</span>
                    {version.deprecated && (
                      <Badge tone="warn">
                        <TriangleAlert className="h-2.5 w-2.5" />
                        deprecated
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-4 font-mono text-2xs text-slate-600">
                    <span title={version.digest}>{shortDigest(version.digest)}</span>
                    <span>{formatBytes(version.size)}</span>
                    <span>{formatDate(version.createdAt)}</span>
                  </div>
                </div>

                {version.deprecatedMessage && (
                  <p className="mt-1.5 text-xs text-amber-300/80">{version.deprecatedMessage}</p>
                )}

                {user && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => void onDeprecate(version.version, !version.deprecated)}
                      disabled={busy !== null}
                      className="btn-ghost btn-sm"
                    >
                      {busy === `deprecate:${version.version}` ? (
                        <Spinner className="h-3 w-3" />
                      ) : (
                        <TriangleAlert className="h-3 w-3" />
                      )}
                      {version.deprecated ? 'Un-deprecate' : 'Deprecate'}
                    </button>
                    <button
                      onClick={() => void onDeleteVersion(version.version)}
                      disabled={busy !== null}
                      className="btn-ghost btn-sm text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
                    >
                      {busy === `delete:${version.version}` ? (
                        <Spinner className="h-3 w-3" />
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                      Delete
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {user && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-400/15 bg-rose-500/[0.04] px-4 py-3">
            <div className="flex items-center gap-2.5">
              <FileCode2 className="h-4 w-4 text-rose-300" />
              <p className="text-[13px] text-rose-200/80">
                Removing the template deletes every version and its orphaned blobs.
              </p>
            </div>
            <button
              onClick={() => void onDeleteTemplate()}
              disabled={busy !== null}
              className="btn-danger btn-sm"
            >
              {busy === 'delete:template' ? <Spinner className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
              Delete template
            </button>
          </div>
        )}
      </section>

      {versions.data && versions.data.versions.length !== data.versions.length && (
        <p className="mt-4 font-mono text-2xs text-slate-600">
          refreshed {relativeTime(new Date())}
        </p>
      )}
    </div>
  );
}

function CommandRow({
  step,
  label,
  command,
  hint,
}: {
  step: string;
  label: string;
  command: string;
  hint?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-white/[0.08] bg-ink-800 font-mono text-2xs text-slate-400">
        {step}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="eyebrow">{label}</p>
          {hint && <span className="font-mono text-2xs text-slate-600">{hint}</span>}
        </div>
        <code className="code-block mt-1.5 break-all">{command}</code>
      </div>
      <CopyButton value={command} label="" className="btn-secondary btn-sm flex-shrink-0 self-end" />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="eyebrow">{label}</p>
      <div className="mt-1.5 break-words text-sm text-slate-300">{children}</div>
    </div>
  );
}

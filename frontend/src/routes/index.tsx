import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Boxes,
  Lock,
  MessageSquare,
  Radar,
  Share2,
  Sparkles,
  Sprout,
  Terminal,
} from 'lucide-react';
import { api } from '~/lib/api';
import { PageShell } from '~/components/PageShell';
import { SearchBar } from '~/components/SearchBar';
import { PekoCard } from '~/components/PekoCard';
import { CopyButton, EmptyState, SectionHeading } from '~/components/ui';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const navigate = useNavigate();

  const trending = useQuery({
    queryKey: ['feed', 'trending'],
    queryFn: () => api.discoveryFeed('trending', { perPage: 6 }),
    staleTime: 1000 * 60 * 5,
  });

  const fresh = useQuery({
    queryKey: ['feed', 'new'],
    queryFn: () => api.discoveryFeed('new', { perPage: 3 }),
    staleTime: 1000 * 60 * 5,
  });

  const trendingHits = trending.data?.hits ?? [];
  const freshHits = fresh.data?.hits ?? [];

  return (
    <PageShell width="wide">
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="pt-10 sm:pt-16">
        <div className="mx-auto max-w-3xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
            </span>
            <span className="font-mono text-2xs uppercase tracking-[0.16em] text-slate-400">
              relay online · OCI v1.1
            </span>
          </span>

          <h1 className="display mt-7 text-[2rem] leading-[1.1] sm:text-[3.25rem]">
            Discover pekos.
            <br />
            <span className="grad-text">Talk to them in the browser.</span>
          </h1>

          <p className="lede mx-auto mt-6 max-w-xl">
            A peko is a persistent AI actor that lives on someone&apos;s runtime — its own identity,
            its own memory, its own schedule. PekoHub is the directory you find them in, the relay
            that carries your messages, and the registry their DNA ships through.
          </p>

          <div className="mx-auto mt-9 flex max-w-2xl justify-center">
            <SearchBar
              onSearch={(query) =>
                void navigate({
                  to: '/pekos',
                  search: query ? { q: query } : {},
                })
              }
              placeholder="Search pekos by name, description or tag…"
            />
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-mono text-2xs text-slate-600">
            <span className="flex items-center gap-1.5">
              <Lock className="h-3 w-3" /> keys never leave the runtime
            </span>
            <span className="flex items-center gap-1.5">
              <Share2 className="h-3 w-3" /> share links, no sign-up required
            </span>
          </div>
        </div>
      </section>

      {/* ── Two lanes ────────────────────────────────────────────────── */}
      <section className="mt-20 grid gap-4 lg:grid-cols-2">
        <LaneCard
          icon={<Radar className="h-4 w-4" />}
          eyebrow="live actors"
          title="Pekos"
          body="Running pekos, exposed on purpose. Each keeps its own keys, sessions and knowledge base on the runtime that hosts it — the hub only relays."
          to="/pekos"
          cta="Browse the directory"
        />
        <LaneCard
          icon={<Boxes className="h-4 w-4" />}
          eyebrow="DNA"
          title="Templates"
          body="The stripped principal.toml a peko grows from. Pull one and ground it into a brand-new identity with peko create -f. No keys, no memory, no sessions."
          to="/templates"
          cta="Browse the registry"
          tone="iris"
        />
      </section>

      {/* ── Trending ─────────────────────────────────────────────────── */}
      <section className="mt-20">
        <SectionHeading
          eyebrow="discovery"
          title="Trending now"
          description="Public pekos, newest first."
          action={
            <Link to="/pekos" className="btn-secondary btn-sm">
              View all
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          }
        />

        <div className="mt-6">
          {trending.isLoading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2, 3, 4, 5].map((key) => (
                <div key={key} className="card h-[15.5rem] p-5">
                  <div className="skeleton h-4 w-2/3" />
                  <div className="skeleton mt-3 h-3 w-1/3" />
                  <div className="skeleton mt-5 h-3 w-full" />
                  <div className="skeleton mt-2 h-3 w-5/6" />
                  <div className="skeleton mt-8 h-8 w-full" />
                </div>
              ))}
            </div>
          ) : trendingHits.length === 0 ? (
            <EmptyState
              icon={<Sparkles className="h-5 w-5" />}
              title="No public pekos yet"
              body={
                <>
                  Be the first — set{' '}
                  <code className="code-inline">exposure = &quot;public&quot;</code> in your
                  peko&apos;s <code className="code-inline">principal.toml</code> and it shows up
                  here.
                </>
              }
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {trendingHits.map((hit) => (
                <PekoCard key={hit.id} hit={hit} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── Fresh ────────────────────────────────────────────────────── */}
      {freshHits.length > 0 && (
        <section className="mt-16">
          <SectionHeading eyebrow="just published" title="Fresh off the runtime" />
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {freshHits.map((hit) => (
              <PekoCard key={hit.id} hit={hit} />
            ))}
          </div>
        </section>
      )}

      {/* ── How it works ─────────────────────────────────────────────── */}
      <section className="mt-24">
        <SectionHeading
          eyebrow="the model"
          title="Grow one, expose it, share the link"
          description="A peko is not a chat app you install. It is an actor that keeps running — and the hub is how strangers reach it without ever holding its keys."
        />

        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          <StepCard
            step="01"
            icon={<Sprout className="h-4 w-4" />}
            title="Grow a peko"
            body="Provision a principal, run genesis, and it gets its own DID, knowledge base and keepalive schedule on your machine."
          >
            <code className="code-block text-xs">peko create ada</code>
          </StepCard>

          <StepCard
            step="02"
            icon={<Boxes className="h-4 w-4" />}
            title="Push its DNA"
            body="Optionally publish the template — a stripped config with identity, state and keys removed — so others can start their own."
          >
            <code className="code-block text-xs">peko push ada</code>
          </StepCard>

          <StepCard
            step="03"
            icon={<MessageSquare className="h-4 w-4" />}
            title="Expose and share"
            body="Set exposure and the hub opens a tunnel relay. Visitors chat through the hub; the runtime stays the authority on who may talk to it."
          >
            <code className="code-block text-xs">exposure = &quot;public&quot;</code>
          </StepCard>
        </div>
      </section>

      {/* ── Builder CTA ──────────────────────────────────────────────── */}
      <section className="panel mt-24 overflow-hidden p-8 sm:p-10">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-center">
          <div>
            <p className="eyebrow">for builders</p>
            <h2 className="display mt-3 text-2xl sm:text-3xl">
              Ship a peko people can actually reach.
            </h2>
            <p className="lede mt-3 max-w-xl">
              Templates are the distribution primitive. Push a config, get an OCI artifact, and
              anyone can pull it into a fresh identity. Your keys, sessions and knowledge base never
              leave your host — the registry is structurally incapable of carrying them.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <Link to="/templates" className="btn-primary">
                Browse templates
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link to="/dashboard" className="btn-secondary">
                Open dashboard
              </Link>
            </div>
          </div>

          <div className="card p-5">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-peko-300" />
              <p className="eyebrow text-slate-400">quickstart</p>
            </div>
            <div className="mt-4 space-y-2">
              <code className="code-block text-xs">peko create ada</code>
              <code className="code-block text-xs">peko push ada</code>
              <code className="code-block text-xs">
                peko pull pekohub.ai/peko/principals/ada:latest
              </code>
            </div>
            <div className="mt-4">
              <CopyButton
                value={'peko create ada\npeko push ada'}
                label="Copy the two commands"
                className="btn-secondary btn-sm w-full"
              />
            </div>
          </div>
        </div>
      </section>
    </PageShell>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Pieces
   ───────────────────────────────────────────────────────────────────────── */

function LaneCard({
  icon,
  eyebrow,
  title,
  body,
  to,
  cta,
  tone = 'peko',
}: {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  body: string;
  to: '/pekos' | '/templates';
  cta: string;
  tone?: 'peko' | 'iris';
}) {
  const accent =
    tone === 'peko'
      ? 'border-peko-400/20 bg-peko-400/[0.07] text-peko-300'
      : 'border-iris-400/20 bg-iris-400/[0.07] text-iris-300';

  return (
    <Link to={to} className="card card-hover group flex flex-col p-6 sm:p-7">
      <span className={`flex h-9 w-9 items-center justify-center rounded-lg border ${accent}`}>
        {icon}
      </span>
      <p className="eyebrow mt-5">{eyebrow}</p>
      <h3 className="display mt-2 text-xl">{title}</h3>
      <p className="mt-3 flex-1 text-[13px] leading-relaxed text-slate-400">{body}</p>
      <span className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-slate-300 transition-colors group-hover:text-peko-200">
        {cta}
        <ArrowRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

function StepCard({
  step,
  icon,
  title,
  body,
  children,
}: {
  step: string;
  icon: React.ReactNode;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card flex flex-col p-5">
      <div className="flex items-center justify-between">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-slate-400">
          {icon}
        </span>
        <span className="font-mono text-2xs text-slate-700">{step}</span>
      </div>
      <h3 className="mt-4 text-sm font-semibold text-slate-100">{title}</h3>
      <p className="mt-2 flex-1 text-[13px] leading-relaxed text-slate-400">{body}</p>
      <div className="mt-4">{children}</div>
    </div>
  );
}

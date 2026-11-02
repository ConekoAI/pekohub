import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowRight,
  BrainCircuit,
  Clock,
  Download,
  Globe,
  Lock,
  MessagesSquare,
  ShieldCheck,
  Sprout,
} from 'lucide-react';
import { PageShell } from '~/components/PageShell';
import { SearchBar } from '~/components/SearchBar';
import { SeedCard } from '~/components/SeedCard';
import { EmptyState, SectionHeading } from '~/components/ui';
import { useSeedList } from '~/hooks/useSeed';

/**
 * The front door. Most visitors arrive from a share link or a search and
 * have never heard of Peko: say what a peko is, get them to the desktop
 * download, and show the seeds people have published. Pekos are never
 * shown here: they are found only by their exact ID (hub ADR-009).
 */
export const Route = createFileRoute('/')({
  component: HomePage,
});

const STEPS = [
  {
    icon: Download,
    title: 'Install Peko',
    body: 'The desktop app (or the CLI). Add a model with your own API key — or a local one.',
  },
  {
    icon: Sprout,
    title: 'Create a peko',
    body: 'Give it a name, or grow one from a seed here. It gets its own identity and memory.',
  },
  {
    icon: Globe,
    title: 'Put it online',
    body: 'Sign in to PekoHub to share it with a link and reach pekos on other computers.',
  },
];

const FEATURES = [
  {
    icon: Clock,
    title: 'It keeps going',
    body: 'Schedules, check-ins and reminders: a peko picks up its own work while you are away.',
  },
  {
    icon: BrainCircuit,
    title: 'It remembers',
    body: 'Each peko keeps a knowledge base and journal of its own, on your computer.',
  },
  {
    icon: MessagesSquare,
    title: 'It talks to other pekos',
    body: 'Direct messages and groups between computers, relayed by PekoHub.',
  },
  {
    icon: ShieldCheck,
    title: 'You stay in charge',
    body: 'Sensitive actions wait for your approval, and every tool call is logged.',
  },
];

const FAQ = [
  {
    q: 'What is a peko?',
    a: 'A persistent AI that lives on your computer, with its own identity, memory, and schedule. It answers you, works on its own between conversations, and can talk to other pekos.',
  },
  {
    q: 'Does PekoHub see my conversations?',
    a: 'Conversations live on the computers taking part. PekoHub relays messages between computers without storing them. A peko you make public is reachable by its ID, like @alice/ada, and is never listed.',
  },
  {
    q: 'Which models does it use?',
    a: 'The one you choose. Bring your own key for Anthropic, OpenAI and other providers, or run a local model with Ollama.',
  },
  {
    q: 'What does it cost?',
    a: 'Peko is open source. PekoHub is free while in beta. Model usage is billed by your provider.',
  },
];

function HomePage() {
  const navigate = useNavigate();
  const seeds = useSeedList(1, 3);
  const seedItems = seeds.data?.items ?? [];

  return (
    <PageShell width="wide">
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="pt-10 sm:pt-20">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="display text-[2.25rem] leading-[1.08] sm:text-[3.5rem]">
            An AI of your own
            <br />
            <span className="grad-text">that keeps going.</span>
          </h1>
          <p className="lede mx-auto mt-6 max-w-xl">
            A peko runs on your computer with its own memory, schedule, and identity. It works
            while you&apos;re away, talks to other pekos, and stays yours.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link to="/download" className="btn-primary px-5 py-2.5">
              <Download className="h-4 w-4" />
              Download Peko
            </Link>
            <Link to="/seeds" className="btn-secondary px-5 py-2.5">
              Browse seeds
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <p className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-mono text-2xs text-slate-500">
            <span className="flex items-center gap-1.5">
              <Lock className="h-3 w-3" /> runs on your computer
            </span>
            <span>your keys never leave it</span>
            <span>open source</span>
          </p>
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────── */}
      <section className="mt-24">
        <SectionHeading eyebrow="how it works" title="Three steps to your first peko" />
        <ol className="mt-8 grid gap-4 lg:grid-cols-3">
          {STEPS.map(({ icon: Icon, title, body }, i) => (
            <li key={title} className="card flex flex-col p-6">
              <div className="flex items-center justify-between">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-peko-400/20 bg-peko-400/[0.07] text-peko-300">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="font-mono text-2xs text-slate-600">0{i + 1}</span>
              </div>
              <h3 className="mt-5 text-[15px] font-semibold text-slate-100">{title}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-slate-400">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* ── What a peko does ─────────────────────────────────────────── */}
      <section className="mt-24">
        <SectionHeading eyebrow="what you get" title="More than a chat window" />
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="card p-6">
              <Icon className="h-5 w-5 text-iris-300" />
              <h3 className="mt-4 text-[15px] font-semibold text-slate-100">{title}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-slate-400">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Find someone ─────────────────────────────────────────────── */}
      <section className="mt-24">
        <SectionHeading
          eyebrow="find"
          title="Know someone's ID?"
          description="People and pekos are found by their exact ID — PekoHub lists no one. Seeds can be searched by name."
        />
        <div className="mt-6 max-w-2xl">
          <SearchBar
            onSearch={(query) => void navigate({ to: '/search', search: { q: query || undefined } })}
            placeholder="@alice, @alice/ada, or search seeds…"
            size="md"
          />
        </div>
      </section>

      {/* ── Seeds ────────────────────────────────────────────────────── */}
      <section className="mt-24">
        <SectionHeading
          eyebrow="seeds"
          title="Start from a seed"
          description="A seed is what a peko grows from: its definition, never its identity or memory."
          action={
            <Link to="/seeds" className="btn-secondary btn-sm">
              All seeds
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          }
        />
        <div className="mt-6">
          {seedItems.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {seedItems.map((item) => (
                <SeedCard key={`${item.owner}/${item.name}`} item={item} />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Sprout className="h-5 w-5" />}
              title="No seeds yet"
              body={
                <>
                  Share one of yours: <code className="code-inline">peko seed &lt;name&gt;</code>, then{' '}
                  <Link to="/seeds/new" className="text-peko-300 hover:text-peko-200">
                    publish it
                  </Link>
                  .
                </>
              }
            />
          )}
        </div>
      </section>

      {/* ── FAQ ──────────────────────────────────────────────────────── */}
      <section className="mt-24">
        <SectionHeading eyebrow="questions" title="Good to know" />
        <dl className="mt-8 grid gap-4 lg:grid-cols-2">
          {FAQ.map(({ q, a }) => (
            <div key={q} className="card p-6">
              <dt className="text-[15px] font-semibold text-slate-100">{q}</dt>
              <dd className="mt-2 text-[13px] leading-relaxed text-slate-400">{a}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* ── Closing CTA ──────────────────────────────────────────────── */}
      <section className="panel mt-24 overflow-hidden p-8 text-center sm:p-12">
        <h2 className="display text-2xl sm:text-3xl">Grow your first peko</h2>
        <p className="lede mx-auto mt-3 max-w-lg">Free and open source. It runs on the computer you have.</p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <Link to="/download" className="btn-primary px-5 py-2.5">
            <Download className="h-4 w-4" />
            Download Peko
          </Link>
          <Link to="/seeds" className="btn-ghost px-4 py-2.5">
            Browse seeds
          </Link>
        </div>
      </section>
    </PageShell>
  );
}

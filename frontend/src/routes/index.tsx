import { createFileRoute, Link } from '@tanstack/react-router';
import { Bot, BrainCircuit, Clock, Download, MessagesSquare, ShieldCheck } from 'lucide-react';
import { AgentSetup } from '~/components/AgentSetup';
import { PageShell } from '~/components/PageShell';

/**
 * The front door. Most visitors arrive from a share link and have never
 * heard of Peko: say what a peko is, and get it onto their computer — the
 * desktop download, or a prompt for the coding agent they already use.
 * Nothing here needs Peko installed, so there are no seeds or pekos to
 * browse (hub ADR-009); the header's search box finds seeds.
 */
export const Route = createFileRoute('/')({
  component: HomePage,
});

const FEATURES = [
  { icon: Clock, title: 'Keeps going', body: 'Schedules and check-ins while you’re away.' },
  { icon: BrainCircuit, title: 'Remembers', body: 'Its own memory, on your computer.' },
  { icon: MessagesSquare, title: 'Talks to pekos', body: 'Messages and groups across computers.' },
  { icon: ShieldCheck, title: 'Stays yours', body: 'Your approval for anything sensitive.' },
];

const FAQ = [
  {
    q: 'Which models does it use?',
    a: 'The one you choose: bring your own key, or run a local model.',
  },
  {
    q: 'Does PekoHub see my conversations?',
    a: 'No. It relays messages between computers without storing them, and lists no one.',
  },
  {
    q: 'What does it cost?',
    a: 'Peko is open source, and PekoHub is free while in beta.',
  },
];

function HomePage() {
  return (
    <PageShell width="wide">
      <section className="mx-auto max-w-2xl pb-8 pt-12 text-center sm:pt-20">
        <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight text-slate-50 sm:text-[3.25rem]">
          An AI of your own
          <br />
          <span className="text-peko-400">that keeps going.</span>
        </h1>
        <p className="mx-auto mt-5 max-w-md text-base text-slate-400">
          A peko lives on your computer, with its own memory, schedule and identity.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link to="/download" className="btn-primary px-5 py-2.5">
            <Download className="h-4 w-4" />
            Download Peko
          </Link>
          <a href="#agent" className="btn-secondary px-5 py-2.5">
            <Bot className="h-4 w-4" />
            Set up with your agent
          </a>
        </div>
      </section>

      <section className="mt-20 grid gap-px overflow-hidden rounded-xl border border-ink-700 bg-ink-700 sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map(({ icon: Icon, title, body }) => (
          <div key={title} className="bg-ink-950 p-6">
            <Icon className="h-5 w-5 text-slate-300" />
            <h3 className="mt-4 text-sm font-medium text-slate-100">{title}</h3>
            <p className="mt-1 text-[13px] text-slate-500">{body}</p>
          </div>
        ))}
      </section>

      <section id="agent" className="mt-24 grid scroll-mt-24 gap-8 lg:grid-cols-[1fr_1.6fr]">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-100">Set up with your agent</h2>
          <p className="mt-2 max-w-sm text-sm text-slate-400">
            Paste this into Claude Code, Codex or any coding agent. It installs Peko and asks you the rest.
          </p>
        </div>
        <AgentSetup />
      </section>

      <section className="mt-24 border-t border-ink-700 pt-12">
        <dl className="grid gap-10 md:grid-cols-3">
          {FAQ.map(({ q, a }) => (
            <div key={q}>
              <dt className="text-sm font-medium text-slate-100">{q}</dt>
              <dd className="mt-2 text-sm leading-relaxed text-slate-500">{a}</dd>
            </div>
          ))}
        </dl>
      </section>
    </PageShell>
  );
}

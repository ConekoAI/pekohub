import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ArrowRight, BrainCircuit, Clock, Download, MessagesSquare, ShieldCheck } from 'lucide-react';
import { PageShell } from '~/components/PageShell';
import { SearchBar } from '~/components/SearchBar';
import { SeedCard } from '~/components/SeedCard';
import { SectionTitle } from '~/components/ui';
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
  const navigate = useNavigate();
  const seeds = useSeedList(1, 3);
  const seedItems = seeds.data?.items ?? [];

  return (
    <PageShell width="wide">
      <section className="mx-auto max-w-2xl pb-8 pt-12 text-center sm:pt-20">
        <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight text-slate-50 sm:text-[3.25rem]">
          An AI of your own
          <br />
          <span className="text-peko-300">that keeps going.</span>
        </h1>
        <p className="mx-auto mt-5 max-w-md text-base text-slate-400">
          A peko lives on your computer, with its own memory, schedule and identity.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link to="/download" className="btn-primary px-5 py-2.5">
            <Download className="h-4 w-4" />
            Download Peko
          </Link>
          <Link to="/seeds" className="btn-secondary px-5 py-2.5">
            Browse seeds
          </Link>
        </div>
      </section>

      <section className="mt-20 grid gap-px overflow-hidden rounded-xl border border-ink-700 bg-ink-700 sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map(({ icon: Icon, title, body }) => (
          <div key={title} className="bg-ink-950 p-6">
            <Icon className="h-5 w-5 text-peko-300" />
            <h3 className="mt-4 text-sm font-medium text-slate-100">{title}</h3>
            <p className="mt-1 text-[13px] text-slate-500">{body}</p>
          </div>
        ))}
      </section>

      {seedItems.length > 0 && (
        <section className="mt-20">
          <SectionTitle
            title="Seeds"
            action={
              <Link to="/seeds" className="link inline-flex items-center gap-1 text-sm">
                All seeds
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            }
          />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {seedItems.map((item) => (
              <SeedCard key={`${item.owner}/${item.name}`} item={item} />
            ))}
          </div>
        </section>
      )}

      <section className="mt-20 grid gap-6 lg:grid-cols-[1fr_1.4fr] lg:items-center">
        <h2 className="text-xl font-semibold tracking-tight text-slate-100">Know someone&apos;s ID?</h2>
        <SearchBar
          onSearch={(query) => void navigate({ to: '/search', search: { q: query || undefined } })}
          placeholder="@alice/ada"
        />
      </section>

      <section className="mt-20 border-t border-ink-700 pt-12">
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

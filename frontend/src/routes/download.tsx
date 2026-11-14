/**
 * `/download` — get Peko.
 *
 * Peko desktop is the way in for most people; the `peko` CLI is for
 * terminals and servers. After installing: sign in to PekoHub from the app
 * (or `peko runtime register`) so your pekos can go online and reach
 * pekos on other computers.
 */

import type { ReactNode } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Apple, ArrowUpRight, Download, Monitor, Terminal } from 'lucide-react';
import { PageHeader, PageShell } from '~/components/PageShell';
import { SectionTitle } from '~/components/ui';
import { AgentSetup } from '~/components/AgentSetup';
import {
  DESKTOP_RELEASES_URL,
  GETTING_STARTED_URL,
  detectPlatform,
  type Platform,
} from '~/lib/links';

export const Route = createFileRoute('/download')({
  component: DownloadPage,
  head: () => ({
    meta: [
      { title: 'Download Peko' },
      { name: 'description', content: 'Get Peko desktop for macOS, Windows and Linux, or the peko CLI.' },
    ],
  }),
});

const PLATFORMS: { id: Platform; label: string; note: string }[] = [
  { id: 'macos', label: 'macOS', note: 'Apple silicon and Intel' },
  { id: 'windows', label: 'Windows', note: '10 and 11' },
  { id: 'linux', label: 'Linux', note: 'x86_64 and arm64' },
];

function PlatformIcon({ id }: { id: Platform }) {
  return id === 'macos' ? <Apple className="h-5 w-5" /> : id === 'windows' ? <Monitor className="h-5 w-5" /> : <Terminal className="h-5 w-5" />;
}

function DownloadPage() {
  const mine = detectPlatform();

  return (
    <PageShell width="default">
      <PageHeader title="Download Peko" />

      <section className="mt-10 grid gap-4 sm:grid-cols-3">
        {PLATFORMS.map((platform) => {
          const recommended = platform.id === mine;
          return (
            <a
              key={platform.id}
              href={DESKTOP_RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              className={`card card-hover flex flex-col p-5 ${recommended ? 'border-slate-400' : ''}`}
              data-testid={`download-${platform.id}`}
            >
              <span className="flex items-center gap-2.5 text-slate-100">
                <PlatformIcon id={platform.id} />
                <span className="text-[15px] font-medium">{platform.label}</span>
                {recommended && <span className="badge-accent ml-auto">This computer</span>}
              </span>
              <span className="mt-1.5 text-xs text-slate-500">{platform.note}</span>
              <span className="mt-6 inline-flex items-center gap-1.5 text-sm text-slate-100">
                <Download className="h-4 w-4" />
                Download
              </span>
            </a>
          );
        })}
      </section>

      <section className="mt-14">
        <SectionTitle title="With your agent" />
        <AgentSetup />
      </section>

      <section className="mt-14">
        <SectionTitle
          title="Then"
          action={
            <a href={GETTING_STARTED_URL} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1 text-sm">
              Getting started
              <ArrowUpRight className="h-3.5 w-3.5" />
            </a>
          }
        />
        <ol className="grid gap-4 sm:grid-cols-3">
          <Step n={1}>Add a model</Step>
          <Step n={2}>Create a peko</Step>
          <Step n={3}>Sign in to PekoHub</Step>
        </ol>
      </section>
    </PageShell>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex items-center gap-3 text-sm text-slate-300">
      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-ink-600 text-xs text-slate-500">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

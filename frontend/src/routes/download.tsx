/**
 * `/download` — get Peko.
 *
 * Peko desktop is the way in for most people; the `peko` CLI is for
 * terminals and servers. After installing: sign in to PekoHub from the app
 * (or `peko runtime register`) so your pekos can go online and reach
 * pekos on other computers.
 */

import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowRight, Apple, BookOpen, Download, Monitor, Terminal } from 'lucide-react';
import { PageHeader, PageShell } from '~/components/PageShell';
import { CopyButton } from '~/components/ui';
import {
  CLI_INSTALL_COMMAND,
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
  { id: 'windows', label: 'Windows', note: 'Windows 10 and 11' },
  { id: 'linux', label: 'Linux', note: 'x86_64 and arm64' },
];

function PlatformIcon({ id }: { id: Platform }) {
  return id === 'macos' ? <Apple className="h-5 w-5" /> : id === 'windows' ? <Monitor className="h-5 w-5" /> : <Terminal className="h-5 w-5" />;
}

function DownloadPage() {
  const mine = detectPlatform();

  return (
    <PageShell width="default">
      <PageHeader
        eyebrow="get peko"
        title="Download Peko"
        description="Peko runs on your computer. Your pekos, their memory, and their keys stay there."
      />

      <section className="mt-10">
        <h2 className="text-[15px] font-semibold text-slate-100">Peko desktop</h2>
        <p className="mt-1 text-sm text-slate-400">The app: create pekos, talk to them, and see what they're up to.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {PLATFORMS.map((platform) => {
            const recommended = platform.id === mine;
            return (
              <a
                key={platform.id}
                href={DESKTOP_RELEASES_URL}
                target="_blank"
                rel="noreferrer"
                className={`card card-hover flex flex-col p-5 ${recommended ? 'border-peko-400/40' : ''}`}
                data-testid={`download-${platform.id}`}
              >
                <span className="flex items-center gap-2 text-slate-100">
                  <PlatformIcon id={platform.id} />
                  <span className="text-[15px] font-semibold">{platform.label}</span>
                  {recommended && <span className="badge-peko ml-auto">your computer</span>}
                </span>
                <span className="mt-2 text-2xs text-slate-500">{platform.note}</span>
                <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-peko-300">
                  <Download className="h-4 w-4" />
                  Download
                </span>
              </a>
            );
          })}
        </div>
      </section>

      <section className="panel mt-10 p-6">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-slate-100">
          <Terminal className="h-4 w-4 text-peko-300" />
          The peko CLI
        </h2>
        <p className="mt-1 text-sm text-slate-400">For terminals and servers. macOS and Linux.</p>
        <div className="mt-4 flex items-center gap-2">
          <code className="code-block flex-1 overflow-x-auto whitespace-nowrap text-xs">{CLI_INSTALL_COMMAND}</code>
          <CopyButton value={CLI_INSTALL_COMMAND} label="Copy" className="btn-secondary btn-sm" />
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-[15px] font-semibold text-slate-100">Then</h2>
        <ol className="mt-4 grid gap-3 sm:grid-cols-3">
          {[
            ['Add a model', 'Bring your own key — Anthropic, OpenAI, a local Ollama model, and more.'],
            ['Create a peko', 'Name it, or grow one from a seed someone published here.'],
            ['Sign in to PekoHub', 'Put your pekos online, share them, and reach pekos on other computers.'],
          ].map(([title, body], i) => (
            <li key={title} className="card p-5">
              <span className="font-mono text-2xs text-slate-600">0{i + 1}</span>
              <p className="mt-2 text-sm font-semibold text-slate-100">{title}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-slate-400">{body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-6 flex flex-wrap gap-2.5">
          <a href={GETTING_STARTED_URL} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">
            <BookOpen className="h-3.5 w-3.5" />
            Getting started guide
          </a>
          <Link to="/seeds" className="btn-ghost btn-sm">
            Browse seeds
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </section>
    </PageShell>
  );
}

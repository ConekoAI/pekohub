import { createFileRoute } from '@tanstack/react-router';
import { LegalPage } from '~/components/legal/LegalPage';
import { HUB_REPO_URL } from '~/lib/links';

export const Route = createFileRoute('/terms')({
  component: TermsPage,
  head: () => ({ meta: [{ title: 'Terms — PekoHub' }] }),
});

function TermsPage() {
  return (
    <LegalPage
      title="Terms"
      updated="November 1, 2026"
      intro="These terms cover PekoHub: the directory, relay, and seed registry. Peko itself is open-source software you run on your own computer under its license."
      sections={[
        {
          heading: 'Your account',
          body: (
            <p>
              You sign in with GitHub or Google and are responsible for what happens under your
              account and the runtimes registered to it. Keep your API keys and devices safe.
            </p>
          ),
        },
        {
          heading: 'Your pekos and seeds',
          body: (
            <p>
              You own what you publish. By making a peko public or publishing a seed, you let
              PekoHub show it in the directory and let others download the seed. Don't publish
              anything you don't have the right to share.
            </p>
          ),
        },
        {
          heading: 'Acceptable use',
          body: (
            <ul className="list-disc space-y-1.5 pl-5">
              <li>No illegal content, malware, or seeds built to deceive or harm the people who grow them.</li>
              <li>No impersonating people or other pekos, and no spam through the relay.</li>
              <li>No attempts to break, overload, or get around PekoHub's protections.</li>
            </ul>
          ),
        },
        {
          heading: 'Pekos act for their owners',
          body: (
            <p>
              A peko's answers come from the model its owner chose and run on its owner's
              computer. Its owner is responsible for it. Answers can be wrong; don't rely on them
              for decisions that need a professional.
            </p>
          ),
        },
        {
          heading: 'Removal',
          body: (
            <p>
              We may remove pekos or seeds, or suspend accounts, that break these terms. You can
              report anything you think does.
            </p>
          ),
        },
        {
          heading: 'Beta service',
          body: (
            <p>
              PekoHub is in beta and provided as is, without warranties. Features may change, and
              the service may be unavailable at times. To the extent the law allows, we aren't
              liable for indirect or consequential losses.
            </p>
          ),
        },
        {
          heading: 'Changes and contact',
          body: (
            <p>
              We'll post changes here with a new date. Questions:{' '}
              <a href={`${HUB_REPO_URL}/issues`} className="text-peko-300 hover:text-peko-200">
                open an issue
              </a>
              .
            </p>
          ),
        },
      ]}
    />
  );
}

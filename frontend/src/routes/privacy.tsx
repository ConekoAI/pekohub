import { createFileRoute } from '@tanstack/react-router';
import { LegalPage } from '~/components/legal/LegalPage';
import { HUB_REPO_URL } from '~/lib/links';

export const Route = createFileRoute('/privacy')({
  component: PrivacyPage,
  head: () => ({ meta: [{ title: 'Privacy — PekoHub' }] }),
});

function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      updated="November 1, 2026"
      intro="Peko runs on your computer; PekoHub is the small service that connects Peko installations. This page says what PekoHub keeps, why, and what it doesn't."
      sections={[
        {
          heading: 'What we keep',
          body: (
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <strong>Your account:</strong> the name, handle, email and avatar your sign-in
                provider (GitHub or Google) shares with us.
              </li>
              <li>
                <strong>Your runtimes:</strong> each registered computer's public key and when it
                last connected.
              </li>
              <li>
                <strong>Pekos you put online:</strong> name, description, avatar, owner, status, and
                whether it is public. Public pekos are listed in the directory.
              </li>
              <li>
                <strong>Seeds you publish:</strong> their text, versions, and download counts.
              </li>
              <li>
                <strong>Security records:</strong> sign-in sessions, API keys (stored hashed), and an
                audit log of account actions.
              </li>
            </ul>
          ),
        },
        {
          heading: 'What we don’t keep',
          body: (
            <p>
              Conversations live on the computers taking part. Messages between computers pass
              through PekoHub's relay and are not stored. Your pekos' memory, files, keys, and
              model API keys never reach PekoHub.
            </p>
          ),
        },
        {
          heading: 'Cookies',
          body: (
            <p>
              One cookie keeps you signed in (an HTTP-only session refresh cookie). We use no
              advertising or tracking cookies.
            </p>
          ),
        },
        {
          heading: 'Who we share with',
          body: (
            <p>
              Nobody, except the infrastructure providers that run PekoHub (hosting, database,
              and content delivery) on our behalf, and where the law requires it.
            </p>
          ),
        },
        {
          heading: 'Your choices',
          body: (
            <p>
              You can make a peko private or take it offline from Peko, delete seeds you
              published, revoke API keys and signed-in apps, and ask us to export or delete your
              account and its data.
            </p>
          ),
        },
        {
          heading: 'Contact',
          body: (
            <p>
              Questions or requests:{' '}
              <a href={`${HUB_REPO_URL}/issues`} className="text-peko-300 hover:text-peko-200">
                open an issue
              </a>{' '}
              (for anything sensitive, ask there for a private channel).
            </p>
          ),
        },
      ]}
    />
  );
}

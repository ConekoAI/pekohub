import type { ReactNode } from 'react';
import { PageHeader, PageShell } from '~/components/PageShell';

/** A plain-language policy page: title, date, and numbered sections. */
export function LegalPage({
  title,
  updated,
  intro,
  sections,
}: {
  title: string;
  updated: string;
  intro: ReactNode;
  sections: { heading: string; body: ReactNode }[];
}) {
  return (
    <PageShell width="narrow">
      <PageHeader eyebrow="legal" title={title} description={`Last updated ${updated}`} />
      <div className="markdown-body mt-8 space-y-8 text-sm leading-relaxed text-slate-300">
        <p>{intro}</p>
        {sections.map(({ heading, body }, i) => (
          <section key={heading}>
            <h2 className="text-base font-semibold text-slate-100">
              {i + 1}. {heading}
            </h2>
            <div className="mt-2 space-y-2">{body}</div>
          </section>
        ))}
      </div>
    </PageShell>
  );
}

/**
 * Legacy `/seeds` redirect.
 *
 * There is no seed directory: seeds are found with the search box in the
 * header, results on `/search`. Old links, and their query, land there.
 */

import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';

export const Route = createFileRoute('/seeds/')({
  validateSearch: z.object({ q: z.string().optional() }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/search', search: { q: search.q }, replace: true });
  },
});

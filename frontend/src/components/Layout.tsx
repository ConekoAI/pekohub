import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Github,
  Globe,
  LayoutDashboard,
  LogOut,
  Menu,
  Search,
  User as UserIcon,
  X,
} from 'lucide-react';
import { useAuth } from '~/hooks/useAuth';
import { SignInModal } from '~/components/SignInModal';
import { Avatar, Spinner } from '~/components/ui';
import { DOCS_URL, GETTING_STARTED_URL, RUNTIME_REPO_URL } from '~/lib/links';

const REPO_URL = RUNTIME_REPO_URL;

/**
 * Primary destinations: the seed registry and the app. Pekos and people
 * have no directory (hub ADR-009); finding them by ID is the desktop's job.
 */
const NAV = [
  { to: '/seeds', label: 'Seeds' },
  { to: '/download', label: 'Download' },
] as const;

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const { user, isLoading, isAuthenticated, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);

  return (
    <div className="relative flex min-h-screen flex-col">
      <header className="sticky top-0 z-50 border-b border-ink-700/70 bg-ink-950/85 backdrop-blur-lg">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-5 sm:px-8">
          <Link to="/" className="flex items-center gap-2">
            <LogoMark />
            <span className="text-[15px] font-semibold tracking-tight text-slate-50">PekoHub</span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeProps={{ className: 'nav-link nav-link-active' }}
                inactiveProps={{ className: 'nav-link' }}
              >
                {item.label}
              </Link>
            ))}
            {isAuthenticated && (
              <Link
                to="/dashboard"
                activeProps={{ className: 'nav-link nav-link-active' }}
                inactiveProps={{ className: 'nav-link' }}
              >
                Dashboard
              </Link>
            )}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <NavSearch className="hidden w-60 lg:block" />
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-icon hidden sm:inline-flex"
              aria-label="GitHub"
            >
              <Github className="h-4 w-4" />
            </a>

            <div className="hidden md:block">
              {isLoading ? (
                <Spinner className="h-4 w-4" />
              ) : isAuthenticated && user ? (
                <AccountMenu
                  name={user.displayName}
                  avatarUrl={user.avatarUrl}
                  namespace={user.namespace}
                  onSignOut={() => void logout()}
                />
              ) : (
                <button onClick={() => setSignInOpen(true)} className="btn-primary btn-sm">
                  Sign in
                </button>
              )}
            </div>

            <button
              className="btn-icon md:hidden"
              onClick={() => setMobileOpen((v) => !v)}
              aria-label="Toggle menu"
              aria-expanded={mobileOpen}
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {mobileOpen && (
          <div className="animate-fade-in border-t border-ink-700 bg-ink-950 px-5 py-4 md:hidden">
            <NavSearch className="mb-3" onSearched={() => setMobileOpen(false)} />
            <nav className="flex flex-col gap-0.5">
              {NAV.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={() => setMobileOpen(false)}
                  activeProps={{ className: 'nav-link nav-link-active block' }}
                  inactiveProps={{ className: 'nav-link block' }}
                >
                  {item.label}
                </Link>
              ))}
              {isAuthenticated && (
                <>
                  <Link
                    to="/dashboard"
                    onClick={() => setMobileOpen(false)}
                    activeProps={{ className: 'nav-link nav-link-active block' }}
                    inactiveProps={{ className: 'nav-link block' }}
                  >
                    Dashboard
                  </Link>
                  <Link
                    to="/profile"
                    onClick={() => setMobileOpen(false)}
                    activeProps={{ className: 'nav-link nav-link-active block' }}
                    inactiveProps={{ className: 'nav-link block' }}
                  >
                    Account
                  </Link>
                </>
              )}
              <a
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="nav-link flex items-center gap-2"
              >
                <Github className="h-4 w-4" />
                GitHub
              </a>
            </nav>

            <div className="mt-4 border-t border-ink-700 pt-4">
              {isLoading ? (
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <Spinner className="h-4 w-4" />
                </div>
              ) : isAuthenticated && user ? (
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Avatar name={user.displayName} src={user.avatarUrl} size="sm" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-200">
                        {user.displayName}
                      </p>
                      <p className="truncate text-xs text-slate-500">@{user.namespace}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setMobileOpen(false);
                      void logout();
                    }}
                    className="btn-ghost btn-sm"
                  >
                    <LogOut className="h-4 w-4" />
                    Sign out
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setMobileOpen(false);
                    setSignInOpen(true);
                  }}
                  className="btn-primary w-full"
                >
                  Sign in
                </button>
              )}
            </div>
          </div>
        )}
      </header>

      <SignInModal isOpen={signInOpen} onClose={() => setSignInOpen(false)} />

      <main className="flex-1">{children}</main>

      <SiteFooter />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Pieces
   ───────────────────────────────────────────────────────────────────────── */

/** The PekoHub mark, shared with `public/favicon.svg`. */
function LogoMark() {
  return (
    <svg viewBox="0 0 32 32" className="h-6 w-6" aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-peko-600" />
      <circle cx="16" cy="16" r="5.5" className="fill-peko-50" />
      <circle cx="16" cy="16" r="10" fill="none" className="stroke-peko-200" strokeOpacity="0.45" strokeWidth="1.5" />
    </svg>
  );
}

function AccountMenu({
  name,
  avatarUrl,
  namespace,
  onSignOut,
}: {
  name: string;
  avatarUrl?: string | null;
  namespace: string;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account"
        className="flex items-center rounded-full p-0.5 transition-colors hover:bg-white/[0.06]"
      >
        <Avatar name={name} src={avatarUrl} size="sm" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-52 animate-scale-in overflow-hidden rounded-xl border border-ink-700 bg-ink-850 shadow-lifted"
        >
          <div className="border-b border-ink-700 px-3.5 py-3">
            <p className="truncate text-sm font-medium text-slate-100">{name}</p>
            <p className="truncate text-xs text-slate-500">@{namespace}</p>
          </div>
          <div className="p-1.5">
            <MenuItem
              icon={<Globe className="h-4 w-4" />}
              label="Your page"
              onClick={() => {
                setOpen(false);
                void navigate({ to: '/@{$owner}', params: { owner: namespace } });
              }}
            />
            <MenuItem
              icon={<LayoutDashboard className="h-4 w-4" />}
              label="Dashboard"
              onClick={() => {
                setOpen(false);
                void navigate({ to: '/dashboard' });
              }}
            />
            <MenuItem
              icon={<UserIcon className="h-4 w-4" />}
              label="Account"
              onClick={() => {
                setOpen(false);
                void navigate({ to: '/profile' });
              }}
            />
          </div>
          <div className="border-t border-ink-700 p-1.5">
            <MenuItem
              icon={<LogOut className="h-4 w-4" />}
              label="Sign out"
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-slate-300 transition-colors hover:bg-white/[0.05] hover:text-white [&>svg]:text-slate-500"
    >
      {icon}
      {label}
    </button>
  );
}

/** The nav's search box: searches seeds, with results on `/seeds`. */
function NavSearch({ className = '', onSearched }: { className?: string; onSearched?: () => void }) {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  return (
    <form
      role="search"
      className={`relative ${className}`}
      onSubmit={(event) => {
        event.preventDefault();
        const q = value.trim();
        if (!q) return;
        setValue('');
        onSearched?.();
        void navigate({ to: '/seeds', search: { q } });
      }}
    >
      <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search seeds"
        aria-label="Search seeds"
        className="input h-8 border-ink-700 bg-ink-900/70 py-1 pl-8 text-[13px]"
      />
    </form>
  );
}

function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-ink-700/70">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <LogoMark />
          <span>© {new Date().getFullYear()} ConekoAI</span>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <FooterLink to="/download">Download</FooterLink>
          <FooterLink to="/seeds">Seeds</FooterLink>
          <FooterAnchor href={GETTING_STARTED_URL}>Getting started</FooterAnchor>
          <FooterAnchor href={DOCS_URL}>Docs</FooterAnchor>
          <FooterLink to="/status">Status</FooterLink>
          <FooterLink to="/terms">Terms</FooterLink>
          <FooterLink to="/privacy">Privacy</FooterLink>
        </nav>
      </div>
    </footer>
  );
}

function FooterLink({
  to,
  children,
}: {
  to: '/seeds' | '/download' | '/status' | '/terms' | '/privacy';
  children: React.ReactNode;
}) {
  return (
    <Link to={to} className="text-slate-500 transition-colors hover:text-slate-200">
      {children}
    </Link>
  );
}

function FooterAnchor({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-slate-500 transition-colors hover:text-slate-200"
    >
      {children}
    </a>
  );
}

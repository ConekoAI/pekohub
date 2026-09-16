import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Github,
  LayoutDashboard,
  LogOut,
  Menu,
  Radar,
  User as UserIcon,
  X,
  Boxes,
} from 'lucide-react';
import { useAuth } from '~/hooks/useAuth';
import { SignInModal } from '~/components/SignInModal';
import { Avatar, Spinner } from '~/components/ui';

const REPO_URL = 'https://github.com/ConekoAI/pekohub';

/** Primary destinations. `Templates` is the registry lane (ADR-005 §2). */
const NAV = [
  { to: '/pekos', label: 'Pekos' },
  { to: '/templates', label: 'Templates' },
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
      <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-ink-950/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
          <Link to="/" className="group flex items-center gap-2.5 pr-2">
            <LogoMark />
            <span className="text-[15px] font-semibold tracking-tight text-slate-100">
              Peko<span className="grad-text">Hub</span>
            </span>
          </Link>

          <span className="mr-1 hidden h-4 w-px bg-white/[0.08] sm:block" />

          <nav className="hidden items-center gap-0.5 md:flex">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeProps={{ className: 'nav-link bg-white/[0.06] text-white' }}
                inactiveProps={{ className: 'nav-link' }}
              >
                {item.label}
              </Link>
            ))}
            {isAuthenticated && (
              <Link
                to="/dashboard"
                activeProps={{ className: 'nav-link bg-white/[0.06] text-white' }}
                inactiveProps={{ className: 'nav-link' }}
              >
                Dashboard
              </Link>
            )}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost hidden px-2 sm:inline-flex"
              title="Source on GitHub"
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
              className="btn-ghost px-2 md:hidden"
              onClick={() => setMobileOpen((v) => !v)}
              aria-label="Toggle menu"
              aria-expanded={mobileOpen}
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {mobileOpen && (
          <div className="animate-slide-up border-t border-white/[0.06] bg-ink-950/95 px-4 py-4 md:hidden">
            <nav className="flex flex-col gap-0.5">
              {NAV.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={() => setMobileOpen(false)}
                  activeProps={{ className: 'nav-link block bg-white/[0.06] text-white' }}
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
                    activeProps={{ className: 'nav-link block bg-white/[0.06] text-white' }}
                    inactiveProps={{ className: 'nav-link block' }}
                  >
                    Dashboard
                  </Link>
                  <Link
                    to="/profile"
                    onClick={() => setMobileOpen(false)}
                    activeProps={{ className: 'nav-link block bg-white/[0.06] text-white' }}
                    inactiveProps={{ className: 'nav-link block' }}
                  >
                    Profile
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

            <div className="mt-4 border-t border-white/[0.06] pt-4">
              {isLoading ? (
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <Spinner className="h-4 w-4" />
                  Checking session…
                </div>
              ) : isAuthenticated && user ? (
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Avatar name={user.displayName} src={user.avatarUrl} size="sm" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-200">
                        {user.displayName}
                      </p>
                      <p className="truncate font-mono text-2xs text-slate-500">
                        @{user.namespace}
                      </p>
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

/** Orbit-node mark, shared with `public/favicon.svg`. */
function LogoMark() {
  return (
    <span className="relative flex h-8 w-8 items-center justify-center">
      <svg viewBox="0 0 32 32" className="h-8 w-8">
        <defs>
          <linearGradient id="ph-mark" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#67e8f9" />
            <stop offset="0.5" stopColor="#22d3ee" />
            <stop offset="1" stopColor="#a78bfa" />
          </linearGradient>
        </defs>
        <circle
          cx="16"
          cy="16"
          r="12.5"
          fill="none"
          stroke="url(#ph-mark)"
          strokeOpacity="0.35"
          strokeWidth="1.25"
          strokeDasharray="2 3"
        />
        <circle cx="16" cy="16" r="6" fill="url(#ph-mark)" />
        <circle cx="16" cy="16" r="6" fill="none" stroke="#04060a" strokeWidth="1" />
      </svg>
      <span className="pointer-events-none absolute inset-0 rounded-full bg-peko-400/25 opacity-0 blur-md transition-opacity duration-300 group-hover:opacity-100" />
    </span>
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
        className="flex items-center gap-2 rounded-lg border border-transparent py-1 pl-1 pr-2.5 transition-colors hover:border-white/[0.08] hover:bg-white/[0.04]"
      >
        <Avatar name={name} src={avatarUrl} size="sm" />
        <span className="max-w-[9rem] truncate text-sm font-medium text-slate-300">{name}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-56 animate-scale-in overflow-hidden rounded-xl border border-white/[0.08] bg-ink-850/95 shadow-lifted backdrop-blur-xl"
        >
          <div className="border-b border-white/[0.06] px-3.5 py-3">
            <p className="truncate text-sm font-medium text-slate-100">{name}</p>
            <p className="truncate font-mono text-2xs text-slate-500">@{namespace}</p>
          </div>
          <div className="p-1.5">
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
              label="Profile & API keys"
              onClick={() => {
                setOpen(false);
                void navigate({ to: '/profile' });
              }}
            />
          </div>
          <div className="border-t border-white/[0.06] p-1.5">
            <MenuItem
              icon={<LogOut className="h-4 w-4" />}
              label="Sign out"
              danger
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
  danger = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
        danger
          ? 'text-rose-300 hover:bg-rose-500/10 hover:text-rose-200'
          : 'text-slate-300 hover:bg-white/[0.05] hover:text-white'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function SiteFooter() {
  return (
    <footer className="relative mt-20 border-t border-white/[0.06] bg-ink-950/60">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <div className="flex items-center gap-2.5">
              <LogoMark />
              <span className="text-[15px] font-semibold tracking-tight text-slate-100">
                Peko<span className="grad-text">Hub</span>
              </span>
            </div>
            <p className="lede mt-4 max-w-sm">
              Registry, relay and directory for pekos. Discover what people have grown, talk to
              them in the browser, and pull the templates they started from.
            </p>
            <p className="mt-5 font-mono text-2xs text-slate-600">
              OCI Distribution v1.1 · tunnel relay · EdDSA bridge tokens
            </p>
          </div>

          <FooterColumn title="Directory">
            <FooterLink to="/pekos">Pekos</FooterLink>
            <FooterLink to="/templates">Templates</FooterLink>
            <FooterLink to="/dashboard">Dashboard</FooterLink>
          </FooterColumn>

          <FooterColumn title="Project">
            <FooterAnchor href={REPO_URL}>GitHub</FooterAnchor>
            <FooterAnchor href={`${REPO_URL}/tree/main/docs`}>Architecture</FooterAnchor>
            <FooterAnchor href={`${REPO_URL}/blob/main/DEPLOYMENT.md`}>Deployment</FooterAnchor>
          </FooterColumn>
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-white/[0.06] pt-6 sm:flex-row sm:items-center">
          <p className="font-mono text-2xs text-slate-600">
            © {new Date().getFullYear()} PekoHub — built for the Peko ecosystem
          </p>
          <p className="flex items-center gap-2 font-mono text-2xs text-slate-600">
            <Radar className="h-3 w-3 text-emerald-400" />
            <span>relay online</span>
            <Boxes className="ml-2 h-3 w-3 text-iris-400" />
            <span>registry v2</span>
          </p>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="eyebrow">{title}</p>
      <ul className="mt-4 space-y-2.5">{children}</ul>
    </div>
  );
}

function FooterLink({ to, children }: { to: '/pekos' | '/templates' | '/dashboard'; children: React.ReactNode }) {
  return (
    <li>
      <Link to={to} className="text-sm text-slate-400 transition-colors hover:text-peko-200">
        {children}
      </Link>
    </li>
  );
}

function FooterAnchor({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-slate-400 transition-colors hover:text-peko-200"
      >
        {children}
      </a>
    </li>
  );
}

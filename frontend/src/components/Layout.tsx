import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Package, Github, Loader2, LogOut, User, Menu, X } from 'lucide-react';
import { useAuth } from '~/hooks/useAuth';

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const { user, isLoading, isAuthenticated, logout } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-gray-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link to="/" className="flex items-center gap-2">
            <Package className="h-6 w-6 text-peko-600" />
            <span className="text-xl font-bold text-gray-900">PekoHub</span>
          </Link>

          <nav className="hidden md:flex items-center gap-6">
            <Link to="/" className="text-sm font-medium text-gray-600 hover:text-gray-900">
              Explore
            </Link>
            <a
              href="https://github.com/coneko/pekobot"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-gray-600 hover:text-gray-900 flex items-center gap-1"
            >
              <Github className="h-4 w-4" />
              GitHub
            </a>
          </nav>

          <div className="flex items-center gap-3">
            {/* Desktop auth */}
            <div className="hidden md:flex items-center gap-3">
              {isLoading ? (
                <Loader2 className="h-5 w-5 animate-spin text-peko-600" />
              ) : isAuthenticated && user ? (
                <div className="relative">
                  <button
                    onClick={() => setDropdownOpen((v) => !v)}
                    className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-gray-50"
                  >
                    {user.avatarUrl ? (
                      <img
                        src={user.avatarUrl}
                        alt={user.displayName}
                        className="h-8 w-8 rounded-full object-cover"
                      />
                    ) : (
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-peko-100 text-sm font-semibold text-peko-700">
                        {getInitials(user.displayName)}
                      </span>
                    )}
                    <span className="text-sm font-medium text-gray-700">{user.displayName}</span>
                  </button>

                  {dropdownOpen && (
                    <div className="absolute right-0 mt-2 w-48 rounded-lg border border-gray-200 bg-white shadow-lg">
                      <Link
                        to="/profile"
                        className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                        onClick={() => setDropdownOpen(false)}
                      >
                        <User className="h-4 w-4" />
                        Profile
                      </Link>
                      <button
                        onClick={() => {
                          setDropdownOpen(false);
                          logout();
                        }}
                        className="flex w-full items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                      >
                        <LogOut className="h-4 w-4" />
                        Sign out
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <a
                  href="/api/v1/auth/github/authorize"
                  className="btn-primary text-sm py-1.5"
                >
                  Sign In
                </a>
              )}
            </div>

            {/* Mobile hamburger */}
            <button
              className="md:hidden inline-flex items-center justify-center rounded-lg p-2 text-gray-600 hover:bg-gray-50"
              onClick={() => setMobileMenuOpen((v) => !v)}
              aria-label="Toggle menu"
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-gray-200 bg-white px-4 py-3">
            <nav className="flex flex-col gap-3">
              <Link
                to="/"
                className="text-sm font-medium text-gray-600 hover:text-gray-900"
                onClick={() => setMobileMenuOpen(false)}
              >
                Explore
              </Link>
              <a
                href="https://github.com/coneko/pekobot"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium text-gray-600 hover:text-gray-900 flex items-center gap-1"
              >
                <Github className="h-4 w-4" />
                GitHub
              </a>
              <div className="border-t border-gray-100 pt-3">
                {isLoading ? (
                  <div className="flex items-center gap-2 text-sm text-gray-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading...
                  </div>
                ) : isAuthenticated && user ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      {user.avatarUrl ? (
                        <img
                          src={user.avatarUrl}
                          alt={user.displayName}
                          className="h-8 w-8 rounded-full object-cover"
                        />
                      ) : (
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-peko-100 text-sm font-semibold text-peko-700">
                          {getInitials(user.displayName)}
                        </span>
                      )}
                      <span className="text-sm font-medium text-gray-700">{user.displayName}</span>
                    </div>
                    <Link
                      to="/profile"
                      className="flex items-center gap-2 text-sm text-gray-700"
                      onClick={() => setMobileMenuOpen(false)}
                    >
                      <User className="h-4 w-4" />
                      Profile
                    </Link>
                    <button
                      onClick={() => {
                        setMobileMenuOpen(false);
                        logout();
                      }}
                      className="flex items-center gap-2 text-sm text-gray-700"
                    >
                      <LogOut className="h-4 w-4" />
                      Sign out
                    </button>
                  </div>
                ) : (
                  <a
                    href="/api/v1/auth/github/authorize"
                    className="btn-primary text-sm py-1.5 inline-flex w-fit"
                  >
                    Sign In
                  </a>
                )}
              </div>
            </nav>
          </div>
        )}
      </header>

      {/* Main */}
      <main className="flex-1">{children}</main>

      {/* Footer */}
      <footer className="border-t border-gray-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <p className="text-center text-sm text-gray-500">
            &copy; {new Date().getFullYear()} PekoHub. Built for the Pekobot ecosystem.
          </p>
        </div>
      </footer>
    </div>
  );
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

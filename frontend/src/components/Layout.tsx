import { Link } from '@tanstack/react-router';
import { Package, Github } from 'lucide-react';

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
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
            <a
              href="/api/v1/auth/github/authorize"
              className="btn-primary text-sm py-1.5"
            >
              Sign In
            </a>
          </div>
        </div>
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

import { Github, X } from 'lucide-react';
import { API_BASE } from '~/lib/api';

interface SignInModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SignInModal({ isOpen, onClose }: SignInModalProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-950/80 p-4 backdrop-blur-md"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="panel animate-scale-in relative w-full max-w-sm p-7"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Sign in"
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-md p-1 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>

        <p className="eyebrow">PekoHub account</p>
        <h2 className="display mt-2 text-xl">Sign in to PekoHub</h2>
        <p className="lede mt-1.5">
          Manage exposure, publish seeds and keep your API keys in one place.
        </p>

        <div className="mt-6 flex flex-col gap-2.5">
          <a
            href={`${API_BASE}/v1/auth/github/authorize`}
            className="btn-secondary justify-center py-2.5"
          >
            <Github className="h-4 w-4" />
            Continue with GitHub
          </a>

          <a
            href={`${API_BASE}/v1/auth/google/authorize`}
            className="btn-secondary justify-center py-2.5"
          >
            <GoogleMark />
            Continue with Google
          </a>
        </div>

        <div className="divider my-6" />

        <p className="text-center font-mono text-2xs leading-relaxed text-slate-600">
          By signing in you agree to the Terms of Service
          <br />
          and the Privacy Policy.
        </p>
      </div>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

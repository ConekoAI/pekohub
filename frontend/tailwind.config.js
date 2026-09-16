/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Canvas + surface ramp. `ink-950` is the page, `ink-800` is a
        // resting card, `ink-700` is a hairline / divider.
        ink: {
          950: '#04060a',
          900: '#070a10',
          850: '#0a0e16',
          800: '#0d121b',
          750: '#121826',
          700: '#1a2130',
          600: '#242e40',
          500: '#333f55',
        },
        // Brand accent (cyan). Primary actions, active state, the
        // "live / running" readout voice.
        peko: {
          50: '#ecfeff',
          100: '#cffafe',
          200: '#a5f3fc',
          300: '#67e8f9',
          400: '#22d3ee',
          500: '#06b6d4',
          600: '#0891b2',
          700: '#0e7490',
          800: '#155e75',
          900: '#164e63',
          950: '#083344',
        },
        // Secondary accent (violet). Pairs with peko for gradients and
        // marks the "template / DNA" lane.
        iris: {
          300: '#c4b5fd',
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
          700: '#6d28d9',
          900: '#4c1d95',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        card: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 16px 40px -24px rgba(0,0,0,0.95)',
        lifted:
          '0 1px 0 0 rgba(255,255,255,0.06) inset, 0 24px 60px -28px rgba(0,0,0,1)',
        glow: '0 0 0 1px rgba(34,211,238,0.22), 0 12px 48px -18px rgba(34,211,238,0.45)',
        'glow-iris':
          '0 0 0 1px rgba(167,139,250,0.22), 0 12px 48px -18px rgba(139,92,246,0.45)',
        'glow-sm': '0 0 24px -8px rgba(34,211,238,0.5)',
      },
      backgroundImage: {
        // Hairline graph paper — two 1px rules on a 56px lattice.
        grid: `linear-gradient(to right, rgba(148,163,184,0.055) 1px, transparent 1px),
               linear-gradient(to bottom, rgba(148,163,184,0.055) 1px, transparent 1px)`,
        'brand-gradient':
          'linear-gradient(100deg, #67e8f9 0%, #22d3ee 32%, #818cf8 68%, #a78bfa 100%)',
        'brand-fade':
          'linear-gradient(180deg, rgba(34,211,238,0.16) 0%, rgba(139,92,246,0.06) 45%, transparent 100%)',
        'surface-sheen':
          'linear-gradient(180deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0) 42%)',
      },
      backgroundSize: {
        grid: '56px 56px',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.97)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        drift: {
          '0%, 100%': { transform: 'translate3d(0,0,0)' },
          '50%': { transform: 'translate3d(0,-18px,0)' },
        },
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(52,211,153,0.55)' },
          '70%': { boxShadow: '0 0 0 6px rgba(52,211,153,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(52,211,153,0)' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.45s cubic-bezier(0.22, 1, 0.36, 1) both',
        'fade-in': 'fade-in 0.3s ease-out both',
        'scale-in': 'scale-in 0.18s cubic-bezier(0.22, 1, 0.36, 1) both',
        drift: 'drift 12s ease-in-out infinite',
        shimmer: 'shimmer 1.8s infinite',
        'pulse-ring': 'pulse-ring 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'slide-up': 'slide-up 0.22s cubic-bezier(0.22, 1, 0.36, 1) both',
      },
    },
  },
  plugins: [],
};

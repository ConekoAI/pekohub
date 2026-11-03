/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Navy-slate surface ramp. `ink-950` is the page, `ink-900` a
        // resting card, `ink-700` a hairline.
        ink: {
          950: '#0c1018',
          900: '#111620',
          850: '#141a26',
          800: '#181f2c',
          750: '#1d2534',
          700: '#252e3f',
          600: '#313b4f',
          500: '#414c62',
        },
        // The one accent: a muted steel blue. Primary actions, links,
        // the active state, "online".
        peko: {
          50: '#f3f6fa',
          100: '#e3e9f2',
          200: '#c8d3e4',
          300: '#a7b8d2',
          400: '#869cc0',
          500: '#6a82ab',
          600: '#566c93',
          700: '#475978',
          800: '#3a4860',
          900: '#2f3a4e',
          950: '#1e2533',
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
        lifted: '0 16px 40px -20px rgba(0, 0, 0, 0.7)',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.98)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.35s cubic-bezier(0.22, 1, 0.36, 1) both',
        'fade-in': 'fade-in 0.25s ease-out both',
        'scale-in': 'scale-in 0.16s cubic-bezier(0.22, 1, 0.36, 1) both',
        shimmer: 'shimmer 1.8s infinite',
      },
    },
  },
  plugins: [],
};

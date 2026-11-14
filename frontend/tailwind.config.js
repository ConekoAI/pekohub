/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Neutral surface ramp (black and white, no tint). `ink-950` is
        // the page, `ink-900` a resting card, `ink-700` a hairline. Shared
        // with Peko Desktop (src/styles/index.css).
        ink: {
          950: '#0a0a0a',
          900: '#111111',
          850: '#161616',
          800: '#1c1c1c',
          750: '#222222',
          700: '#2b2b2b',
          600: '#3a3a3a',
          500: '#525252',
        },
        // Text grays: Tailwind's slate is blue-tinted, so the scale is
        // remapped to neutral gray to keep the site black and white.
        slate: {
          50: '#fafafa',
          100: '#f5f5f5',
          200: '#e5e5e5',
          300: '#d4d4d4',
          400: '#a3a3a3',
          500: '#737373',
          600: '#525252',
          700: '#404040',
          800: '#262626',
          900: '#171717',
          950: '#0a0a0a',
        },
        // Peko teal, the logo color (600 = #008880). An accent used
        // sparingly: focus rings, the online dot, unread counts and the
        // one highlighted phrase on the landing page. Buttons and links
        // stay black and white.
        peko: {
          50: '#e5fdfa',
          100: '#dbf3f0',
          200: '#b7e6e0',
          300: '#7ed3ca',
          400: '#4eb8af',
          500: '#309f97',
          600: '#008880',
          700: '#006f67',
          800: '#00554f',
          900: '#003f3b',
          950: '#002a27',
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

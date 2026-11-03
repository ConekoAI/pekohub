/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Navy surface ramp. `ink-950` is the page, `ink-900` a
        // resting card, `ink-700` a hairline.
        ink: {
          950: '#0a0f1e',
          900: '#0e1527',
          850: '#121a2f',
          800: '#161f37',
          750: '#1b2641',
          700: '#232f4d',
          600: '#2e3b5d',
          500: '#3e4c71',
        },
        // The one accent: the brand blue. Primary actions, links,
        // the active state, "online".
        peko: {
          50: '#eef3fd',
          100: '#dce6fb',
          200: '#bacdf6',
          300: '#92b0ef',
          400: '#6c92e6',
          500: '#4f79d9',
          600: '#3e64c2',
          700: '#33519d',
          800: '#2d4580',
          900: '#283b67',
          950: '#1a2443',
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

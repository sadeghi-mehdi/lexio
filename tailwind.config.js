/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          0: '#0a0a0f',
          1: '#12121a',
          2: '#1a1a25',
          3: '#222230',
          4: '#2a2a3a',
        },
        accent: {
          DEFAULT: '#6c5ce7',
          light: '#a29bfe',
          dim: '#4a3fb5',
        },
        highlight: {
          yellow: 'rgba(253, 203, 110, 0.35)',
          green: 'rgba(85, 239, 196, 0.30)',
          blue: 'rgba(116, 185, 255, 0.30)',
          pink: 'rgba(253, 121, 168, 0.30)',
          orange: 'rgba(255, 159, 67, 0.30)',
        },
        text: {
          primary: '#e8e8f0',
          secondary: '#9999aa',
          muted: '#666677',
        },
      },
      fontFamily: {
        sans: ['"DM Sans Variable"', '"DM Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.25s ease-out',
        'pulse-dot': 'pulseDot 1.4s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        pulseDot: {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};

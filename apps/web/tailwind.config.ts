import type { Config } from 'tailwindcss';

/**
 * Tailwind theme mapped onto the design tokens in globals.css
 * (Frontend Spec §4–§6, §36).
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#2563EB',
          hover: '#1D4ED8',
          light: '#EFF6FF',
        },
        success: { DEFAULT: '#16A34A', light: '#F0FDF4' },
        warning: { DEFAULT: '#D97706', light: '#FFFBEB' },
        danger: { DEFAULT: '#DC2626', light: '#FEF2F2' },
        info: { DEFAULT: '#0284C7', light: '#F0F9FF' },
        surface: '#FFFFFF',
        canvas: '#F8FAFC',
        border: { DEFAULT: '#E2E8F0', strong: '#CBD5E1' },
        ink: {
          DEFAULT: '#0F172A',
          secondary: '#475569',
          muted: '#64748B',
          disabled: '#94A3B8',
        },
      },
      fontSize: {
        display: ['32px', { lineHeight: '40px', fontWeight: '700' }],
        h1: ['28px', { lineHeight: '36px', fontWeight: '700' }],
        h2: ['24px', { lineHeight: '32px', fontWeight: '700' }],
        h3: ['20px', { lineHeight: '28px', fontWeight: '600' }],
        h4: ['16px', { lineHeight: '24px', fontWeight: '600' }],
        'body-lg': ['16px', { lineHeight: '24px' }],
        body: ['14px', { lineHeight: '20px' }],
        'body-sm': ['13px', { lineHeight: '18px' }],
        caption: ['12px', { lineHeight: '16px' }],
      },
      borderRadius: {
        sm: '6px',
        md: '10px',
        lg: '12px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 23, 42, 0.05)',
        modal: '0 20px 40px rgba(15, 23, 42, 0.15)',
      },
      spacing: {
        // 4px scale from Spec §6.
        '1': '4px',
        '2': '8px',
        '3': '12px',
        '4': '16px',
        '5': '20px',
        '6': '24px',
        '8': '32px',
        '10': '40px',
        '12': '48px',
        '16': '64px',
      },
      maxWidth: {
        content: '1440px',
      },
    },
  },
  plugins: [],
};

export default config;

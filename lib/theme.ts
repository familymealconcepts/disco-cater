// Canonical Disco Cater brand tokens. Use these instead of hardcoding hex values
// so colors stay consistent across the app. (Full migration of every page is a
// larger refactor — adopt these incrementally.)
export const COLORS = {
  primary: '#5B6FE8',
  primaryDark: '#1A1028',
  purple: '#6B6EF9',
  magenta: '#C044C8',
  pink: '#F0468A',
  gold: '#EFB84A',
  gradient: 'linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)',
  success: '#1D9E75',
  danger: '#E53935',
  warning: '#F59E0B',
  errorText: '#DC2626',
  muted: '#6B7280',
} as const

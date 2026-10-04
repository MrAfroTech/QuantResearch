/** Wall Street navy tokens. Visual only — keep in sync with theme.css fallbacks. */

export const theme = {
  bg: '#071A33',
  panel: '#0B2747',
  panelAlt: '#10365C',
  primary: '#1557A5',
  accent: '#2878C8',
  light: '#6FA8DC',
  text: '#FFFFFF',
  textMuted: '#AFC4D9',
  positive: '#2E9B62',
  negative: '#C94A4A',
  border: 'rgba(111, 168, 220, 0.28)',
  divider: 'rgba(111, 168, 220, 0.16)',
};

export function applyTheme(root = document.documentElement) {
  const vars = {
    '--desk-bg': theme.bg,
    '--desk-panel': theme.panel,
    '--desk-panel-alt': theme.panelAlt,
    '--desk-primary': theme.primary,
    '--desk-accent': theme.accent,
    '--desk-light': theme.light,
    '--desk-text': theme.text,
    '--desk-text-muted': theme.textMuted,
    '--desk-positive': theme.positive,
    '--desk-negative': theme.negative,
    '--desk-border': theme.border,
  };
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
}

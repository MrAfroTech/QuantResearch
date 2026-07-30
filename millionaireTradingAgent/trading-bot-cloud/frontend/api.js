/** API base for the dashboard. Vercel builds must set VITE_API_URL to the Railway host. */
export function getApiBase() {
  const fromEnv = import.meta.env.VITE_API_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  if (import.meta.env.DEV) return 'http://localhost:3001';
  return '';
}

export function getApiConfigError() {
  if (getApiBase()) return null;
  return 'VITE_API_URL is not set. Add your Railway URL in Vercel project settings and redeploy.';
}

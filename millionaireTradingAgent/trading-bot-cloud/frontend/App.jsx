import React from 'react';
import Dashboard from './Dashboard.jsx';
import { theme } from './theme.js';

export default function App() {
  return (
    <div style={{
      fontFamily: 'system-ui, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
      maxWidth: 1200,
      margin: '0 auto',
      padding: 24,
      color: theme.text,
    }}>
      <header style={{ marginBottom: 32, borderBottom: `1px solid ${theme.divider}`, paddingBottom: 16 }}>
        <h1 style={{ margin: 0, color: theme.text, letterSpacing: '0.02em', fontWeight: 650 }}>The305</h1>
        <p style={{ color: theme.textMuted, margin: '8px 0 0' }}>
          Tastytrade · Cloud · Tradier
        </p>
      </header>
      <Dashboard />
    </div>
  );
}

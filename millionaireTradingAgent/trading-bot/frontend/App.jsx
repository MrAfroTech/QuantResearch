import React from 'react';
import Dashboard from './Dashboard.jsx';

export default function App() {
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 1200, margin: '0 auto', padding: 24 }}>
      <header style={{ marginBottom: 32 }}>
        <h1 style={{ margin: 0 }}>The305</h1>
      </header>
      <Dashboard />
    </div>
  );
}

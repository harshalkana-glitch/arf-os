import type { JSX } from 'react';
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ARF-OS',
  description: 'Research operations console',
};

/**
 * Application shell.
 *
 * Desktop-first (spec 15.1): research work is dense, and the tables here carry
 * more columns than a phone can show without hiding evidence.
 */
export default function RootLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <body>
        <div className="layout">
          <nav className="sidebar" aria-label="Primary">
            <div className="brand">
              ARF-OS
              <small>RESEARCH CONSOLE</small>
            </div>
            <div className="nav">
              <a href="/">Command Centre</a>
              <a href="/campaigns">Campaigns</a>
              <a href="/strategies">Strategy Library</a>
              <a href="/committee">Committee</a>
            </div>
            <p
              className="small muted"
              style={{ marginTop: 28, padding: '0 8px', lineHeight: 1.45 }}
            >
              Historical and simulated results only. Not a guarantee of future performance.
            </p>
          </nav>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}

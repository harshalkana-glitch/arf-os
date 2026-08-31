import type { JSX } from 'react';
import { ApiError, api } from '@/lib/api';

/**
 * Command Centre.
 *
 * A server component: this is a stable read view, so it renders on the server
 * and never reaches the database directly (CLAUDE.md 18.5) — everything comes
 * through the API.
 */
export const dynamic = 'force-dynamic';

export default async function CommandCentre(): Promise<JSX.Element> {
  let campaigns: Awaited<ReturnType<typeof api.campaigns>> | null = null;
  let error: string | null = null;

  try {
    campaigns = await api.campaigns();
  } catch (caught: unknown) {
    // An unreachable API is a state the console must render, not a crash.
    error =
      caught instanceof ApiError
        ? `${caught.problem.title}: ${caught.problem.detail ?? caught.problem.code}`
        : 'The API is unreachable. Is it running on port 3001?';
  }

  return (
    <>
      <h1>Command Centre</h1>
      <p className="subtitle">What the research factory is doing, and what needs a human.</p>

      {error ? (
        <p className="notice notice-critical">⚠ {error}</p>
      ) : (
        <>
          <div className="grid grid-3">
            <Stat label="Active campaigns" value={String(campaigns?.items.length ?? 0)} />
            <Stat
              label="Model spend"
              value={`$${campaigns?.items
                .reduce((sum, c) => sum + Number(c.modelSpendUsd), 0)
                .toFixed(2) ?? '0.00'}`}
            />
            <Stat label="Awaiting verification" value="—" hint="Requires the library read model" />
          </div>

          <h2>Campaigns</h2>
          {campaigns && campaigns.items.length > 0 ? (
            <div className="card scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Objective</th>
                    <th>State</th>
                    <th className="num">Spend</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.items.map((c) => (
                    <tr key={c.id}>
                      <td>{c.title}</td>
                      <td className="muted">{c.objective}</td>
                      <td>
                        <span className="badge">{c.state.replace(/_/g, ' ')}</span>
                      </td>
                      <td className="num">{Number(c.modelSpendUsd).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty">
              No campaigns yet. Research begins with a campaign that states a falsifiable
              objective.
            </p>
          )}
        </>
      )}
    </>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): JSX.Element {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint ? (
        <div className="small muted" style={{ marginTop: 2 }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

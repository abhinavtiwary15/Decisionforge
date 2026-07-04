import React from 'react';

/**
 * Top-level React Error Boundary.
 * Catches any render error below it and shows a branded recovery screen
 * instead of a silent blank page.
 *
 * BUG THAT TRIGGERED THIS: BigQuery DATE columns are returned as
 * { value: "YYYY-MM-DD" } objects. React throws
 * "Objects are not valid as a React child (found: object with keys {value})"
 * when these are rendered as JSX children directly. Fix applied in
 * server.js (formatBqRow) flattens them to plain ISO strings. This
 * boundary is an additional safety net for any future render errors.
 */
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[DecisionForge Error Boundary caught]', error, errorInfo);
    this.setState({ errorInfo });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="ml-64 flex-1 min-h-screen p-8 flex items-start justify-center pt-20"
             style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
          <div
            style={{
              background: '#F3EEE2',
              border: '1px solid rgba(27,24,17,0.15)',
              maxWidth: '640px',
              width: '100%',
              padding: '2rem',
            }}
          >
            {/* Red stamp header */}
            <div
              style={{
                borderLeft: '3px solid #A63A2E',
                paddingLeft: '1rem',
                marginBottom: '1.5rem',
              }}
            >
              <p style={{ fontSize: '10px', fontFamily: "'IBM Plex Mono', monospace", color: '#A63A2E', letterSpacing: '0.1em', fontWeight: 700, textTransform: 'uppercase' }}>
                RENDER EXCEPTION — AUDIT PORTAL
              </p>
              <h2 style={{ fontFamily: 'Fraunces, serif', fontSize: '1.25rem', fontWeight: 700, color: '#1B1811', marginTop: '0.25rem' }}>
                An unhandled render error occurred
              </h2>
            </div>

            {/* Error message */}
            <div style={{ background: 'rgba(166,58,46,0.06)', border: '1px solid rgba(166,58,46,0.2)', padding: '1rem', marginBottom: '1.5rem' }}>
              <p style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: '12px', color: '#A63A2E', wordBreak: 'break-word' }}>
                {this.state.error?.message || 'Unknown error'}
              </p>
            </div>

            {/* Explanation */}
            <p style={{ fontSize: '12px', color: 'rgba(27,24,17,0.7)', marginBottom: '1.5rem', lineHeight: 1.6 }}>
              The page component threw an error after the data loaded. This is commonly caused by
              an unexpected API response shape (e.g. a date object instead of a string).
              Click <strong>Retry</strong> to reload the page, or navigate to a different screen from the sidebar.
            </p>

            {/* Stack trace (collapsed) */}
            <details style={{ marginBottom: '1.5rem' }}>
              <summary style={{ fontSize: '11px', fontFamily: "'IBM Plex Mono', monospace", color: 'rgba(27,24,17,0.5)', cursor: 'pointer' }}>
                Show component stack trace
              </summary>
              <pre style={{ fontSize: '10px', color: 'rgba(27,24,17,0.55)', marginTop: '0.5rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>
                {this.state.errorInfo?.componentStack}
              </pre>
            </details>

            {/* Actions */}
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              {/* Primary: Brass fill */}
              <button
                onClick={() => this.setState({ hasError: false, error: null, errorInfo: null })}
                style={{ background: '#A9781E', color: '#F3EEE2', border: '1px solid #A9781E', padding: '0.5rem 1.25rem', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
              >
                Retry
              </button>
              {/* Secondary: Ink outline */}
              <button
                onClick={() => window.location.reload()}
                style={{ background: 'transparent', color: '#1B1811', border: '1px solid rgba(27,24,17,0.5)', padding: '0.5rem 1.25rem', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
              >
                Full Page Reload
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;

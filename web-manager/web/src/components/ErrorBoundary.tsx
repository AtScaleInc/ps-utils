import { Component, type ReactNode } from 'react'

/** A render error in one tab shows here instead of blanking the whole app
 * (React unmounts everything on an uncaught render error). `resetKey`
 * changing - another tab or section - clears it. */
export class ErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | null; key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null
  }

  componentDidCatch(error: Error) {
    console.error(error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="notice err" style={{ margin: 24 }}>
        <span className="eyebrow" style={{ color: 'var(--danger)' }}>Something broke on this page</span>
        <span>{this.state.error.message}</span>
        <button type="button" className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    )
  }
}

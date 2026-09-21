import React from "react";

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  /** Called when an error is caught */
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * ErrorBoundary — wraps a subtree and catches render-time errors so they
 * don't propagate up and crash the entire app.
 *
 * Usage:
 *   <ErrorBoundary fallback={<div>Something went wrong</div>}>
 *     <RiskyComponent />
 *   </ErrorBoundary>
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Log to console so the dev panel / DevTools can see it
    console.error("[ErrorBoundary] Caught render error:", error, info.componentStack);
    this.props.onError?.(error, info);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div className="flex items-center justify-center py-4 px-3">
          <span className="text-[11px] text-red-400/70">
            Rendering error — reload the app if this persists.
          </span>
        </div>
      );
    }
    return this.props.children;
  }
}
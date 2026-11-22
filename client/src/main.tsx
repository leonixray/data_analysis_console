import { spaceQueryClient } from "@hatch/space-sdk/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./theme.css";

const rootEl = document.querySelector<HTMLElement>("[data-generated-space-root]");
if (!rootEl) {
  throw new Error("missing generated space root element");
}

// Last-resort render guard: a throw anywhere in the tree used to
// unmount the whole app into a permanent white screen (2026-11-23:
// a stale localStorage dashboard seed missing the new aiHardware
// block crashed the overview render, and the dead tree could never
// rewrite the seed). The fallback explains what happened and offers
// a one-tap recovery that drops every local cache entry and reloads
// into a clean network load.
class RootErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error("render crash caught by RootErrorBoundary", error);
  }

  private recover = (): void => {
    try {
      window.localStorage.clear();
    } catch {
      // Storage unavailable: reload anyway.
    }
    window.location.reload();
  };

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          background: "var(--bg)",
          color: "var(--text)",
        }}
      >
        <div style={{ maxWidth: "420px", textAlign: "center" }}>
          <p style={{ fontSize: "18px", fontWeight: 700, marginBottom: "8px" }}>页面加载出错</p>
          <p style={{ fontSize: "14px", lineHeight: 1.7, color: "var(--dim)", marginBottom: "20px" }}>
            多半是浏览器里存着旧版本的页面缓存。清除本地缓存并重新加载即可恢复，服务器上的数据不受影响。
          </p>
          <button
            type="button"
            onClick={this.recover}
            style={{
              minHeight: "44px",
              padding: "0 20px",
              borderRadius: "10px",
              border: "none",
              background: "var(--accent)",
              color: "#fff",
              fontSize: "15px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            清除本地缓存并重新加载
          </button>
        </div>
      </div>
    );
  }
}

// If you edit this file: keep `<QueryClientProvider client={spaceQueryClient}>`
// wrapping the app (every space shares the SDK's QueryClient), and keep
// BOTH the `hatch-space-root` class AND the `data-hatch-space-root`
// attribute on the outer div. The SDK styles select on
// `.hatch-space-root[data-hatch-space-root]` to apply mobile safe-area
// insets (notches, gesture bars, etc.), correct viewport sizing, and the
// hosting header/chrome offsets — dropping either breaks layout silently.
createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={spaceQueryClient}>
      <div className="hatch-space-root" data-hatch-space-root>
        <RootErrorBoundary>
          <App />
        </RootErrorBoundary>
      </div>
    </QueryClientProvider>
  </StrictMode>,
);

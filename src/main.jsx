import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { initializeDashboard } from "../app.js";

const navigation = [
  ["Overview Dashboard", "◫"],
  ["Live Bus Monitoring", "⌖", "12"],
  ["Mismatch Alerts", "⚑", "4"],
  ["Bus & Route Management", "▤"],
  ["Passenger Analytics", "⌁"],
  ["Checker Dispatch", "♙"],
  ["Inspection History", "◷"],
  ["Reports & Analytics", "▥"],
];

function App() {
  useEffect(() => initializeDashboard(), []);

  return (
    <>
      <div className="app-shell">
        <aside className="sidebar" id="sidebar" aria-label="Main navigation">
          <a
            className="brand"
            href="#"
            data-page="Overview Dashboard"
            aria-label="SMART ST Control Center home"
          >
            <span className="brand-mark">
              <svg viewBox="0 0 40 40" aria-hidden="true">
                <path
                  d="M8 27V12.5A3.5 3.5 0 0 1 11.5 9h17a3.5 3.5 0 0 1 3.5 3.5V27M8 22h24M13 31h.01M27 31h.01M12 9l2-4h12l2 4M12 27v4m16-4v4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="brand-copy">
              <strong>SMART ST</strong>
              <small>CONTROL CENTER</small>
            </span>
          </a>
          <div className="side-caption">WORKSPACE</div>
          <nav className="nav-list">
            {navigation.map(([name, icon, count]) => (
              <button
                className={`nav-link${name === "Overview Dashboard" ? " active" : ""}`}
                data-page={name}
                key={name}
              >
                <span className="nav-icon">{icon}</span>
                <span>{name}</span>
                {count && (
                  <span
                    className={`nav-count${name === "Mismatch Alerts" ? " alert-count" : ""}`}
                  >
                    {count}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="side-caption side-caption-bottom">PREFERENCES</div>
          <nav className="nav-list">
            <button className="nav-link" data-page="Settings">
              <span className="nav-icon">⚙</span>
              <span>Settings</span>
            </button>
          </nav>
          <div className="sidebar-footer">
            <div className="online-dot" />
            <span>Demo environment</span>
            <span className="footer-version">v1.0</span>
          </div>
        </aside>

        <main className="main-area">
          <header className="topbar">
            <div className="topbar-left">
              <button
                className="icon-button menu-toggle"
                id="sidebarToggle"
                aria-label="Toggle navigation"
                title="Toggle navigation"
              >
                <span>☰</span>
              </button>
              <div className="breadcrumbs">
                <span>Workspace</span>
                <span className="crumb-slash">/</span>
                <strong id="breadcrumbTitle">Overview Dashboard</strong>
              </div>
            </div>
            <div className="topbar-right">
              <label className="global-search">
                <span>⌕</span>
                <input
                  id="globalSearch"
                  placeholder="Search buses, routes..."
                  aria-label="Search buses and routes"
                />
                <kbd>⌘ K</kbd>
              </label>
              <span className="top-date" id="topDate" />
              <button
                className="icon-button notification-button"
                id="notificationButton"
                aria-label="Notifications"
              >
                <span>♧</span>
                <i />
              </button>
              <button
                className="profile-button"
                id="profileButton"
                aria-label="Admin profile menu"
              >
                <span className="avatar">AD</span>
                <span className="profile-text">
                  <strong>Admin</strong>
                  <small>Control room</small>
                </span>
                <span className="profile-caret">⌄</span>
              </button>
            </div>
          </header>
          <section className="content" id="pageContent" aria-live="polite" />
          <footer className="app-footer">
            <span>SMART ST Control Center</span>
            <span>Demonstration data · Not connected to live systems</span>
          </footer>
        </main>
      </div>
      <div id="modalRoot" />
      <div id="toastRoot" className="toast-root" aria-live="polite" />
    </>
  );
}

createRoot(document.getElementById("root")).render(<App />);

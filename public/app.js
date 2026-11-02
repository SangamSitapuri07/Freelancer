(function () {
  "use strict";

  const TOKEN_KEY = "ghostgate.admin.token";
  const VIEWS = ["overview", "licenses", "audit", "settings"];
  const PAGE_META = {
    overview: {
      title: "Overview",
      subtitle: "A live view of your licensing operation.",
    },
    licenses: {
      title: "Licenses",
      subtitle: "Issue, inspect, and revoke access.",
    },
    audit: {
      title: "Audit log",
      subtitle: "Every privileged action, recorded.",
    },
    settings: {
      title: "Settings",
      subtitle: "Server, security, and client integration.",
    },
  };

  const state = {
    token: storageGet(TOKEN_KEY),
    admin: null,
    view: "overview",
    stats: null,
    licenses: [],
    licenseTotal: 0,
    page: 1,
    pageSize: 20,
    search: "",
    status: "all",
    auditLogs: [],
    auditTotal: 0,
    auditSearch: "",
    settings: null,
    selectedLicense: null,
    redirectingToLogin: false,
  };

  const dom = {};

  const api = {
    async request(path, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      if (state.token) headers.Authorization = `Bearer ${state.token}`;

      const response = await fetch(path, {
        ...options,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });

      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(`Server returned an invalid response (${response.status})`);
        }
      }

      if (!response.ok) {
        const message = data?.error?.message || `Request failed (${response.status})`;
        const error = new Error(message);
        error.status = response.status;
        error.code = data?.error?.code;
        error.details = data?.error?.details;

        if (
          response.status === 401 &&
          path !== "/v1/admin/login" &&
          !state.redirectingToLogin
        ) {
          state.redirectingToLogin = true;
          state.token = null;
          storageRemove(TOKEN_KEY);
          showLogin();
          toast("Session expired. Please sign in again.", "error");
        }

        throw error;
      }

      return data;
    },
    get(path) {
      return this.request(path);
    },
    post(path, body) {
      return this.request(path, { method: "POST", body });
    },
    patch(path, body) {
      return this.request(path, { method: "PATCH", body });
    },
    delete(path) {
      return this.request(path, { method: "DELETE" });
    },
  };

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Storage can be unavailable in hardened browser contexts.
    }
  }

  function storageRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Ignore storage failures.
    }
  }

  function cacheDom() {
    dom.loginScreen = document.getElementById("login-screen");
    dom.loginForm = document.getElementById("login-form");
    dom.loginEmail = document.getElementById("login-email");
    dom.loginPassword = document.getElementById("login-password");
    dom.loginError = document.getElementById("login-error");
    dom.loginSubmit = document.getElementById("login-submit");
    dom.appShell = document.getElementById("app-shell");
    dom.viewRoot = document.getElementById("view-root");
    dom.pageTitle = document.getElementById("page-title");
    dom.pageSubtitle = document.getElementById("page-subtitle");
    dom.adminName = document.getElementById("admin-name");
    dom.adminEmail = document.getElementById("admin-email");
    dom.adminAvatar = document.getElementById("admin-avatar");
    dom.logoutButton = document.getElementById("logout-button");
    dom.refreshButton = document.getElementById("refresh-button");
    dom.newLicenseButton = document.getElementById("new-license-button");
    dom.modalRoot = document.getElementById("modal-root");
    dom.drawerRoot = document.getElementById("drawer-root");
    dom.toastRoot = document.getElementById("toast-root");
  }

  function bindEvents() {
    dom.loginForm.addEventListener("submit", handleLogin);
    dom.logoutButton.addEventListener("click", handleLogout);
    dom.refreshButton.addEventListener("click", refreshCurrentView);
    dom.newLicenseButton.addEventListener("click", openCreateLicenseModal);

    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("submit", handleDocumentSubmit);
    document.addEventListener("input", handleDocumentInput);
    document.addEventListener("change", handleDocumentChange);
    document.addEventListener("keydown", handleDocumentKeydown);

    window.addEventListener("hashchange", () => {
      const view = parseHash();
      if (view && VIEWS.includes(view) && view !== state.view) {
        state.view = view;
        render();
      }
    });
  }

  async function init() {
    cacheDom();
    bindEvents();

    const initialView = parseHash();
    if (initialView && VIEWS.includes(initialView)) state.view = initialView;

    if (state.token) {
      try {
        await loadMe();
        showDashboard();
        await loadDashboard();
        return;
      } catch {
        state.token = null;
        storageRemove(TOKEN_KEY);
      }
    }

    showLogin();
  }

  async function loadMe() {
    const data = await api.get("/v1/admin/me");
    state.admin = data.admin;
  }

  async function handleLogin(event) {
    event.preventDefault();

    const email = dom.loginEmail.value.trim();
    const password = dom.loginPassword.value;
    dom.loginError.hidden = true;

    if (!email || !password) {
      showLoginError("Enter your email and password.");
      return;
    }

    setLoginBusy(true, "Signing in…");

    try {
      const data = await api.post("/v1/admin/login", { email, password });
      state.token = data.token;
      state.admin = data.admin;
      storageSet(TOKEN_KEY, data.token);
      state.redirectingToLogin = false;
      dom.loginPassword.value = "";
      showDashboard();
      toast("Welcome back.", "success");
      try {
        await loadDashboard();
      } catch (error) {
        toast(error.message, "error");
      }
    } catch (error) {
      showLoginError(error.message);
    } finally {
      setLoginBusy(false, "Sign in");
    }
  }

  function setLoginBusy(busy, label) {
    dom.loginSubmit.disabled = busy;
    dom.loginSubmit.querySelector("span").textContent = label;
  }

  function showLoginError(message) {
    dom.loginError.textContent = message;
    dom.loginError.hidden = false;
  }

  async function handleLogout(options = {}) {
    if (!options.skipApi) {
      try {
        await api.post("/v1/admin/logout", {});
      } catch {
        // The token may already be invalid; clear the local session anyway.
      }
    }

    state.redirectingToLogin = false;
    state.token = null;
    state.admin = null;
    state.stats = null;
    state.licenses = [];
    state.auditLogs = [];
    state.settings = null;
    state.selectedLicense = null;
    state.view = "overview";
    if (window.location.hash !== "#overview") {
      window.history.replaceState(null, "", "#overview");
    }
    storageRemove(TOKEN_KEY);
    closeModal();
    closeDrawer();
    showLogin();
    toast("Signed out.", "success");
  }

  function showLogin() {
    dom.loginScreen.hidden = false;
    dom.appShell.hidden = true;
    dom.modalRoot.hidden = true;
    dom.drawerRoot.hidden = true;
    dom.loginError.hidden = true;
    dom.loginEmail.value = state.admin?.email || "";
    dom.loginPassword.value = "";
    window.setTimeout(() => dom.loginEmail.focus(), 30);
  }

  function showDashboard() {
    dom.loginScreen.hidden = true;
    dom.appShell.hidden = false;
    dom.adminName.textContent = state.admin?.displayName || "Administrator";
    dom.adminEmail.textContent = state.admin?.email || "";
    dom.adminAvatar.textContent = initials(state.admin?.displayName || state.admin?.email || "A");
    render();
  }

  async function loadDashboard() {
    const tasks = [loadStats(), loadLicenses(), loadAuditLogs()];
    if (state.view === "settings") tasks.push(loadSettings());
    await Promise.all(tasks);
    render();
  }

  async function loadStats() {
    state.stats = await api.get("/v1/admin/stats");
  }

  async function loadLicenses() {
    const params = new URLSearchParams({
      page: String(state.page),
      pageSize: String(state.pageSize),
      status: state.status,
    });
    if (state.search.trim()) params.set("search", state.search.trim());

    const data = await api.get(`/v1/admin/licenses?${params.toString()}`);
    state.licenses = data.licenses || [];
    state.licenseTotal = data.total || 0;
    state.page = data.page || 1;
    state.pageSize = data.pageSize || 20;
  }

  async function loadAuditLogs() {
    const params = new URLSearchParams({ limit: "100" });
    if (state.auditSearch.trim()) params.set("search", state.auditSearch.trim());
    const data = await api.get(`/v1/admin/audit-logs?${params.toString()}`);
    state.auditLogs = data.logs || [];
    state.auditTotal = data.total || 0;
  }

  async function loadSettings() {
    state.settings = await api.get("/v1/admin/settings");
  }

  async function refreshCurrentView() {
    dom.refreshButton.disabled = true;
    try {
      if (state.view === "overview") {
        await Promise.all([loadStats(), loadLicenses(), loadAuditLogs()]);
      } else if (state.view === "licenses") {
        await loadLicenses();
      } else if (state.view === "audit") {
        await loadAuditLogs();
      } else if (state.view === "settings") {
        await loadSettings();
      }
      render();
      toast("Dashboard refreshed.", "success");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      dom.refreshButton.disabled = false;
    }
  }

  function navigate(view) {
    if (!VIEWS.includes(view)) return;
    state.view = view;
    if (window.location.hash !== `#${view}`) {
      window.history.replaceState(null, "", `#${view}`);
    }
    render();

    if (view === "settings" && !state.settings) {
      loadSettings()
        .then(render)
        .catch((error) => toast(error.message, "error"));
    }
  }

  function parseHash() {
    return window.location.hash.replace(/^#/, "");
  }

  function render() {
    const meta = PAGE_META[state.view] || PAGE_META.overview;
    dom.pageTitle.textContent = meta.title;
    dom.pageSubtitle.textContent = meta.subtitle;

    document.querySelectorAll("[data-view]").forEach((item) => {
      item.classList.toggle("active", item.dataset.view === state.view);
    });

    if (state.view === "overview") renderOverview();
    else if (state.view === "licenses") renderLicenses();
    else if (state.view === "audit") renderAudit();
    else if (state.view === "settings") renderSettings();

    dom.viewRoot.classList.remove("view-root");
    void dom.viewRoot.offsetWidth;
    dom.viewRoot.classList.add("view-root");
  }

  function renderOverview() {
    if (!state.stats) {
      dom.viewRoot.innerHTML = loadingState("Loading your overview…");
      return;
    }

    const stats = state.stats;
    const recentLicenses = state.licenses.slice(0, 5);

    dom.viewRoot.innerHTML = `
      <section class="stats-grid">
        ${statCard({
          label: "Active licenses",
          value: formatNumber(stats.activeLicenses),
          sub: `of ${formatNumber(stats.totalLicenses)} total`,
          icon: icon("key"),
          tone: "",
        })}
        ${statCard({
          label: "Devices bound",
          value: formatNumber(stats.totalDevices),
          sub: `${formatNumber(stats.activeSessions)} active sessions`,
          icon: icon("device"),
          tone: "cyan",
        })}
        ${statCard({
          label: "Credits remaining",
          value: formatNumber(stats.creditsRemaining),
          sub: `${formatNumber(stats.creditsUsed30d)} used in 30 days`,
          icon: icon("credit"),
          tone: "violet",
        })}
        ${statCard({
          label: "AI requests · 30d",
          value: formatNumber(stats.requests30d),
          sub: `${formatNumber(stats.tokens30d)} tokens processed`,
          icon: icon("activity"),
          tone: "warning",
        })}
      </section>

      <section class="overview-grid">
        <div class="panel">
          <div class="panel-head">
            <div>
              <h2>Credit consumption</h2>
              <p>Credits used across all licenses over the last 14 days.</p>
            </div>
            <span class="badge badge-neutral">Last 14 days</span>
          </div>
          <div class="chart-wrap">
            ${renderUsageChart(stats.usageByDay || [])}
            <div class="chart-legend">
              <span><i class="legend-dot"></i> Credits used</span>
              <span>${formatNumber(stats.requestsToday)} requests today</span>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <div>
              <h2>Recent activity</h2>
              <p>Privileged actions from your audit trail.</p>
            </div>
            <button class="row-button" type="button" data-action="view-audit">View all</button>
          </div>
          <div class="activity-list">
            ${state.auditLogs.length
              ? state.auditLogs.slice(0, 6).map(renderActivityItem).join("")
              : emptyState("No activity yet", "Create a license or change a setting to see it here.")}
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Licenses</h2>
            <p>Your most recently issued licenses.</p>
          </div>
          <button class="row-button" type="button" data-action="view-all-licenses">View all</button>
        </div>
        <div class="table-wrap">
          ${
            recentLicenses.length
              ? `<table class="table">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Plan</th>
                      <th>Status</th>
                      <th>Devices</th>
                      <th>Credits</th>
                      <th>Expires</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    ${recentLicenses.map(renderOverviewLicenseRow).join("")}
                  </tbody>
                </table>`
              : emptyState("No licenses yet", "Create your first license to start issuing access.", `<button class="btn btn-primary btn-sm" type="button" data-action="new-license">${icon("plus")} New license</button>`)
          }
        </div>
      </section>
    `;
  }

  function statCard({ label, value, sub, iconName, tone }) {
    return `
      <article class="stat-card">
        <div class="stat-top">
          <span class="stat-label">${escapeHtml(label)}</span>
          <span class="stat-icon ${tone}">${icon(iconName)}</span>
        </div>
        <div class="stat-value">${escapeHtml(value)}</div>
        <div class="stat-sub">${sub}</div>
      </article>
    `;
  }

  function renderUsageChart(data) {
    if (!data.length) {
      return emptyState("No usage recorded", "AI requests and client usage will appear here.");
    }

    const max = Math.max(1, ...data.map((item) => Number(item.credits) || 0));
    return `
      <div class="chart">
        ${data
          .map((item) => {
            const credits = Number(item.credits) || 0;
            const height = Math.max(3, Math.round((credits / max) * 100));
            return `
              <div class="chart-col" title="${escapeAttr(formatDate(item.date))} · ${formatNumber(credits)} credits">
                <div class="chart-bar" style="height:${height}%"></div>
                <span class="chart-label">${escapeHtml(formatShortDate(item.date))}</span>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function renderActivityItem(log) {
    return `
      <div class="activity-item">
        <span class="activity-icon">${icon(activityIconName(log.action))}</span>
        <div class="activity-copy">
          <strong>${escapeHtml(humanAction(log.action))}</strong>
          <span>${escapeHtml(log.actorEmail || log.actorType || "System")}${log.entityId ? ` · ${escapeHtml(log.entityId)}` : ""}</span>
        </div>
        <span class="activity-time">${escapeHtml(formatRelative(log.createdAt))}</span>
      </div>
    `;
  }

  function renderOverviewLicenseRow(license) {
    return `
      <tr data-action="open-license" data-id="${escapeAttr(license.id)}">
        <td>
          <div class="customer">
            <strong>${escapeHtml(license.customerName)}</strong>
            <span>${escapeHtml(license.customerEmail || "No email")}</span>
          </div>
        </td>
        <td>${planBadge(license.plan)}</td>
        <td>${statusBadge(license.status, license.expired)}</td>
        <td class="num">${formatNumber(license.devicesUsed)} / ${formatNumber(license.maxDevices)}</td>
        <td>${creditsCell(license)}</td>
        <td>${expiresCell(license)}</td>
        <td class="actions"><button class="row-button" type="button" data-action="open-license" data-id="${escapeAttr(license.id)}">Manage</button></td>
      </tr>
    `;
  }

  function renderLicenses() {
    const totalPages = Math.max(1, Math.ceil(state.licenseTotal / state.pageSize));
    const start = state.licenseTotal === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
    const end = Math.min(state.page * state.pageSize, state.licenseTotal);

    dom.viewRoot.innerHTML = `
      <section class="panel">
        <div class="toolbar">
          <div class="search-box">
            ${icon("search")}
            <input type="search" placeholder="Search customer, email, or key…" value="${escapeAttr(state.search)}" data-search="licenses" aria-label="Search licenses" />
          </div>
          <div class="filter-tabs" role="tablist" aria-label="Filter licenses">
            ${filterTab("all", "All", state.status)}
            ${filterTab("active", "Active", state.status)}
            ${filterTab("suspended", "Suspended", state.status)}
            ${filterTab("revoked", "Revoked", state.status)}
          </div>
          <button class="btn btn-secondary btn-sm" type="button" data-action="export-licenses">
            ${icon("download")} Export
          </button>
        </div>

        <div class="table-wrap">
          ${
            state.licenses.length
              ? `<table class="table">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>License</th>
                      <th>Plan</th>
                      <th>Status</th>
                      <th>Devices</th>
                      <th>Credits</th>
                      <th>Expires</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    ${state.licenses.map(renderLicenseRow).join("")}
                  </tbody>
                </table>`
              : emptyState(
                  "No licenses found",
                  state.search || state.status !== "all"
                    ? "Try a different search or filter."
                    : "Create your first license to start issuing access.",
                  `<button class="btn btn-primary btn-sm" type="button" data-action="new-license">${icon("plus")} New license</button>`,
                )
          }
        </div>

        <div class="pagination">
          <span class="pagination-info">Showing ${formatNumber(start)}–${formatNumber(end)} of ${formatNumber(state.licenseTotal)}</span>
          <div class="pagination-controls">
            <button class="btn btn-secondary btn-sm" type="button" data-action="page-prev" ${state.page <= 1 ? "disabled" : ""}>Previous</button>
            <button class="btn btn-secondary btn-sm" type="button" data-action="page-next" ${state.page >= totalPages ? "disabled" : ""}>Next</button>
          </div>
        </div>
      </section>
    `;
  }

  function filterTab(value, label, active) {
    return `<button class="filter-tab ${active === value ? "active" : ""}" type="button" data-action="filter-licenses" data-status="${escapeAttr(value)}">${escapeHtml(label)}</button>`;
  }

  function renderLicenseRow(license) {
    return `
      <tr data-action="open-license" data-id="${escapeAttr(license.id)}">
        <td>
          <div class="customer">
            <strong>${escapeHtml(license.customerName)}</strong>
            <span>${escapeHtml(license.customerEmail || "No email")}</span>
          </div>
        </td>
        <td>
          <div class="mono">${escapeHtml(license.keyMasked)}</div>
          <div class="muted">${escapeHtml(license.product)}</div>
        </td>
        <td>${planBadge(license.plan)}</td>
        <td>${statusBadge(license.status, license.expired)}</td>
        <td class="num">${formatNumber(license.devicesUsed)} / ${formatNumber(license.maxDevices)}</td>
        <td>${creditsCell(license)}</td>
        <td>${expiresCell(license)}</td>
        <td class="actions"><button class="row-button" type="button" data-action="open-license" data-id="${escapeAttr(license.id)}">Manage</button></td>
      </tr>
    `;
  }

  function renderAudit() {
    dom.viewRoot.innerHTML = `
      <section class="panel">
        <div class="toolbar">
          <div class="search-box">
            ${icon("search")}
            <input type="search" placeholder="Search actor, action, or entity…" value="${escapeAttr(state.auditSearch)}" data-search="audit" aria-label="Search audit log" />
          </div>
          <button class="btn btn-secondary btn-sm" type="button" data-action="export-audit">
            ${icon("download")} Export CSV
          </button>
        </div>
        <div class="table-wrap">
          ${
            state.auditLogs.length
              ? `<table class="table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Actor</th>
                      <th>Action</th>
                      <th>Entity</th>
                      <th>Details</th>
                      <th>IP</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${state.auditLogs.map(renderAuditRow).join("")}
                  </tbody>
                </table>`
              : emptyState("No audit entries", "Admin actions and license events will appear here.")
          }
        </div>
        <div class="pagination">
          <span class="pagination-info">${formatNumber(state.auditTotal)} entries</span>
          <span class="pagination-info">Showing the latest 100</span>
        </div>
      </section>
    `;
  }

  function renderAuditRow(log) {
    return `
      <tr>
        <td class="muted">${escapeHtml(formatDate(log.createdAt))}</td>
        <td>${escapeHtml(log.actorEmail || log.actorType || "System")}</td>
        <td class="strong">${escapeHtml(humanAction(log.action))}</td>
        <td class="mono">${escapeHtml(log.entityType || "—")}${log.entityId ? ` · ${escapeHtml(log.entityId)}` : ""}</td>
        <td class="muted">${escapeHtml(formatAuditMetadata(log.metadata))}</td>
        <td class="mono">${escapeHtml(log.ip || "—")}</td>
      </tr>
    `;
  }

  function renderSettings() {
    if (!state.settings) {
      dom.viewRoot.innerHTML = loadingState("Loading settings…");
      return;
    }

    const settings = state.settings;
    const origin = window.location.origin;

    dom.viewRoot.innerHTML = `
      <div class="settings-grid">
        <div class="settings-stack">
          <section class="panel">
            <div class="panel-head">
              <div>
                <h2>Admin account</h2>
                <p>Your control-plane credentials.</p>
              </div>
              <span class="badge badge-active">Signed in</span>
            </div>
            <div class="panel-body">
              <div class="settings-list">
                <div class="settings-row">
                  <span class="settings-row-label">Name</span>
                  <span class="settings-row-value">${escapeHtml(state.admin?.displayName || "Administrator")}</span>
                </div>
                <div class="settings-row">
                  <span class="settings-row-label">Email</span>
                  <span class="settings-row-value">${escapeHtml(state.admin?.email || "")}</span>
                </div>
                <div class="settings-row">
                  <span class="settings-row-label">Session expires</span>
                  <span class="settings-row-value">${escapeHtml(formatDate(state.admin?.expiresAt))}</span>
                </div>
              </div>

              <form data-form="change-password" style="margin-top:18px">
                <div class="field-row">
                  <label class="field">
                    <span>Current password</span>
                    <input type="password" name="currentPassword" autocomplete="current-password" required minlength="8" />
                  </label>
                  <label class="field">
                    <span>New password</span>
                    <input type="password" name="newPassword" autocomplete="new-password" required minlength="12" />
                  </label>
                </div>
                <label class="field">
                  <span>Confirm new password</span>
                  <input type="password" name="confirmPassword" autocomplete="new-password" required minlength="12" />
                </label>
                <div class="form-error" data-form-error hidden></div>
                <button class="btn btn-secondary" type="submit">Change password</button>
              </form>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <div>
                <h2>Security model</h2>
                <p>What this server enforces, and what it cannot.</p>
              </div>
              <span class="badge badge-neutral">Read-only</span>
            </div>
            <div class="panel-body">
              <div class="settings-list">
                <div class="settings-row">
                  <span class="settings-row-label">License keys</span>
                  <span class="settings-row-value">SHA-256 hashed at rest</span>
                </div>
                <div class="settings-row">
                  <span class="settings-row-label">Device IDs</span>
                  <span class="settings-row-value">HMAC-SHA256 with server pepper</span>
                </div>
                <div class="settings-row">
                  <span class="settings-row-label">Session tokens</span>
                  <span class="settings-row-value">Opaque, hashed, expiring</span>
                </div>
                <div class="settings-row">
                  <span class="settings-row-label">AI provider key</span>
                  <span class="settings-row-value">Server-side only</span>
                </div>
              </div>
              <div class="integration-note">
                ${icon("shield")}
                <span>The client is untrusted by design. All license, device, credit, and rate-limit checks happen here. A modified client cannot mint licenses or use your AI key.</span>
              </div>
            </div>
          </section>
        </div>

        <div class="settings-stack">
          <section class="panel">
            <div class="panel-head">
              <div>
                <h2>Server</h2>
                <p>Deployment and provider configuration.</p>
              </div>
              <span class="badge ${settings.ai.configured ? "badge-active" : "badge-suspended"}">${settings.ai.configured ? "AI ready" : "AI not configured"}</span>
            </div>
            <div class="panel-body">
              <div class="settings-list">
                <div class="settings-row">
                  <span class="settings-row-label">Version</span>
                  <span class="settings-row-value">${escapeHtml(settings.version)}</span>
                </div>
                <div class="settings-row">
                  <span class="settings-row-label">AI model</span>
                  <span class="settings-row-value">${escapeHtml(settings.ai.model)}</span>
                </div>
                <div class="settings-row">
                  <span class="settings-row-label">AI endpoint</span>
                  <span class="settings-row-value">${escapeHtml(settings.ai.baseUrl)}</span>
                </div>
                <div class="settings-row">
                  <span class="settings-row-label">Credit formula</span>
                  <span class="settings-row-value">${formatNumber(settings.ai.creditsPerRequest)} + 1 per ${formatNumber(settings.ai.tokensPerCredit)} tokens</span>
                </div>
                <div class="settings-row">
                  <span class="settings-row-label">License session</span>
                  <span class="settings-row-value">${formatNumber(settings.security.sessionHours)} hours</span>
                </div>
                <div class="settings-row">
                  <span class="settings-row-label">Admin session</span>
                  <span class="settings-row-value">${formatNumber(settings.security.adminSessionHours)} hours</span>
                </div>
                <div class="settings-row">
                  <span class="settings-row-label">HWID pepper</span>
                  <span class="settings-row-value">${settings.security.hwidPepperConfigured ? "Configured" : "Auto-generated on first activation"}</span>
                </div>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <div>
                <h2>Client integration</h2>
                <p>Activate a device and request an AI completion.</p>
              </div>
              <button class="btn btn-secondary btn-sm" type="button" data-action="copy-integration">${icon("copy")} Copy</button>
            </div>
            <div class="panel-body">
              <pre class="code-block"><code id="integration-code">curl -X POST ${escapeHtml(origin)}/v1/licenses/activate \\
  -H "Content-Type: application/json" \\
  -d '{"licenseKey":"GG-XXXX-XXXX-XXXX-XXXX","hwid":"YOUR_DEVICE_ID","deviceName":"My PC"}'

# Use the returned sessionToken as a Bearer token:
curl ${escapeHtml(origin)}/v1/license \\
  -H "Authorization: Bearer YOUR_SESSION_TOKEN"</code></pre>
              <div class="integration-note">
                ${icon("info")}
                <span>The AI proxy is text-only by design. It does not accept screenshots or images. Keep the AI provider key in this server's environment.</span>
              </div>
            </div>
          </section>
        </div>
      </div>
    `;
  }

  function openCreateLicenseModal() {
    showModal(`
      <div class="modal-head">
        <div>
          <h2>New license</h2>
          <p>Issue a device-bound license with a credit allowance.</p>
        </div>
        <button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">${icon("x")}</button>
      </div>
      <div class="modal-body">
        <form data-form="create-license">
          <div class="field-row">
            <label class="field">
              <span>Customer name</span>
              <input name="customerName" required maxlength="120" placeholder="Aarav Sharma" />
            </label>
            <label class="field">
              <span>Customer email</span>
              <input name="customerEmail" type="email" maxlength="254" placeholder="aarav@example.com" />
            </label>
          </div>
          <div class="field-row">
            <label class="field">
              <span>Product</span>
              <input name="product" required maxlength="80" value="GhostGate Client" />
            </label>
            <label class="field">
              <span>Plan</span>
              <select name="plan">
                <option value="starter">Starter</option>
                <option value="standard" selected>Standard</option>
                <option value="pro">Pro</option>
                <option value="enterprise">Enterprise</option>
              </select>
            </label>
          </div>
          <div class="field-row">
            <label class="field">
              <span>Devices allowed</span>
              <input name="maxDevices" type="number" min="1" max="100" value="1" required />
            </label>
            <label class="field">
              <span>Credits</span>
              <input name="credits" type="number" min="1" max="1000000" value="100" required />
            </label>
          </div>
          <div class="field-row">
            <label class="field">
              <span>Max tokens / request</span>
              <input name="maxTokensPerRequest" type="number" min="256" max="32768" step="256" value="4096" required />
            </label>
            <label class="field">
              <span>Requests / minute</span>
              <input name="rateLimitPerMinute" type="number" min="1" max="600" value="20" required />
            </label>
          </div>
          <div class="field-row">
            <label class="field">
              <span>Expires in (days)</span>
              <input name="expiresInDays" type="number" min="1" max="3650" value="30" required />
            </label>
            <label class="field">
              <span>Notes</span>
              <input name="notes" maxlength="2000" placeholder="Optional internal note" />
            </label>
          </div>
          <div class="form-error" data-form-error hidden></div>
          <div class="modal-actions">
            <button class="btn btn-ghost" type="button" data-action="close-modal">Cancel</button>
            <button class="btn btn-primary" type="submit">${icon("plus")} Create license</button>
          </div>
        </form>
      </div>
    `);
  }

  async function handleCreateLicense(form) {
    const formData = new FormData(form);
    const payload = {
      customerName: String(formData.get("customerName") || "").trim(),
      customerEmail: String(formData.get("customerEmail") || "").trim(),
      product: String(formData.get("product") || "").trim(),
      plan: String(formData.get("plan") || "standard"),
      maxDevices: Number(formData.get("maxDevices")),
      credits: Number(formData.get("credits")),
      maxTokensPerRequest: Number(formData.get("maxTokensPerRequest")),
      rateLimitPerMinute: Number(formData.get("rateLimitPerMinute")),
      expiresInDays: Number(formData.get("expiresInDays")),
      notes: String(formData.get("notes") || "").trim(),
    };

    const submit = form.querySelector('button[type="submit"]');
    setFormBusy(submit, true, "Creating…");

    try {
      const data = await api.post("/v1/admin/licenses", payload);
      showLicenseKeyModal(data.licenseKey, data.license);
      await Promise.all([loadStats(), loadLicenses(), loadAuditLogs()]);
      render();
      toast("License created.", "success");
    } catch (error) {
      showFormError(form, error.message);
    } finally {
      setFormBusy(submit, false, "Create license");
    }
  }

  function showLicenseKeyModal(licenseKey, license) {
    showModal(`
      <div class="modal-head">
        <div>
          <h2>License created</h2>
          <p>${escapeHtml(license.customerName)} · ${escapeHtml(license.plan)}</p>
        </div>
        <button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">${icon("x")}</button>
      </div>
      <div class="modal-body">
        <div class="form-success">The license is active and ready to use.</div>
        <div class="license-key-box">
          <code>${escapeHtml(licenseKey)}</code>
          <button class="btn btn-secondary btn-sm" type="button" data-action="copy-key" data-copy="${escapeAttr(licenseKey)}">${icon("copy")} Copy</button>
        </div>
        <div class="warning-box">
          ${icon("alert")}
          <span>This is the only time the full license key is shown. Store it securely. The server keeps only a hash.</span>
        </div>
        <div class="detail-grid" style="margin-top:16px">
          <div class="detail-item">
            <div class="detail-label">Credits</div>
            <div class="detail-value">${formatNumber(license.creditsTotal)}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Devices</div>
            <div class="detail-value">${formatNumber(license.maxDevices)}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Expires</div>
            <div class="detail-value">${escapeHtml(formatDate(license.expiresAt))}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Max tokens / request</div>
            <div class="detail-value">${formatNumber(license.maxTokensPerRequest)}</div>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-primary" type="button" data-action="close-modal">Done</button>
        </div>
      </div>
    `);
  }

  async function openLicenseDrawer(id) {
    try {
      const data = await api.get(`/v1/admin/licenses/${encodeURIComponent(id)}`);
      state.selectedLicense = data;
      renderLicenseDrawer(data);
      dom.drawerRoot.hidden = false;
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function renderLicenseDrawer(data) {
    const license = data.license;
    const devices = data.devices || [];
    const usage = data.usage || [];
    const auditLogs = data.auditLogs || [];
    const activeDevices = devices.filter((device) => !device.revokedAt);

    dom.drawerRoot.innerHTML = `
      <div class="drawer-backdrop" data-action="close-drawer"></div>
      <aside class="drawer" role="dialog" aria-modal="true" aria-label="License details">
        <div class="drawer-head">
          <div>
            <h2>${escapeHtml(license.customerName)}</h2>
            <p>${escapeHtml(license.keyMasked)} · ${escapeHtml(license.product)}</p>
          </div>
          <button class="icon-btn" type="button" data-action="close-drawer" aria-label="Close">${icon("x")}</button>
        </div>
        <div class="drawer-body">
          <div class="detail-grid">
            <div class="detail-item">
              <div class="detail-label">Status</div>
              <div class="detail-value">${statusBadge(license.status, license.expired)}</div>
            </div>
            <div class="detail-item">
              <div class="detail-label">Plan</div>
              <div class="detail-value">${planBadge(license.plan)}</div>
            </div>
            <div class="detail-item">
              <div class="detail-label">Customer email</div>
              <div class="detail-value">${escapeHtml(license.customerEmail || "No email")}</div>
            </div>
            <div class="detail-item">
              <div class="detail-label">License ID</div>
              <div class="detail-value mono">${escapeHtml(license.id)}</div>
            </div>
            <div class="detail-item">
              <div class="detail-label">Devices</div>
              <div class="detail-value">${formatNumber(activeDevices.length)} active / ${formatNumber(license.maxDevices)} allowed</div>
            </div>
            <div class="detail-item">
              <div class="detail-label">Expires</div>
              <div class="detail-value">${escapeHtml(formatDate(license.expiresAt))}</div>
            </div>
            <div class="detail-item">
              <div class="detail-label">Max tokens / request</div>
              <div class="detail-value">${formatNumber(license.maxTokensPerRequest)}</div>
            </div>
            <div class="detail-item">
              <div class="detail-label">Rate limit</div>
              <div class="detail-value">${formatNumber(license.rateLimitPerMinute)} requests / min</div>
            </div>
          </div>

          <div class="drawer-section">
            <div class="drawer-section-title">
              <h3>Credits</h3>
              <span>${formatNumber(license.creditsRemaining)} remaining</span>
            </div>
            <div class="credits-line">
              <strong>${formatNumber(license.creditsRemaining)} / ${formatNumber(license.creditsTotal)}</strong>
              <span>${formatNumber(license.creditsUsed)} used</span>
            </div>
            <div class="progress ${license.creditsRemaining === 0 ? "danger" : license.creditsRemaining / Math.max(1, license.creditsTotal) <= 0.2 ? "warning" : ""}">
              <span style="width:${Math.max(0, Math.min(100, Math.round((license.creditsRemaining / Math.max(1, license.creditsTotal)) * 100)))}%"></span>
            </div>
            <form data-form="add-credits" data-id="${escapeAttr(license.id)}" style="margin-top:12px">
              <div class="field-row">
                <label class="field">
                  <span>Add credits</span>
                  <input name="amount" type="number" min="1" max="1000000" value="100" required />
                </label>
                <label class="field">
                  <span>Reason</span>
                  <input name="reason" maxlength="200" placeholder="Optional" />
                </label>
              </div>
              <button class="btn btn-secondary btn-sm" type="submit">${icon("plus")} Add credits</button>
            </form>
          </div>

          <div class="drawer-section">
            <div class="drawer-section-title">
              <h3>Devices</h3>
              <span>${formatNumber(activeDevices.length)} active</span>
            </div>
            <div class="device-list">
              ${
                devices.length
                  ? devices
                      .map(
                        (device) => `
                          <div class="device-item">
                            <span class="device-icon">${icon("device")}</span>
                            <div class="device-copy">
                              <strong>${escapeHtml(device.deviceName || "Unnamed device")}</strong>
                              <span>${escapeHtml(device.hwidDisplay)} · seen ${escapeHtml(formatRelative(device.lastSeenAt))}</span>
                            </div>
                            <div class="device-status">
                              ${
                                device.revokedAt
                                  ? `<span class="badge badge-revoked">Unbound</span>`
                                  : `<button class="row-button" type="button" data-action="unbind-device" data-id="${escapeAttr(device.id)}">Unbind</button>`
                              }
                            </div>
                          </div>
                        `,
                      )
                      .join("")
                  : emptyState("No devices bound", "The first activation will bind this license to a device.")
              }
            </div>
          </div>

          <div class="drawer-section">
            <div class="drawer-section-title">
              <h3>Recent usage</h3>
              <span>${formatNumber(usage.length)} events</span>
            </div>
            ${
              usage.length
                ? `<div class="table-wrap"><table class="mini-table">
                    <thead><tr><th>Time</th><th>Kind</th><th>Credits</th><th>Tokens</th><th>Model</th></tr></thead>
                    <tbody>
                      ${usage
                        .slice(0, 10)
                        .map(
                          (event) => `
                            <tr>
                              <td>${escapeHtml(formatRelative(event.createdAt))}</td>
                              <td>${escapeHtml(event.kind)}</td>
                              <td>${formatNumber(event.creditsUsed)}</td>
                              <td>${formatNumber(event.tokensIn)} / ${formatNumber(event.tokensOut)}</td>
                              <td>${escapeHtml(event.model || "—")}</td>
                            </tr>
                          `,
                        )
                        .join("")}
                    </tbody>
                  </table></div>`
                : emptyState("No usage yet", "AI requests and client usage will appear here.")
            }
          </div>

          <div class="drawer-section">
            <div class="drawer-section-title">
              <h3>License audit</h3>
              <span>${formatNumber(auditLogs.length)} events</span>
            </div>
            ${
              auditLogs.length
                ? `<div class="table-wrap"><table class="mini-table">
                    <thead><tr><th>Time</th><th>Action</th><th>Actor</th><th>Details</th></tr></thead>
                    <tbody>
                      ${auditLogs
                        .slice(0, 10)
                        .map(
                          (log) => `
                            <tr>
                              <td>${escapeHtml(formatRelative(log.createdAt))}</td>
                              <td>${escapeHtml(humanAction(log.action))}</td>
                              <td>${escapeHtml(log.actorEmail || log.actorType || "System")}</td>
                              <td>${escapeHtml(formatAuditMetadata(log.metadata))}</td>
                            </tr>
                          `,
                        )
                        .join("")}
                    </tbody>
                  </table></div>`
                : emptyState("No audit events", "Changes to this license will appear here.")
            }
          </div>

          <div class="drawer-section">
            <div class="drawer-section-title">
              <h3>Edit limits</h3>
              <span>Changes apply immediately</span>
            </div>
            <form data-form="update-license" data-id="${escapeAttr(license.id)}">
              <div class="field-row">
                <label class="field">
                  <span>Devices allowed</span>
                  <input name="maxDevices" type="number" min="1" max="100" value="${escapeAttr(license.maxDevices)}" required />
                </label>
                <label class="field">
                  <span>Max tokens / request</span>
                  <input name="maxTokensPerRequest" type="number" min="256" max="32768" step="256" value="${escapeAttr(license.maxTokensPerRequest)}" required />
                </label>
              </div>
              <div class="field-row">
                <label class="field">
                  <span>Requests / minute</span>
                  <input name="rateLimitPerMinute" type="number" min="1" max="600" value="${escapeAttr(license.rateLimitPerMinute)}" required />
                </label>
                <label class="field">
                  <span>Expires at</span>
                  <input name="expiresAt" type="datetime-local" value="${escapeAttr(toDateTimeLocal(license.expiresAt))}" />
                </label>
              </div>
              <label class="field">
                <span>Notes</span>
                <textarea name="notes" maxlength="2000" placeholder="Internal notes">${escapeHtml(license.notes || "")}</textarea>
              </label>
              <button class="btn btn-secondary btn-sm" type="submit">Save changes</button>
            </form>
          </div>

          <div class="drawer-section">
            <div class="drawer-section-title">
              <h3>Status</h3>
              <span>Revocation is immediate</span>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${
                license.status === "active"
                  ? `<button class="btn btn-warning btn-sm" type="button" data-action="set-status" data-status="suspended">Suspend</button>`
                  : `<button class="btn btn-secondary btn-sm" type="button" data-action="set-status" data-status="active">Activate</button>`
              }
              ${
                license.status !== "revoked"
                  ? `<button class="btn btn-danger btn-sm" type="button" data-action="set-status" data-status="revoked">Revoke</button>`
                  : ""
              }
            </div>
          </div>

          <div class="danger-zone">
            <h3>Full key not recoverable</h3>
            <p>The server stores only a SHA-256 hash of the license key. The full key was shown once when the license was created.</p>
          </div>
        </div>
      </aside>
    `;
  }

  async function handleAddCredits(form) {
    const id = form.dataset.id;
    const formData = new FormData(form);
    const amount = Number(formData.get("amount"));
    const reason = String(formData.get("reason") || "").trim();
    const submit = form.querySelector('button[type="submit"]');
    setFormBusy(submit, true, "Adding…");

    try {
      await api.post(`/v1/admin/licenses/${encodeURIComponent(id)}/credits`, { amount, reason });
      await refreshLicenseDrawer(id);
      await Promise.all([loadStats(), loadLicenses()]);
      render();
      toast("Credits added.", "success");
    } catch (error) {
      showFormError(form, error.message);
    } finally {
      setFormBusy(submit, false, "Add credits");
    }
  }

  async function handleUpdateLicense(form) {
    const id = form.dataset.id;
    const formData = new FormData(form);
    const expiresAtRaw = String(formData.get("expiresAt") || "").trim();
    const payload = {
      maxDevices: Number(formData.get("maxDevices")),
      maxTokensPerRequest: Number(formData.get("maxTokensPerRequest")),
      rateLimitPerMinute: Number(formData.get("rateLimitPerMinute")),
      expiresAt: expiresAtRaw ? new Date(expiresAtRaw).toISOString() : null,
      notes: String(formData.get("notes") || "").trim(),
    };

    const submit = form.querySelector('button[type="submit"]');
    setFormBusy(submit, true, "Saving…");

    try {
      await api.patch(`/v1/admin/licenses/${encodeURIComponent(id)}`, payload);
      await refreshLicenseDrawer(id);
      await Promise.all([loadStats(), loadLicenses()]);
      render();
      toast("License updated.", "success");
    } catch (error) {
      showFormError(form, error.message);
    } finally {
      setFormBusy(submit, false, "Save changes");
    }
  }

  async function refreshLicenseDrawer(id) {
    const data = await api.get(`/v1/admin/licenses/${encodeURIComponent(id)}`);
    state.selectedLicense = data;
    renderLicenseDrawer(data);
  }

  async function handleSetStatus(status) {
    const id = state.selectedLicense?.license?.id;
    if (!id) return;

    if (status === "revoked") {
      const confirmed = window.confirm(
        "Revoke this license? All active sessions will be invalidated immediately.",
      );
      if (!confirmed) return;
    }

    try {
      await api.post(`/v1/admin/licenses/${encodeURIComponent(id)}/status`, { status });
      await refreshLicenseDrawer(id);
      await Promise.all([loadStats(), loadLicenses(), loadAuditLogs()]);
      render();
      toast(`License ${status}.`, status === "revoked" ? "warning" : "success");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function handleUnbindDevice(deviceId) {
    const id = state.selectedLicense?.license?.id;
    if (!id) return;

    const confirmed = window.confirm(
      "Unbind this device? Its sessions will be revoked and the seat will be freed.",
    );
    if (!confirmed) return;

    try {
      await api.delete(
        `/v1/admin/licenses/${encodeURIComponent(id)}/devices/${encodeURIComponent(deviceId)}`,
      );
      await refreshLicenseDrawer(id);
      await Promise.all([loadStats(), loadLicenses(), loadAuditLogs()]);
      render();
      toast("Device unbound.", "success");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function handleChangePassword(form) {
    const formData = new FormData(form);
    const currentPassword = String(formData.get("currentPassword") || "");
    const newPassword = String(formData.get("newPassword") || "");
    const confirmPassword = String(formData.get("confirmPassword") || "");
    const submit = form.querySelector('button[type="submit"]');

    if (newPassword !== confirmPassword) {
      showFormError(form, "New passwords do not match.");
      return;
    }

    setFormBusy(submit, true, "Changing…");

    try {
      await api.post("/v1/admin/password", { currentPassword, newPassword });
      toast("Password changed. Sign in again.", "success");
      await handleLogout({ skipApi: true });
    } catch (error) {
      showFormError(form, error.message);
    } finally {
      setFormBusy(submit, false, "Change password");
    }
  }

  function handleDocumentClick(event) {
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) {
      navigate(viewButton.dataset.view);
      return;
    }

    const actionElement = event.target.closest("[data-action]");
    if (!actionElement) return;

    const action = actionElement.dataset.action;
    if (action === "close-modal") closeModal();
    else if (action === "close-drawer") closeDrawer();
    else if (action === "open-license") openLicenseDrawer(actionElement.dataset.id);
    else if (action === "view-all-licenses") navigate("licenses");
    else if (action === "view-audit") navigate("audit");
    else if (action === "new-license") openCreateLicenseModal();
    else if (action === "filter-licenses") {
      state.status = actionElement.dataset.status || "all";
      state.page = 1;
      loadLicenses()
        .then(render)
        .catch((error) => toast(error.message, "error"));
    } else if (action === "page-prev") {
      if (state.page > 1) {
        state.page -= 1;
        loadLicenses()
          .then(render)
          .catch((error) => toast(error.message, "error"));
      }
    } else if (action === "page-next") {
      const totalPages = Math.max(1, Math.ceil(state.licenseTotal / state.pageSize));
      if (state.page < totalPages) {
        state.page += 1;
        loadLicenses()
          .then(render)
          .catch((error) => toast(error.message, "error"));
      }
    } else if (action === "set-status") {
      handleSetStatus(actionElement.dataset.status);
    } else if (action === "unbind-device") {
      handleUnbindDevice(actionElement.dataset.id);
    } else if (action === "copy-key") {
      copyText(actionElement.dataset.copy || "");
    } else if (action === "copy-integration") {
      const code = document.getElementById("integration-code");
      copyText(code ? code.textContent : "");
    } else if (action === "export-licenses") {
      exportLicensesCsv();
    } else if (action === "export-audit") {
      exportAuditCsv();
    }
  }

  function handleDocumentSubmit(event) {
    const form = event.target.closest("[data-form]");
    if (!form) return;
    event.preventDefault();

    const formType = form.dataset.form;
    if (formType === "create-license") handleCreateLicense(form);
    else if (formType === "add-credits") handleAddCredits(form);
    else if (formType === "update-license") handleUpdateLicense(form);
    else if (formType === "change-password") handleChangePassword(form);
  }

  function handleDocumentInput(event) {
    const target = event.target;
    if (target.matches('[data-search="licenses"]')) {
      state.search = target.value;
      state.page = 1;
      debouncedLoadLicenses();
    } else if (target.matches('[data-search="audit"]')) {
      state.auditSearch = target.value;
      debouncedLoadAuditLogs();
    }
  }

  function focusSearch(name) {
    const input = document.querySelector(`[data-search="${name}"]`);
    if (!input) return;
    input.focus();
    const value = input.value;
    input.value = "";
    input.value = value;
  }

  function handleDocumentChange(event) {
    const target = event.target;
    if (target.matches("[data-page-size]")) {
      state.pageSize = Number(target.value) || 20;
      state.page = 1;
      loadLicenses()
        .then(render)
        .catch((error) => toast(error.message, "error"));
    }
  }

  function handleDocumentKeydown(event) {
    if (event.key === "Escape") {
      if (!dom.modalRoot.hidden) closeModal();
      else if (!dom.drawerRoot.hidden) closeDrawer();
    }
  }

  function showModal(content) {
    dom.modalRoot.innerHTML = `
      <div class="modal-backdrop" data-action="close-modal"></div>
      <div class="modal-card" role="dialog" aria-modal="true">${content}</div>
    `;
    dom.modalRoot.hidden = false;
    window.setTimeout(() => {
      const focusable = dom.modalRoot.querySelector("input, select, textarea, button");
      if (focusable) focusable.focus();
    }, 30);
  }

  function closeModal() {
    dom.modalRoot.hidden = true;
    dom.modalRoot.innerHTML = "";
  }

  function closeDrawer() {
    dom.drawerRoot.hidden = true;
    dom.drawerRoot.innerHTML = "";
    state.selectedLicense = null;
  }

  function setFormBusy(button, busy, label) {
    if (!button) return;
    button.disabled = busy;
    if (busy) {
      button.dataset.originalLabel = button.innerHTML;
      button.textContent = label;
    } else if (button.dataset.originalLabel) {
      button.innerHTML = button.dataset.originalLabel;
      delete button.dataset.originalLabel;
    }
  }

  function showFormError(form, message) {
    const error = form.querySelector("[data-form-error]");
    if (error) {
      error.textContent = message;
      error.hidden = false;
    } else {
      toast(message, "error");
    }
  }

  function toast(message, type = "success") {
    const item = document.createElement("div");
    item.className = `toast ${type}`;
    item.innerHTML = `${icon(type === "error" ? "alert" : type === "warning" ? "alert" : "check")}<span>${escapeHtml(message)}</span>`;
    dom.toastRoot.appendChild(item);
    window.setTimeout(() => item.remove(), 3600);
  }

  async function copyText(text) {
    if (!text) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      toast("Copied to clipboard.", "success");
    } catch {
      toast("Could not copy. Select the text manually.", "error");
    }
  }

  async function exportLicensesCsv() {
    try {
      const response = await fetch("/v1/admin/export", {
        headers: { Authorization: `Bearer ${state.token}` },
      });
      if (!response.ok) throw new Error(`Export failed (${response.status})`);
      const blob = await response.blob();
      downloadBlob(blob, "ghostgate-licenses.csv");
      toast("License export downloaded.", "success");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function exportAuditCsv() {
    const headers = ["created_at", "actor_type", "actor_email", "action", "entity_type", "entity_id", "metadata", "ip"];
    const rows = state.auditLogs.map((log) =>
      [
        log.createdAt,
        log.actorType,
        log.actorEmail,
        log.action,
        log.entityType,
        log.entityId,
        log.metadata ? JSON.stringify(log.metadata) : "",
        log.ip,
      ]
        .map(csvCell)
        .join(","),
    );
    const blob = new Blob([`\uFEFF${[headers.join(","), ...rows].join("\r\n")}`], {
      type: "text/csv;charset=utf-8",
    });
    downloadBlob(blob, "ghostgate-audit-log.csv");
    toast("Audit export downloaded.", "success");
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function csvCell(value) {
    if (value === null || value === undefined) return '""';
    return `"${String(value).replace(/"/g, '""')}"`;
  }

  function debounce(fn, delay) {
    let timer = null;
    return function debounced(...args) {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fn(...args), delay);
    };
  }

  const debouncedLoadLicenses = debounce(() => {
    loadLicenses()
      .then(() => {
        render();
        focusSearch("licenses");
      })
      .catch((error) => toast(error.message, "error"));
  }, 260);

  const debouncedLoadAuditLogs = debounce(() => {
    loadAuditLogs()
      .then(() => {
        render();
        focusSearch("audit");
      })
      .catch((error) => toast(error.message, "error"));
  }, 260);

  function statusBadge(status, expired) {
    if (expired) return `<span class="badge badge-expired">Expired</span>`;
    const cls =
      status === "active"
        ? "badge-active"
        : status === "suspended"
          ? "badge-suspended"
          : "badge-revoked";
    return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
  }

  function planBadge(plan) {
    return `<span class="badge badge-plan">${escapeHtml(plan)}</span>`;
  }

  function creditsCell(license) {
    const total = Math.max(1, Number(license.creditsTotal) || 0);
    const remaining = Math.max(0, Number(license.creditsRemaining) || 0);
    const pct = Math.round((remaining / total) * 100);
    const cls = remaining === 0 ? "danger" : pct <= 20 ? "warning" : "";
    return `
      <div class="credits-cell">
        <div class="credits-line">
          <strong>${formatNumber(remaining)}</strong>
          <span>/ ${formatNumber(license.creditsTotal)}</span>
        </div>
        <div class="progress ${cls}"><span style="width:${pct}%"></span></div>
      </div>
    `;
  }

  function expiresCell(license) {
    if (!license.expiresAt) return `<span class="muted">Never</span>`;
    if (license.expired) return `<span class="badge badge-expired">Expired</span>`;
    if (license.expiringSoon) return `<span class="badge badge-suspended">Soon</span>`;
    return `<span class="muted">${escapeHtml(formatDate(license.expiresAt))}</span>`;
  }

  function emptyState(title, description, action = "") {
    return `
      <div class="empty-state">
        <span class="empty-icon">${icon("shield")}</span>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(description)}</p>
        ${action}
      </div>
    `;
  }

  function loadingState(message) {
    return `<div class="empty-state"><span class="empty-icon">${icon("refresh")}</span><h3>${escapeHtml(message)}</h3></div>`;
  }

  function humanAction(action) {
    const labels = {
      LICENSE_CREATED: "License created",
      LICENSE_UPDATED: "License updated",
      CREDITS_ADDED: "Credits added",
      LICENSE_STATUS_CHANGED: "Status changed",
      DEVICE_UNBOUND: "Device unbound",
      DEVICE_RELEASED: "Device released",
      LICENSE_ACTIVATED: "License activated",
    };
    return labels[action] || action || "Event";
  }

  function activityIconName(action) {
    if (action === "LICENSE_CREATED") return "plus";
    if (action === "CREDITS_ADDED") return "credit";
    if (action === "DEVICE_UNBOUND" || action === "DEVICE_RELEASED") return "device";
    if (action === "LICENSE_ACTIVATED") return "key";
    if (action === "LICENSE_STATUS_CHANGED") return "alert";
    return "activity";
  }

  function formatAuditMetadata(metadata) {
    if (!metadata || typeof metadata !== "object") return "No metadata";
    const entries = Object.entries(metadata).slice(0, 4);
    if (!entries.length) return "No metadata";
    return entries
      .map(([key, value]) => {
        const rendered =
          value === null || value === undefined
            ? "—"
            : typeof value === "object"
              ? JSON.stringify(value)
              : String(value);
        return `${key}: ${rendered.length > 40 ? `${rendered.slice(0, 40)}…` : rendered}`;
      })
      .join(" · ");
  }

  function formatNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "0";
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(number);
  }

  function formatDate(value) {
    if (!value) return "Never";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }

  function formatShortDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
  }

  function formatRelative(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    const diff = Date.now() - date.getTime();
    const future = diff < 0;
    const abs = Math.abs(diff);
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;

    let text;
    if (abs < minute) text = "just now";
    else if (abs < hour) text = `${Math.round(abs / minute)}m`;
    else if (abs < day) text = `${Math.round(abs / hour)}h`;
    else if (abs < 30 * day) text = `${Math.round(abs / day)}d`;
    else text = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);

    if (text === "just now") return text;
    return future ? `in ${text}` : `${text} ago`;
  }

  function toDateTimeLocal(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function initials(value) {
    const parts = String(value || "A").trim().split(/\s+/).slice(0, 2);
    return parts.map((part) => part[0] || "").join("").toUpperCase() || "A";
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => {
      const entities = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      };
      return entities[character];
    });
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function icon(name) {
    const icons = {
      activity: '<path d="M3 10h3l2-5 3 10 2-5h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
      alert: '<path d="M10 3 18 17H2L10 3Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 8v4m0 2.5v.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
      check: '<path d="m4 10 4 4 8-9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
      copy: '<rect x="7" y="7" width="9" height="10" rx="1.6" stroke="currentColor" stroke-width="1.5"/><path d="M13 7V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v9A1.5 1.5 0 0 0 4.5 15H7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
      credit: '<rect x="2.5" y="5" width="15" height="10" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 8.5h15M6 12h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
      device: '<rect x="3" y="4" width="14" height="10" rx="1.6" stroke="currentColor" stroke-width="1.5"/><path d="M7 17h6M10 14v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
      download: '<path d="M10 3v9m0 0 3.5-3.5M10 12 6.5 8.5M3.5 14v2.5h13V14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
      info: '<circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.5"/><path d="M10 9v4m0-6.5v.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
      key: '<circle cx="7" cy="7" r="3.2" stroke="currentColor" stroke-width="1.5"/><path d="m9.5 9.5 6 6m-2-2 1.5-1.5m-4 0L12.5 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
      plus: '<path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
      refresh: '<path d="M15.5 7.5A6 6 0 1 0 16 11M15.5 3.5v4h-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
      search: '<circle cx="9" cy="9" r="5.5" stroke="currentColor" stroke-width="1.5"/><path d="m13 13 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
      shield: '<path d="M10 2.5 16 5v4.6c0 3.5-2.4 6-6 7.1-3.6-1.1-6-3.6-6-7.1V5l6-2.5Z" stroke="currentColor" stroke-width="1.5"/><path d="m7.3 9.8 1.8 1.8 3.6-3.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
      x: '<path d="m5 5 10 10M15 5 5 15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    };
    return `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">${icons[name] || icons.activity}</svg>`;
  }

  init();
})();

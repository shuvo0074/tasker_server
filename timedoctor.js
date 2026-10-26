/**
 * Time Doctor 2 API proxy (https://api2.timedoctor.com, docs: https://timedoctor.redoc.ly/)
 */

function tdBase() {
  return (process.env.TIMEDOCTOR_API_BASE || "https://api2.timedoctor.com").replace(
    /\/$/,
    ""
  );
}

function tdSession(req) {
  return req.session?.timedoctor || null;
}

const TD_ERROR_HINTS = {
  totpNeeded:
    "Two-factor authentication is on: enter the current 6-digit code from your authenticator app in the 2FA field.",
  invalidTotpCode: "That 2FA code was rejected. Wait for a fresh code and try again.",
  ssoRequiredCompany:
    "This workspace uses SSO. Password login via the API may be disabled — use a Time Doctor password if your admin allows it, or ask your admin.",
  ssoRequiredGroup:
    "Your team uses SSO-only login. The API may not accept a password for this account.",
  tooManyFailedLogin:
    "Too many failed sign-in attempts. Wait about 20 minutes before trying again.",
  missingRequired: "The API rejected the request (missing or invalid fields).",
};

function tdErrorMessage(data, statusText) {
  const code = data?.code || data?.error?.code || data?.data?.code;
  const hint = code && TD_ERROR_HINTS[code];
  const base =
    data?.message ||
    data?.error?.message ||
    (typeof data?.error === "string" ? data.error : null) ||
    (Array.isArray(data?.errors) && data.errors[0]?.message) ||
    (Array.isArray(data?.errors) && typeof data.errors[0] === "string" ? data.errors[0] : null) ||
    statusText;
  if (hint) return hint;
  if (code === "invalidCredentials" || /incorrect/i.test(String(base || ""))) {
    return (
      (base ? `${base} ` : "") +
      "Tip: use the same email/password as the Time Doctor 2 website (not your Jira password). " +
      "If you use Google/Microsoft SSO only, you may need a separate TD password or API access may be blocked."
    ).trim();
  }
  return base || statusText || "Time Doctor 2 API request failed";
}

async function tdFetchJson(path, query, init, token) {
  const url = new URL(path, `${tdBase()}/`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  const headers = {
    Accept: "application/json",
    ...init?.headers,
  };
  if (token) headers.Authorization = `JWT ${token}`;
  if (init?.body && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, {
    ...init,
    headers,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = tdErrorMessage(data, res.statusText);
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function summarizeCompanies(companies) {
  if (!Array.isArray(companies)) return [];
  return companies.map((c) => ({
    id: c.id,
    name: c.name,
    role: c.role,
  }));
}

async function tdLoginAndLoadCompanies(email, password, totpCode) {
  const loginBody = {
    email,
    password,
    permissions: "write",
    ...(totpCode ? { totpCode } : {}),
  };
  const loginRes = await tdFetchJson(
    "api/1.0/login",
    null,
    { method: "POST", body: JSON.stringify(loginBody) },
    ""
  );
  const token = loginRes?.data?.token;
  const expires = loginRes?.data?.expires || null;
  if (!token) {
    const err = new Error("Time Doctor 2 login returned no token");
    err.status = 502;
    throw err;
  }
  let companies = [];
  let sessionUserId = null;
  try {
    const authRes = await tdFetchJson("api/1.0/authorization", null, { method: "GET" }, token);
    companies = summarizeCompanies(authRes?.data?.companies);
    sessionUserId = authRes?.data?.id || null;
  } catch {
    try {
      const compRes = await tdFetchJson("api/1.0/companies", null, { method: "GET" }, token);
      const raw = compRes?.data;
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      companies = summarizeCompanies(list);
    } catch {
      companies = [];
    }
  }
  return { token, expires, companies, sessionUserId };
}

function tdTasksArray(data) {
  const raw = data?.data;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray(raw.tasks)) return raw.tasks;
  return [];
}

/**
 * Whether the Time Doctor desktop tracker is connected (same signal the TD ecosystem uses;
 * the browser extension talks to the desktop app via native messaging, not this API).
 */
function readTrackerOnline(authData, companyId) {
  const d = authData?.data;
  if (!d) return null;
  const companies = d.companies;
  if (companyId && Array.isArray(companies)) {
    const row = companies.find((c) => c?.id === companyId);
    if (row?.lastTrack && typeof row.lastTrack.online === "boolean") {
      return row.lastTrack.online;
    }
  }
  if (typeof d.lastTrackGlobal?.online === "boolean") return d.lastTrackGlobal.online;
  return null;
}

async function tdFetchAuthorization(token, companyId) {
  return tdFetchJson(
    "api/1.0/authorization",
    companyId ? { company: companyId } : null,
    { method: "GET" },
    token
  );
}

async function tdStartProgress(token, companyId, taskId, projectId) {
  await tdFetchJson(
    `api/1.0/tasks/${encodeURIComponent(taskId)}`,
    { company: companyId },
    { method: "PUT", body: JSON.stringify({ status: "progress" }) },
    token
  );
  const statusBody = { mode: "computer", taskId };
  if (projectId) statusBody.projectId = projectId;
  return tdFetchJson(
    "api/1.0/status",
    { company: companyId },
    { method: "PUT", body: JSON.stringify(statusBody) },
    token
  );
}

async function findTdTaskForJira(t, token, jiraKey) {
  const phrase = jiraKey.trim();
  if (!phrase) return null;
  const attempts = [];
  if (t.userId) {
    attempts.push({
      company: t.companyId,
      user: t.userId,
      filter: "assigned",
      "filter[keyphrase]": phrase,
      limit: "80",
    });
  }
  attempts.push(
    {
      company: t.companyId,
      "filter[keyphrase]": phrase,
      "show-integration": "true",
      limit: "80",
    },
    {
      company: t.companyId,
      "filter[keyphrase]": phrase,
      limit: "80",
    }
  );
  for (const query of attempts) {
    try {
      const data = await tdFetchJson("api/1.0/tasks", query, { method: "GET" }, token);
      const list = tdTasksArray(data);
      const hit = list.find((x) => (x.name || "").includes(phrase));
      if (hit?.id) return hit;
    } catch {
      /* try next query shape */
    }
  }
  return null;
}

export function registerTimeDoctorRoutes(app, { requireJiraAuth }) {
  app.post("/api/timedoctor/connect", requireJiraAuth, async (req, res) => {
    const emailRaw = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    const email = emailRaw.toLowerCase();
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const totpCode =
      typeof req.body?.totpCode === "string" ? req.body.totpCode.trim() : "";
    if (!email || !password) {
      return res.status(400).json({ error: "email and password required" });
    }
    try {
      const { token, expires, companies, sessionUserId } = await tdLoginAndLoadCompanies(
        email,
        password,
        totpCode
      );
      let companyId = null;
      if (companies.length === 1) companyId = companies[0].id;
      req.session.timedoctor = {
        token,
        expires,
        companyId,
        companies,
        userId: sessionUserId,
      };
      await new Promise((resolve, reject) => {
        req.session.save((err) => (err ? reject(err) : resolve()));
      });
      res.json({
        ok: true,
        companies,
        companyId,
        expires,
      });
    } catch (e) {
      const status = e.status || 500;
      return res.status(status).json({
        error: e.message,
        details: e.body,
      });
    }
  });

  app.post("/api/timedoctor/disconnect", requireJiraAuth, async (req, res) => {
    const t = tdSession(req);
    if (t?.token) {
      try {
        await tdFetchJson("api/1.0/logout", null, { method: "GET" }, t.token);
      } catch {
        /* ignore */
      }
    }
    req.session.timedoctor = undefined;
    await new Promise((resolve) => req.session.save(() => resolve()));
    res.json({ ok: true });
  });

  app.get("/api/timedoctor/status", requireJiraAuth, async (req, res) => {
    const t = tdSession(req);
    let trackerOnline = null;
    if (t?.token && t.companyId) {
      try {
        const authRes = await tdFetchAuthorization(t.token, t.companyId);
        const uid = authRes?.data?.id;
        if (uid && !t.userId) {
          t.userId = uid;
          await new Promise((resolve, reject) => {
            req.session.save((err) => (err ? reject(err) : resolve()));
          });
        }
        trackerOnline = readTrackerOnline(authRes, t.companyId);
      } catch {
        /* ignore */
      }
    } else if (t?.token && !t.userId) {
      try {
        const authRes = await tdFetchAuthorization(t.token, null);
        t.userId = authRes?.data?.id || null;
        await new Promise((resolve, reject) => {
          req.session.save((err) => (err ? reject(err) : resolve()));
        });
      } catch {
        /* ignore */
      }
    }
    res.json({
      connected: Boolean(t?.token),
      companyId: t?.companyId || null,
      companies: t?.companies || [],
      expires: t?.expires || null,
      userId: t?.userId || null,
      trackerOnline,
    });
  });

  app.post("/api/timedoctor/company", requireJiraAuth, async (req, res) => {
    const id = typeof req.body?.companyId === "string" ? req.body.companyId.trim() : "";
    if (!id) return res.status(400).json({ error: "companyId required" });
    const t = tdSession(req);
    if (!t?.token) return res.status(401).json({ error: "timedoctor_not_connected" });
    const ok = (t.companies || []).some((c) => c.id === id);
    if (!ok) return res.status(400).json({ error: "unknown_company" });
    t.companyId = id;
    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });
    res.json({ ok: true, companyId: id });
  });

  function requireTd(req, res) {
    const t = tdSession(req);
    if (!t?.token) {
      res.status(401).json({ error: "timedoctor_not_connected" });
      return null;
    }
    if (!t.companyId) {
      res.status(400).json({ error: "timedoctor_company_required" });
      return null;
    }
    return t;
  }

  app.get("/api/timedoctor/users", requireJiraAuth, async (req, res) => {
    const t = requireTd(req, res);
    if (!t) return;
    try {
      const data = await tdFetchJson(
        "api/1.0/users",
        {
          company: t.companyId,
          limit: req.query.limit || "100",
          page: req.query.page || undefined,
          detail: "name",
        },
        { method: "GET" },
        t.token
      );
      res.json(data);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, details: e.body });
    }
  });

  app.get(
    "/api/timedoctor/users/:userId/screenshots",
    requireJiraAuth,
    async (req, res) => {
      const t = requireTd(req, res);
      if (!t) return;
      const { userId } = req.params;
      try {
        const data = await tdFetchJson(
          `api/1.0/files/screenshot`,
          {
            company: t.companyId,
            user: userId,
            limit: req.query.limit || "50",
            page: req.query.page || undefined,
            sort: req.query.sort || "_date",
          },
          { method: "GET" },
          t.token
        );
        res.json(data);
      } catch (e) {
        res.status(e.status || 500).json({ error: e.message, details: e.body });
      }
    }
  );

  app.get("/api/timedoctor/users/:userId/tasks", requireJiraAuth, async (req, res) => {
    const t = requireTd(req, res);
    if (!t) return;
    const { userId } = req.params;
    try {
      const data = await tdFetchJson(
        "api/1.0/tasks",
        {
          company: t.companyId,
          user: userId,
          filter: "assigned",
        },
        { method: "GET" },
        t.token
      );
      res.json(data);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, details: e.body });
    }
  });

  app.put("/api/timedoctor/tasks/:taskId", requireJiraAuth, async (req, res) => {
    const t = requireTd(req, res);
    if (!t) return;
    const { taskId } = req.params;
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    try {
      const data = await tdFetchJson(
        `api/1.0/tasks/${encodeURIComponent(taskId)}`,
        { company: t.companyId },
        { method: "PUT", body: JSON.stringify(body) },
        t.token
      );
      res.json(data);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, details: e.body });
    }
  });

  /**
   * Sets the authenticated TD user's work mode (e.g. computer tracking on a task).
   * Maps to PUT /api/1.0/status (StatusData: mode, taskId, optional projectId).
   */
  app.put("/api/timedoctor/work-status", requireJiraAuth, async (req, res) => {
    const t = requireTd(req, res);
    if (!t) return;
    const taskId = typeof req.body?.taskId === "string" ? req.body.taskId.trim() : "";
    const projectId =
      typeof req.body?.projectId === "string" && req.body.projectId.trim()
        ? req.body.projectId.trim()
        : undefined;
    const mode =
      typeof req.body?.mode === "string" && req.body.mode.trim() ? req.body.mode.trim() : "computer";
    if (!taskId) return res.status(400).json({ error: "taskId required" });
    const statusBody = { mode, taskId };
    if (projectId) statusBody.projectId = projectId;
    try {
      const data = await tdFetchJson(
        "api/1.0/status",
        { company: t.companyId },
        { method: "PUT", body: JSON.stringify(statusBody) },
        t.token
      );
      res.json(data);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, details: e.body });
    }
  });

  app.post("/api/timedoctor/tasks/:taskId/start-progress", requireJiraAuth, async (req, res) => {
    const t = requireTd(req, res);
    if (!t) return;
    const { taskId } = req.params;
    const projectId =
      typeof req.body?.projectId === "string" && req.body.projectId.trim()
        ? req.body.projectId.trim()
        : undefined;
    try {
      const data = await tdStartProgress(t.token, t.companyId, taskId, projectId);
      res.json(data);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, details: e.body });
    }
  });

  /**
   * After a Jira issue moves to an "in progress"-style status, find or create a TD task
   * (name containing the Jira key) and start computer tracking — same TD2 calls as the
   * start-progress route. Requires the desktop app to be connected (trackerOnline), like the
   * official browser extension + native host workflow.
   */
  app.post("/api/timedoctor/jira/start-tracking", requireJiraAuth, async (req, res) => {
    const t = requireTd(req, res);
    if (!t) return;
    const jiraKey =
      typeof req.body?.jiraKey === "string" ? req.body.jiraKey.trim().toUpperCase() : "";
    const summary =
      typeof req.body?.summary === "string" && req.body.summary.trim()
        ? req.body.summary.trim()
        : jiraKey;
    if (!jiraKey) return res.status(400).json({ error: "jiraKey required" });
    if (!t.userId) {
      return res.status(400).json({ error: "timedoctor_user_unknown", message: "Reconnect Time Doctor or open Time Doctor settings once." });
    }
    try {
      const authRes = await tdFetchAuthorization(t.token, t.companyId);
      const online = readTrackerOnline(authRes, t.companyId);
      if (online === false) {
        return res.status(409).json({
          error: "timedoctor_app_offline",
          message:
            "Time Doctor does not see an active desktop tracker. Open the Time Doctor desktop app (the browser extension uses it the same way).",
        });
      }
    } catch (e) {
      return res.status(e.status || 502).json({ error: e.message, details: e.body });
    }

    let task = await findTdTaskForJira(t, t.token, jiraKey);
    if (!task?.id) {
      try {
        const created = await tdFetchJson(
          "api/1.0/tasks",
          { company: t.companyId },
          {
            method: "POST",
            body: JSON.stringify({
              name: `${jiraKey} — ${summary}`,
              status: "open",
            }),
          },
          t.token
        );
        task = created?.data;
      } catch (e) {
        return res.status(e.status || 502).json({
          error: e.message,
          details: e.body,
          hint: "Create or sync a task in Time Doctor that includes the Jira key in its name, then try again.",
        });
      }
    }
    if (!task?.id) {
      return res.status(404).json({
        error: "timedoctor_task_not_found",
        message: "Could not find or create a Time Doctor task for this Jira issue.",
      });
    }
    const projectId = task.project?.id || undefined;
    try {
      const data = await tdStartProgress(t.token, t.companyId, task.id, projectId);
      res.json({ ok: true, taskId: task.id, timedoctor: data });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, details: e.body });
    }
  });

  app.get(
    "/api/timedoctor/signed-url/:type/:date/:number",
    requireJiraAuth,
    async (req, res) => {
      const t = requireTd(req, res);
      if (!t) return;
      const { type, date, number } = req.params;
      try {
        const data = await tdFetchJson(
          `api/1.1/files/${encodeURIComponent(type)}/signed-url/${encodeURIComponent(date)}/${encodeURIComponent(number)}`,
          { company: t.companyId },
          { method: "GET" },
          t.token
        );
        const d = data?.data;
        if (d && (typeof d.original === "string" || typeof d.small === "string")) {
          return res.json({ original: d.original, small: d.small });
        }
        return res.status(502).json({ error: "unexpected_signed_url_response", details: data });
      } catch (e) {
        res.status(e.status || 500).json({ error: e.message, details: e.body });
      }
    }
  );

  /**
   * 1) DELETE /api/1.0/files/{type}/{date}/{number} — remove the specific file entry.
   * 2) Optional: DELETE /api/1.0/files?company&userId&from&to — bulk-remove file records in [from, to)
   *    so the screencasts timeline can drop the slot (not just show "Screenshot deleted").
   * Pass userId (TD user id) and keep purge=1 (default). Use purgeWindowSeconds to widen the window
   * (1–3600) if a narrow purge leaves a ghost row.
   */
  app.delete(
    "/api/timedoctor/files/:type/:date/:number",
    requireJiraAuth,
    async (req, res) => {
      const t = requireTd(req, res);
      if (!t) return;
      const { type, date, number } = req.params;
      const userId = typeof req.query.userId === "string" ? req.query.userId.trim() : "";
      const purge = req.query.purge !== "0";
      const windowSec = Math.min(
        3600,
        Math.max(1, Math.floor(Number(req.query.purgeWindowSeconds) || 1))
      );
      try {
        const data = await tdFetchJson(
          `api/1.0/files/${encodeURIComponent(type)}/${encodeURIComponent(date)}/${encodeURIComponent(number)}`,
          { company: t.companyId },
          { method: "DELETE" },
          t.token
        );

        if (purge && userId) {
          const fromIso = decodeURIComponent(date);
          const startMs = Date.parse(fromIso);
          if (!Number.isNaN(startMs)) {
            const toIso = new Date(startMs + windowSec * 1000).toISOString();
            try {
              await tdFetchJson(
                "api/1.0/files",
                {
                  company: t.companyId,
                  userId,
                  from: fromIso,
                  to: toIso,
                },
                { method: "DELETE" },
                t.token
              );
            } catch {
              /* bulk purge is best-effort; single-file delete already succeeded */
            }
          }
        }

        res.json(data ?? { ok: true });
      } catch (e) {
        res.status(e.status || 500).json({ error: e.message, details: e.body });
      }
    }
  );
}

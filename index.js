import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import session from "express-session";
import sessionFileStoreFactory from "session-file-store";
import { registerTimeDoctorRoutes } from "./timedoctor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FileStore = sessionFileStoreFactory(session);

const {
  JIRA_CLIENT_ID,
  JIRA_CLIENT_SECRET,
  CLIENT_ORIGIN = "http://localhost:5173",
  PORT = 3001,
  SESSION_SECRET = "dev-secret-change-me",
  SESSION_STORE_PATH,
  SESSION_MAX_AGE_DAYS = "90",
  JIRA_CLOUD_ID,
} = process.env;

const jiraCloudIdFilter = JIRA_CLOUD_ID?.trim() || null;

const sessionMaxAgeMs =
  Math.max(1, Number(SESSION_MAX_AGE_DAYS) || 90) * 24 * 60 * 60 * 1000;
const sessionStorePath =
  SESSION_STORE_PATH || path.join(__dirname, ".sessions");

const SCOPES = [
  "read:jira-user",
  "read:jira-work",
  "write:jira-work",
  "offline_access",
].join(" ");

const AUTH_BASE = "https://auth.atlassian.com";
const API_BASE = "https://api.atlassian.com";

function requireEnv() {
  if (!JIRA_CLIENT_ID || !JIRA_CLIENT_SECRET) {
    console.error(
      "Missing JIRA_CLIENT_ID or JIRA_CLIENT_SECRET. Copy server/.env.example to server/.env and fill values."
    );
    process.exit(1);
  }
}

const app = express();

app.set("trust proxy", 1);

app.use(
  cors({
    origin: CLIENT_ORIGIN,
    credentials: true,
  })
);

app.use(
  session({
    name: "tasker.sid",
    secret: SESSION_SECRET,
    store: new FileStore({
      path: sessionStorePath,
      retries: 0,
    }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      maxAge: sessionMaxAgeMs,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  })
);

app.use(express.json());

const redirectUri = () =>
  `http://localhost:${PORT}/api/oauth/callback`;

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const fromJira =
      Array.isArray(data?.errorMessages) && data.errorMessages.length
        ? data.errorMessages.join(" ")
        : null;
    const err = new Error(
      data?.error_description ||
        data?.message ||
        fromJira ||
        res.statusText
    );
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function refreshAccessToken(refreshToken) {
  const body = {
    grant_type: "refresh_token",
    client_id: JIRA_CLIENT_ID,
    client_secret: JIRA_CLIENT_SECRET,
    refresh_token: refreshToken,
  };
  return fetchJson(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sessionTokens(req) {
  return req.session?.jira || null;
}

function setSessionTokens(req, tokenResponse) {
  const prev = sessionTokens(req);
  const refreshToken =
    tokenResponse.refresh_token ?? prev?.refresh_token ?? null;
  req.session.jira = {
    access_token: tokenResponse.access_token,
    refresh_token: refreshToken,
    expires_at: Date.now() + (tokenResponse.expires_in || 3600) * 1000,
    cloudId: prev?.cloudId ?? null,
    siteUrl: prev?.siteUrl ?? null,
    cloudPickVersion: prev?.cloudPickVersion,
  };
}

async function ensureAccessToken(req) {
  const t = sessionTokens(req);
  if (!t?.access_token) return null;
  if (t.expires_at && Date.now() < t.expires_at - 60_000) return t.access_token;
  if (!t.refresh_token) return null;
  try {
    const next = await refreshAccessToken(t.refresh_token);
    setSessionTokens(req, next);
    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });
    return next.access_token;
  } catch (e) {
    const st = e?.status;
    if (st === 400 || st === 401 || st === 403) {
      req.session.jira = undefined;
      await new Promise((resolve) => req.session.save(() => resolve()));
    }
    return null;
  }
}

function resourceHasJiraSiteScopes(resource) {
  const scopes = resource?.scopes;
  if (!Array.isArray(scopes)) return false;
  return scopes.some(
    (s) =>
      typeof s === "string" &&
      (s === "read:jira-work" ||
        s === "write:jira-work" ||
        s.includes("jira-work"))
  );
}

/** Atlassian does not order accessible-resources; never use resources[0] blindly. */
function pickJiraCloudResource(resources) {
  if (!Array.isArray(resources) || resources.length === 0) return null;
  if (jiraCloudIdFilter) {
    const match = resources.find((r) => r?.id === jiraCloudIdFilter);
    if (match) return match;
  }
  const jiraSites = resources.filter(resourceHasJiraSiteScopes);
  if (jiraSites.length > 0) return jiraSites[0];
  return resources[0];
}

/** Increment when site-picking logic changes so cached cloudId is refreshed. */
const CLOUD_PICK_VERSION = 2;

async function getCloudId(req, accessToken) {
  const t = sessionTokens(req);
  if (!t) {
    throw new Error("Session missing Jira tokens.");
  }
  if (t.cloudPickVersion !== CLOUD_PICK_VERSION) {
    t.cloudId = null;
    t.siteUrl = null;
    t.cloudPickVersion = CLOUD_PICK_VERSION;
  }
  if (t.cloudId) return t.cloudId;
  const resources = await fetchJson(`${API_BASE}/oauth/token/accessible-resources`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const site = pickJiraCloudResource(resources);
  if (!site?.id) {
    throw new Error("No Jira cloud site linked to this Atlassian account.");
  }
  t.cloudId = site.id;
  t.siteUrl = site.url || null;
  t.cloudPickVersion = CLOUD_PICK_VERSION;
  await new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
  return site.id;
}

function jiraUrl(cloudId, path) {
  return `${API_BASE}/ex/jira/${cloudId}/rest/api/3${path}`;
}

const JIRA_SEARCH_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "updated",
  "project",
];

async function fetchJiraIssueSearch(
  cloudId,
  accessToken,
  jql,
  maxResults,
  siteUrl
) {
  const urlBase = jiraUrl(cloudId, "/search/jql");
  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  const postBody = JSON.stringify({
    jql,
    maxResults,
    fields: JIRA_SEARCH_FIELDS,
    fieldsByKeys: false,
  });
  const post = (url) =>
    fetchJson(url, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
      },
      body: postBody,
    });

  // POST first: GET .../search/jql on ex/jira is sometimes handled like deprecated GET .../search,
  // which responds with "migrate to /rest/api/3/search/jql" even though the path includes /jql.
  try {
    return await post(urlBase);
  } catch (postEx) {
    const msg = String(postEx.message || "");
    const retryable =
      postEx.status === 410 ||
      postEx.status === 405 ||
      msg.includes("has been removed") ||
      msg.includes("migrate to the /rest/api/3/search/jql");
    if (!retryable) throw postEx;

    const params = new URLSearchParams({
      jql,
      maxResults: String(maxResults),
      fields: JIRA_SEARCH_FIELDS.join(","),
    });
    try {
      return await fetchJson(`${urlBase}?${params.toString()}`, {
        method: "GET",
        headers: authHeaders,
      });
    } catch {
      const base =
        typeof siteUrl === "string" && /^https:\/\//i.test(siteUrl)
          ? siteUrl.replace(/\/$/, "")
          : "";
      if (base) {
        return await post(`${base}/rest/api/3/search/jql`);
      }
      throw postEx;
    }
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/auth/status", (req, res) => {
  res.json({ authenticated: Boolean(sessionTokens(req)?.access_token) });
});

app.get("/api/auth/atlassian", (req, res) => {
  const state = crypto.randomUUID();
  req.session.oauthState = state;
  req.session.save((err) => {
    if (err) {
      return res.status(500).json({ error: "session_save_failed" });
    }
    const params = new URLSearchParams({
      audience: "api.atlassian.com",
      client_id: JIRA_CLIENT_ID,
      scope: SCOPES,
      redirect_uri: redirectUri(),
      response_type: "code",
      state,
    });
    res.json({
      url: `${AUTH_BASE}/authorize?${params.toString()}`,
    });
  });
});

app.get("/api/oauth/callback", async (req, res) => {
  const { code, state, error, error_description: desc } = req.query;
  if (error) {
    return res.redirect(
      `${CLIENT_ORIGIN}/?error=${encodeURIComponent(String(error))}&detail=${encodeURIComponent(String(desc || ""))}`
    );
  }
  if (!state || state !== req.session.oauthState) {
    return res.redirect(`${CLIENT_ORIGIN}/?error=invalid_state`);
  }
  delete req.session.oauthState;
  if (!code || typeof code !== "string") {
    return res.redirect(`${CLIENT_ORIGIN}/?error=missing_code`);
  }
  try {
    const tokenResponse = await fetchJson(`${AUTH_BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: JIRA_CLIENT_ID,
        client_secret: JIRA_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri(),
      }),
    });
    setSessionTokens(req, tokenResponse);
    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });
    return res.redirect(`${CLIENT_ORIGIN}/`);
  } catch (e) {
    return res.redirect(
      `${CLIENT_ORIGIN}/?error=token_exchange&detail=${encodeURIComponent(e.message)}`
    );
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("tasker.sid");
    res.json({ ok: true });
  });
});

async function requireJiraAuth(req, res, next) {
  try {
    const accessToken = await ensureAccessToken(req);
    if (!accessToken) {
      return res.status(401).json({ error: "not_authenticated" });
    }
    next();
  } catch (e) {
    next(e);
  }
}

registerTimeDoctorRoutes(app, { requireJiraAuth });

async function withJira(req, res, handler) {
  try {
    const accessToken = await ensureAccessToken(req);
    if (!accessToken) {
      return res.status(401).json({ error: "not_authenticated" });
    }
    const cloudId = await getCloudId(req, accessToken);
    return await handler(cloudId, accessToken);
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({
      error: e.message,
      details: e.body,
    });
  }
}

app.get("/api/jira/me", (req, res) => {
  return withJira(req, res, async (cloudId, accessToken) => {
    const me = await fetchJson(jiraUrl(cloudId, "/myself"), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    const t = sessionTokens(req);
    res.json({ ...me, siteUrl: t?.siteUrl || null });
  });
});

app.get("/api/jira/issues", (req, res) => {
  const jql =
    typeof req.query.jql === "string" && req.query.jql.trim()
      ? req.query.jql.trim()
      : "assignee = currentUser() ORDER BY updated DESC";
  const max = Math.min(Number(req.query.maxResults) || 25, 50);
  return withJira(req, res, async (cloudId, accessToken) => {
    const t = sessionTokens(req);
    const data = await fetchJiraIssueSearch(
      cloudId,
      accessToken,
      jql,
      max,
      t?.siteUrl || null
    );
    res.json(data);
  });
});

app.get("/api/jira/issues/:key", (req, res) => {
  const key = encodeURIComponent(req.params.key);
  return withJira(req, res, async (cloudId, accessToken) => {
    const data = await fetchJson(jiraUrl(cloudId, `/issue/${key}`), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    res.json(data);
  });
});

app.get("/api/jira/issues/:key/transitions", (req, res) => {
  const key = encodeURIComponent(req.params.key);
  return withJira(req, res, async (cloudId, accessToken) => {
    const data = await fetchJson(jiraUrl(cloudId, `/issue/${key}/transitions`), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    res.json(data);
  });
});

app.post("/api/jira/issues/:key/transitions", (req, res) => {
  const rawKey = req.params.key;
  const keyEnc = encodeURIComponent(rawKey);
  const transitionId =
    typeof req.body?.transitionId === "string" ? req.body.transitionId.trim() : "";
  if (!transitionId) {
    return res.status(400).json({ error: "transitionId required" });
  }
  return withJira(req, res, async (cloudId, accessToken) => {
    const authHeaders = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    await fetchJson(jiraUrl(cloudId, `/issue/${keyEnc}/transitions`), {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
    const issue = await fetchJson(
      jiraUrl(cloudId, `/issue/${keyEnc}?fields=summary,status,project`),
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      }
    );
    res.json({ issue });
  });
});

requireEnv();

app.listen(Number(PORT), () => {
  console.log(`Tasker API http://localhost:${PORT}`);
  console.log(`OAuth callback (add to Atlassian app): ${redirectUri()}`);
});

// Publicador del estado publico a GitHub (Contents API). Solo escribe el JSON
// privacy-safe derivado por el store. Gated: si no hay token+org, no publica
// (modo demo). En produccion usa un PAT fine-grained o GitHub App con
// contenido:write SOLO sobre los repos de rifas.

import { config, isGithubConfigured } from "./config.js";

const GITHUB_API = "https://api.github.com";

async function putFile(repo, path, contentObj, message, branch, token) {
  const url = `${GITHUB_API}/repos/${config.github.org}/${repo}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "sorteos-rifas-backend",
  };

  // Necesitamos el sha actual del archivo para actualizarlo (si existe).
  let sha;
  const getRes = await fetch(`${url}?ref=${branch}`, { headers });
  if (getRes.ok) {
    const existing = await getRes.json();
    sha = existing.sha;
  }

  const body = {
    message,
    content: Buffer.from(JSON.stringify(contentObj, null, 2)).toString("base64"),
    branch,
    ...(sha ? { sha } : {}),
  };
  const res = await fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PUT ${path} fallo: ${res.status} ${text}`);
  }
  return res.json();
}

// Publica raffle.json + numbers.json (y draw.json si hay ganador) al repo <org>/<slug>.
export async function publishPublicState(store, slug, { draw = null } = {}) {
  const raffle = store.publicRaffle(slug);
  const numbers = store.publicNumbers(slug);

  if (!isGithubConfigured()) {
    return { published: false, reason: "GitHub no configurado (modo demo)", raffle, numbers, draw };
  }

  const { token, branch } = config.github;
  await putFile(slug, "public/raffle.json", raffle, `chore: actualizar raffle.json (${raffle.status})`, branch, token);
  await putFile(slug, "public/numbers.json", numbers, `chore: publicar ${numbers.sold.length} numeros vendidos`, branch, token);
  if (draw) {
    await putFile(slug, "public/draw.json", draw, `feat: declarar ganador numero ${draw.winningNumber}`, branch, token);
  }
  return { published: true, raffle, numbers, draw };
}

const LOCAL_API_BASE_URL = "http://localhost:3000/api/";
// Set this to the public API base URL before deploying the frontend.
const PRODUCTION_API_BASE_URL = "https://taskflow-api-ehr4.onrender.com/api/";
const localHosts = new Set(["localhost", "127.0.0.1"]);
const isLocalDevelopment = localHosts.has(window.location.hostname);

const configuredApiUrl = PRODUCTION_API_BASE_URL.trim();
const defaultApiUrl = new URL("/api/", window.location.origin).href;
const selectedApiUrl = isLocalDevelopment
  ? LOCAL_API_BASE_URL
  : configuredApiUrl || defaultApiUrl;
const parsedApiUrl = new URL(selectedApiUrl, window.location.href);

if (!["http:", "https:"].includes(parsedApiUrl.protocol)) {
  throw new Error("La URL de la API debe utilizar HTTP o HTTPS.");
}

if (parsedApiUrl.username || parsedApiUrl.password) {
  throw new Error("La URL de la API no debe incluir credenciales.");
}

if (
  window.location.protocol === "https:"
  && parsedApiUrl.protocol !== "https:"
  && !localHosts.has(parsedApiUrl.hostname)
) {
  throw new Error("La URL de la API debe utilizar HTTPS en producción.");
}

if (!parsedApiUrl.pathname.endsWith("/api/")) {
  parsedApiUrl.pathname = `${parsedApiUrl.pathname.replace(/\/+$/, "")}/api/`;
}

export const API_BASE_URL = parsedApiUrl;

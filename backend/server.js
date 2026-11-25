import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const PORT = Number(process.env.PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT debe ser un número entero entre 1 y 65535.");
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIRECTORY = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIRECTORY, "activities.json");
const TEMP_FILE = path.join(DATA_DIRECTORY, "activities.json.tmp");
const app = express();
function parseAllowedOrigins(value) {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      let parsedOrigin;
      try {
        parsedOrigin = new URL(origin);
      } catch {
        throw new Error(`Origen frontend inválido en FRONTEND_URL: ${origin}`);
      }

      if (
        !["http:", "https:"].includes(parsedOrigin.protocol)
        || parsedOrigin.username
        || parsedOrigin.password
      ) {
        throw new Error(`Origen frontend inválido en FRONTEND_URL: ${origin}`);
      }
      return parsedOrigin.origin;
    });
}

const allowedOrigins = new Set([
  ...parseAllowedOrigins(process.env.FRONTEND_URL ?? ""),
  ...parseAllowedOrigins(process.env.FRONTEND_ORIGINS ?? ""),
]);

let writeQueue = Promise.resolve();

app.disable("x-powered-by");
app.use((request, response, next) => {
  const origin = request.get("Origin");
  const isLocalDevelopmentOrigin = process.env.NODE_ENV !== "production"
    && origin
    && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);

  if (origin && (allowedOrigins.has(origin) || isLocalDevelopmentOrigin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  } else if (origin && request.method === "OPTIONS") {
    return response.sendStatus(403);
  }

  if (request.method === "OPTIONS") {
    return response.sendStatus(204);
  }

  next();
});
app.use(express.json({ limit: "256kb" }));

function readTimestamp(value, fieldName) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    const error = new Error(`${fieldName} debe ser una fecha ISO válida.`);
    error.status = 400;
    throw error;
  }
  return new Date(value).toISOString();
}

function validateActivity(body, { requireId }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const error = new Error("El cuerpo debe ser un objeto JSON.");
    error.status = 400;
    throw error;
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title || title.length > 120) {
    const error = new Error("El título es obligatorio y debe tener como máximo 120 caracteres.");
    error.status = 400;
    throw error;
  }

  const priority = body.priority ?? "medium";
  if (!["low", "medium", "high"].includes(priority)) {
    const error = new Error("La prioridad debe ser low, medium o high.");
    error.status = 400;
    throw error;
  }

  const status = body.status ?? "pending";
  if (!["pending", "completed"].includes(status)) {
    const error = new Error("El estado debe ser pending o completed.");
    error.status = 400;
    throw error;
  }

  const id = body.id ?? (requireId ? null : randomUUID());
  if (typeof id !== "string" || !id.trim() || id.length > 200) {
    const error = new Error("El identificador de la actividad no es válido.");
    error.status = 400;
    throw error;
  }

  if (typeof body.description !== "undefined" && typeof body.description !== "string") {
    const error = new Error("La descripción debe ser texto.");
    error.status = 400;
    throw error;
  }
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (description.length > 5000) {
    const error = new Error("La descripción debe tener como máximo 5000 caracteres.");
    error.status = 400;
    throw error;
  }

  const date = body.date ?? "";
  if (
    typeof date !== "string"
    || date.length > 64
    || (date !== "" && !Number.isFinite(Date.parse(date)))
  ) {
    const error = new Error("La fecha de la actividad no es válida.");
    error.status = 400;
    throw error;
  }

  let reminderNotifiedAt = null;
  if (body.reminderNotifiedAt !== undefined && body.reminderNotifiedAt !== null) {
    reminderNotifiedAt = readTimestamp(body.reminderNotifiedAt, "reminderNotifiedAt");
  }

  return {
    id,
    title,
    description,
    date,
    priority,
    status,
    createdAt: body.createdAt ? readTimestamp(body.createdAt, "createdAt") : new Date().toISOString(),
    updatedAt: readTimestamp(body.updatedAt ?? new Date().toISOString(), "updatedAt"),
    reminderNotifiedAt,
  };
}

async function loadData() {
  try {
    const contents = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(contents);

    if (Array.isArray(parsed)) {
      return { activities: parsed, deleted: {} };
    }

    if (
      !parsed
      || !Array.isArray(parsed.activities)
      || typeof parsed.deleted !== "object"
      || parsed.deleted === null
      || Array.isArray(parsed.deleted)
    ) {
      throw new Error("activities.json no tiene el formato esperado.");
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      return { activities: [], deleted: {} };
    }
    throw error;
  }
}

async function persistData(data) {
  await mkdir(DATA_DIRECTORY, { recursive: true });
  await writeFile(TEMP_FILE, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(TEMP_FILE, DATA_FILE);
}

function mutateData(mutator) {
  const operation = writeQueue.then(async () => {
    const data = await loadData();
    const result = mutator(data);
    if (result.changed) {
      await persistData(data);
    }
    return result.value;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

function compareUpdatedAt(left, right) {
  return Date.parse(left) - Date.parse(right);
}

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok", service: "TaskFlow API" });
});

app.get("/api/activities", async (request, response, next) => {
  try {
    const data = await loadData();
    if (request.query.includeDeleted === "true") {
      return response.json({ activities: data.activities, deleted: data.deleted });
    }
    return response.json(data.activities);
  } catch (error) {
    return next(error);
  }
});

app.post("/api/activities", async (request, response, next) => {
  try {
    const incoming = validateActivity(request.body, { requireId: false });
    const result = await mutateData((data) => {
      const deletedAt = data.deleted[incoming.id];
      if (deletedAt && compareUpdatedAt(incoming.updatedAt, deletedAt) <= 0) {
        return {
          changed: false,
          value: { applied: false, deleted: true, deletedAt },
        };
      }

      const existingIndex = data.activities.findIndex((activity) => activity.id === incoming.id);
      if (existingIndex !== -1) {
        const existing = data.activities[existingIndex];
        if (compareUpdatedAt(incoming.updatedAt, existing.updatedAt) > 0) {
          data.activities[existingIndex] = incoming;
          if (deletedAt) {
            delete data.deleted[incoming.id];
          }
          return { changed: true, value: { applied: true, activity: incoming } };
        }
        return { changed: false, value: { applied: false, activity: existing } };
      }

      data.activities.push(incoming);
      if (deletedAt) {
        delete data.deleted[incoming.id];
      }
      return { changed: true, value: { applied: true, activity: incoming } };
    });

    return response.json(result);
  } catch (error) {
    return next(error);
  }
});

app.put("/api/activities/:id", async (request, response, next) => {
  try {
    const incoming = validateActivity(
      { ...request.body, id: request.params.id },
      { requireId: true },
    );
    const result = await mutateData((data) => {
      const deletedAt = data.deleted[incoming.id];
      if (deletedAt && compareUpdatedAt(incoming.updatedAt, deletedAt) <= 0) {
        return {
          changed: false,
          value: { applied: false, deleted: true, deletedAt },
        };
      }

      const existingIndex = data.activities.findIndex((activity) => activity.id === incoming.id);
      if (existingIndex !== -1 && compareUpdatedAt(
        incoming.updatedAt,
        data.activities[existingIndex].updatedAt,
      ) <= 0) {
        return {
          changed: false,
          value: { applied: false, activity: data.activities[existingIndex] },
        };
      }

      data.activities = data.activities.filter((activity) => activity.id !== incoming.id);
      data.activities.push(incoming);
      if (deletedAt) {
        delete data.deleted[incoming.id];
      }
      return { changed: true, value: { applied: true, activity: incoming } };
    });

    return response.json(result);
  } catch (error) {
    return next(error);
  }
});

app.delete("/api/activities/:id", async (request, response, next) => {
  try {
    const id = request.params.id;
    const deletedAt = readTimestamp(
      request.body?.updatedAt ?? request.query.updatedAt,
      "updatedAt",
    );
    const result = await mutateData((data) => {
      const existing = data.activities.find((activity) => activity.id === id);
      if (existing && compareUpdatedAt(existing.updatedAt, deletedAt) > 0) {
        return {
          changed: false,
          value: { id, deleted: false, activity: existing },
        };
      }

      const wasPresent = Boolean(existing);
      data.activities = data.activities.filter((activity) => activity.id !== id);
      const previousTombstone = data.deleted[id];
      if (!previousTombstone || compareUpdatedAt(deletedAt, previousTombstone) > 0) {
        data.deleted[id] = deletedAt;
      }

      return {
        changed: wasPresent || !previousTombstone || deletedAt !== previousTombstone,
        value: { id, deleted: true, deletedAt: data.deleted[id] },
      };
    });

    return response.json(result);
  } catch (error) {
    return next(error);
  }
});

app.use((request, response) => {
  response.status(404).json({
    error: "No encontrado",
    message: `No existe la ruta ${request.method} ${request.path}.`,
  });
});

app.use((error, _request, response, _next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return response.status(400).json({ error: "JSON inválido", message: error.message });
  }

  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) {
    console.error("TaskFlow API:", error);
  }
  return response.status(status).json({
    error: status >= 500 ? "Error interno del servidor" : "Solicitud inválida",
    message: status >= 500 ? "No se pudo completar la operación." : error.message,
  });
});

await mkdir(DATA_DIRECTORY, { recursive: true });
app.listen(PORT, "0.0.0.0", () => {
  console.log(`TaskFlow API escuchando en 0.0.0.0:${PORT}`);
});

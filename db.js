const DATABASE_NAME = "TaskFlowDB";
const DATABASE_VERSION = 2;
const ACTIVITY_STORE = "activities";
const SYNC_QUEUE_STORE = "syncQueue";

/**
 * Opens TaskFlow's local database and upgrades old installations safely.
 * @returns {Promise<IDBDatabase>}
 */
export function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB no está disponible en este navegador."));
      return;
    }

    let settled = false;
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(ACTIVITY_STORE)) {
        database.createObjectStore(ACTIVITY_STORE, { keyPath: "id" });
      }

      if (!database.objectStoreNames.contains(SYNC_QUEUE_STORE)) {
        const queue = database.createObjectStore(SYNC_QUEUE_STORE, { keyPath: "id" });
        queue.createIndex("activityId", "activityId", { unique: false });
        queue.createIndex("timestamp", "timestamp", { unique: false });
      }
    };

    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }

      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };

    request.onerror = () => {
      settled = true;
      reject(request.error ?? new Error("No se pudo abrir la base de datos."));
    };

    request.onblocked = () => {
      settled = true;
      reject(new Error("La conexión a la base de datos está bloqueada por otra pestaña."));
    };
  });
}

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function validateActivityData(activity) {
  if (!activity || typeof activity !== "object") {
    throw new Error("Los datos de la actividad no son válidos.");
  }

  const title = typeof activity.title === "string" ? activity.title.trim() : "";
  if (!title) {
    throw new Error("El título de la actividad es obligatorio.");
  }

  const priority = activity.priority ?? "medium";
  if (!["low", "medium", "high"].includes(priority)) {
    throw new Error("La prioridad seleccionada no es válida.");
  }

  return {
    title,
    description: typeof activity.description === "string" ? activity.description.trim() : "",
    date: typeof activity.date === "string" ? activity.date : "",
    priority,
  };
}

function runTransaction(storeNames, mode, operation) {
  return openDatabase().then((database) => new Promise((resolve, reject) => {
    let transaction;
    let result;
    let operationError;

    try {
      transaction = database.transaction(storeNames, mode);
      operation(
        transaction,
        (value) => {
          result = value;
        },
        (error) => {
          operationError = error;
        },
      );
    } catch (error) {
      database.close();
      reject(error);
      return;
    }

    transaction.oncomplete = () => {
      database.close();
      resolve(result);
    };

    transaction.onabort = () => {
      database.close();
      reject(
        operationError
          ?? transaction.error
          ?? new Error("La operación de IndexedDB fue cancelada."),
      );
    };

    transaction.onerror = () => {
      operationError = transaction.error ?? new Error("Falló una operación de IndexedDB.");
    };
  }));
}

function queueActivityChange(queue, activityId, type, activity, timestamp, onComplete) {
  const activityIndex = queue.index("activityId");
  const request = activityIndex.getAll(activityId);

  request.onsuccess = () => {
    const previousOperations = request.result;
    const hasPendingCreate = previousOperations.some((operation) => operation.type === "create");
    const operationType = type === "delete"
      ? "delete"
      : (type === "update" && hasPendingCreate ? "create" : type);

    previousOperations.forEach((operation) => queue.delete(operation.id));
    queue.add({
      id: createId(),
      activityId,
      type: operationType,
      timestamp,
      payload: operationType === "delete" ? null : activity,
    });
    onComplete?.();
  };
};

/**
 * Adds a pending activity and queues its create operation atomically.
 * @param {{title: string, description: string, date: string, priority: string}} activity
 */
export function addActivity(activity) {
  const now = new Date().toISOString();
  const record = {
    ...validateActivityData(activity),
    id: createId(),
    status: "pending",
    createdAt: now,
    updatedAt: now,
    syncedAt: null,
    reminderNotifiedAt: null,
  };

  return runTransaction([ACTIVITY_STORE, SYNC_QUEUE_STORE], "readwrite", (transaction) => {
    transaction.objectStore(ACTIVITY_STORE).add(record);
    queueActivityChange(
      transaction.objectStore(SYNC_QUEUE_STORE),
      record.id,
      "create",
      record,
      now,
    );
  }).then(() => record);
}

/** Returns every locally stored activity, newest first. */
export function getActivities() {
  return runTransaction([ACTIVITY_STORE], "readonly", (transaction, setResult) => {
    const request = transaction.objectStore(ACTIVITY_STORE).getAll();
    request.onsuccess = () => {
      setResult(request.result.sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      ));
    };
  });
}

/** Returns all pending synchronization operations, oldest first. */
export function getSyncQueue() {
  return runTransaction([SYNC_QUEUE_STORE], "readonly", (transaction, setResult) => {
    const request = transaction.objectStore(SYNC_QUEUE_STORE).getAll();
    request.onsuccess = () => {
      setResult(request.result.sort((left, right) =>
        left.timestamp.localeCompare(right.timestamp),
      ));
    };
  });
}

/**
 * Adds older activities (created before the sync queue existed) to the queue.
 * Existing queue entries are never overwritten.
 */
export function queueUntrackedActivities() {
  return runTransaction(
    [ACTIVITY_STORE, SYNC_QUEUE_STORE],
    "readwrite",
    (transaction) => {
      const activitiesRequest = transaction.objectStore(ACTIVITY_STORE).getAll();
      activitiesRequest.onsuccess = () => {
        const activities = activitiesRequest.result.filter((activity) => !activity.syncedAt);
        const queue = transaction.objectStore(SYNC_QUEUE_STORE);
        const queueRequest = queue.getAll();

        queueRequest.onsuccess = () => {
          const queuedActivityIds = new Set(queueRequest.result.map((operation) => operation.activityId));
          activities.forEach((activity) => {
            if (!queuedActivityIds.has(activity.id)) {
              queue.add({
                id: createId(),
                activityId: activity.id,
                type: "create",
                timestamp: activity.updatedAt ?? activity.createdAt,
                payload: activity,
              });
            }
          });
        };
      };
    },
  );
}

/**
 * Applies a sync response and removes only the operation that was confirmed.
 * Newer queued local changes take precedence over a stale in-flight response.
 */
export function acknowledgeSyncOperation(operationId, serverResult) {
  return runTransaction(
    [ACTIVITY_STORE, SYNC_QUEUE_STORE],
    "readwrite",
    (transaction) => {
      const activities = transaction.objectStore(ACTIVITY_STORE);
      const queue = transaction.objectStore(SYNC_QUEUE_STORE);
      const operationRequest = queue.get(operationId);

      operationRequest.onsuccess = () => {
        const operation = operationRequest.result;
        if (!operation) {
          return;
        }

        queue.delete(operationId);
        const remainingRequest = queue.index("activityId").getAll(operation.activityId);
        remainingRequest.onsuccess = () => {
          if (remainingRequest.result.length > 0) {
            return;
          }

          if (operation.type === "delete" || serverResult.deleted) {
            if (serverResult.activity) {
              activities.put({
                ...serverResult.activity,
                syncedAt: serverResult.activity.updatedAt,
              });
            } else {
              activities.delete(operation.activityId);
            }
            return;
          }

          if (!serverResult.activity) {
            setError(new Error("El servidor confirmó la solicitud, pero no devolvió la actividad."));
            transaction.abort();
            return;
          }

          const localRequest = activities.get(operation.activityId);
          localRequest.onsuccess = () => {
            const localActivity = localRequest.result;
            const serverActivity = serverResult.activity;
            if (
              !localActivity
              || Date.parse(serverActivity.updatedAt) >= Date.parse(localActivity.updatedAt)
            ) {
              activities.put({
                ...serverActivity,
                syncedAt: serverActivity.updatedAt,
              });
            }
          };
        };
      };
    },
  );
}

/**
 * Merges server activities and tombstones without overwriting locally queued changes.
 * A local version newer than the server is queued to be sent back.
 */
export function reconcileRemoteSnapshot(snapshot) {
  return runTransaction(
    [ACTIVITY_STORE, SYNC_QUEUE_STORE],
    "readwrite",
    (transaction) => {
      const activitiesStore = transaction.objectStore(ACTIVITY_STORE);
      const queueStore = transaction.objectStore(SYNC_QUEUE_STORE);
      const activitiesRequest = activitiesStore.getAll();
      const queueRequest = queueStore.getAll();

      let activities;
      let queue;
      const reconcile = () => {
        if (!activities || !queue) {
          return;
        }

        const queuedIds = new Set(queue.map((operation) => operation.activityId));
        const localById = new Map(activities.map((activity) => [activity.id, activity]));
        const remoteById = new Map(snapshot.activities.map((activity) => [activity.id, activity]));
        const tombstones = snapshot.deleted ?? {};

        snapshot.activities.forEach((remoteActivity) => {
          if (queuedIds.has(remoteActivity.id)) {
            return;
          }

          const localActivity = localById.get(remoteActivity.id);
          if (
            !localActivity
            || Date.parse(remoteActivity.updatedAt) >= Date.parse(localActivity.updatedAt)
          ) {
            activitiesStore.put({
              ...remoteActivity,
              syncedAt: remoteActivity.updatedAt,
            });
          } else if (localActivity.syncedAt) {
            queueActivityChange(
              queueStore,
              localActivity.id,
              "update",
              localActivity,
              localActivity.updatedAt,
            );
          }
        });

        activities.forEach((localActivity) => {
          if (queuedIds.has(localActivity.id) || remoteById.has(localActivity.id)) {
            return;
          }

          const deletedAt = tombstones[localActivity.id];
          if (deletedAt) {
            if (Date.parse(deletedAt) >= Date.parse(localActivity.updatedAt)) {
              activitiesStore.delete(localActivity.id);
            } else if (localActivity.syncedAt) {
              queueActivityChange(
                queueStore,
                localActivity.id,
                "update",
                localActivity,
                localActivity.updatedAt,
              );
            }
          } else if (localActivity.syncedAt) {
            queueActivityChange(
              queueStore,
              localActivity.id,
              "create",
              localActivity,
              localActivity.updatedAt,
            );
          }
        });
      };

      activitiesRequest.onsuccess = () => {
        activities = activitiesRequest.result;
        reconcile();
      };
      queueRequest.onsuccess = () => {
        queue = queueRequest.result;
        reconcile();
      };
    },
  );
}

/**
 * Updates an existing activity and its queued operation in one transaction.
 * @param {string} id
 * @param {Partial<{title: string, description: string, date: string, priority: string, status: string, reminderNotifiedAt: string|null}>} updates
 */
export function updateActivity(id, updates) {
  return runTransaction(
    [ACTIVITY_STORE, SYNC_QUEUE_STORE],
    "readwrite",
    (transaction, _setResult, setError) => {
      const activities = transaction.objectStore(ACTIVITY_STORE);
      const activityRequest = activities.get(id);
      activityRequest.onsuccess = () => {
        const currentActivity = activityRequest.result;

        if (!currentActivity) {
          setError(new Error("La actividad que intentas actualizar ya no existe."));
          transaction.abort();
          return;
        }

        const editableUpdates = {};
        ["title", "description", "date", "priority", "status", "reminderNotifiedAt"]
          .forEach((key) => {
            if (key in updates) {
              editableUpdates[key] = updates[key];
            }
          });

        if (
          "status" in editableUpdates
          && !["pending", "completed"].includes(editableUpdates.status)
        ) {
          setError(new Error("El estado seleccionado no es válido."));
          transaction.abort();
          return;
        }

        if (
          "title" in editableUpdates
          || "description" in editableUpdates
          || "date" in editableUpdates
          || "priority" in editableUpdates
        ) {
          try {
            Object.assign(
              editableUpdates,
              validateActivityData({
                ...currentActivity,
                ...editableUpdates,
              }),
            );
          } catch (error) {
            setError(error);
            transaction.abort();
            return;
          }
        }

        if ("date" in editableUpdates && editableUpdates.date !== currentActivity.date) {
          editableUpdates.reminderNotifiedAt = null;
        }

        const now = new Date().toISOString();
        const updatedActivity = {
          ...currentActivity,
          ...editableUpdates,
          id: currentActivity.id,
          createdAt: currentActivity.createdAt,
          updatedAt: now,
        };
        activities.put(updatedActivity);
        queueActivityChange(
          transaction.objectStore(SYNC_QUEUE_STORE),
          id,
          "update",
          updatedActivity,
          now,
        );
      };
    },
  );
}

/** Deletes an activity locally and queues a tombstone for the backend. */
export function deleteActivity(id) {
  return runTransaction(
    [ACTIVITY_STORE, SYNC_QUEUE_STORE],
    "readwrite",
    (transaction, _setResult, setError) => {
      const activities = transaction.objectStore(ACTIVITY_STORE);
      const request = activities.get(id);
      request.onsuccess = () => {
        if (!request.result) {
          setError(new Error("La actividad que intentas eliminar ya no existe."));
          transaction.abort();
          return;
        }

        const timestamp = new Date().toISOString();
        activities.delete(id);
        queueActivityChange(
          transaction.objectStore(SYNC_QUEUE_STORE),
          id,
          "delete",
          null,
          timestamp,
        );
      };
    },
  );
}

/** Records that the due-time reminder has already been displayed. */
export function markActivityReminderNotified(id) {
  return runTransaction([ACTIVITY_STORE], "readwrite", (transaction) => {
    const activities = transaction.objectStore(ACTIVITY_STORE);
    const request = activities.get(id);
    request.onsuccess = () => {
      if (request.result) {
        activities.put({
          ...request.result,
          reminderNotifiedAt: new Date().toISOString(),
        });
      }
    };
  });
}

import {
  addActivity,
  deleteActivity,
  getActivities,
  getSyncQueue,
  markActivityReminderNotified,
  queueUntrackedActivities,
  acknowledgeSyncOperation,
  reconcileRemoteSnapshot,
  updateActivity,
} from "./db.js";
import { API_BASE_URL } from "./config.js";

const dialog = document.querySelector("#activity-dialog");
const form = document.querySelector("#activity-form");
const statusMessage = document.querySelector("#app-status");
const addActivityButton = document.querySelector("#add-activity");
const firstField = document.querySelector("#activity-title");
const pendingList = document.querySelector("#pending-list");
const completedList = document.querySelector("#completed-list");
const saveButton = document.querySelector("#save-activity");
const connectionStatus = document.querySelector("#connection-status");
const connectionLabel = document.querySelector("#connection-label");
const notificationPermissionStatus = document.querySelector("#notification-permission-status");
const enableNotificationsButton = document.querySelector("#enable-notifications");
const testNotificationButton = document.querySelector("#test-notification");
const syncPanel = document.querySelector("#sync-panel");
const syncStateIcon = document.querySelector("#sync-state-icon");
const syncStateLabel = document.querySelector("#sync-state-label");
const syncStateMessage = document.querySelector("#sync-state-message");
const syncPendingCount = document.querySelector("#sync-pending-count");
const syncNowButton = document.querySelector("#sync-now");

const fields = {
  title: document.querySelector("#activity-title"),
  description: document.querySelector("#activity-description"),
  date: document.querySelector("#activity-date"),
  priority: document.querySelector("#activity-priority"),
};

const priorityLabels = {
  high: "Alta prioridad",
  medium: "Prioridad media",
  low: "Prioridad baja",
};
let editingActivityId = null;
let toastTimeout;
let serviceWorkerRegistrationStarted = false;
let serviceWorkerRegistrationPromise = null;
let reminderIntervalId = null;
let reminderCheckInProgress = false;
let synchronizationPromise = null;
let retryTimerId = null;
let retryDelay = 1000;
const remindersShownThisSession = new Set();

function showStatus(message) {
  statusMessage.textContent = message;
  statusMessage.classList.add("is-visible");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => {
    statusMessage.classList.remove("is-visible");
  }, 3600);
}

function reportError(action, error) {
  console.error(`TaskFlow: ${action}`, error);
  const details = error instanceof Error ? error.message : String(error);
  showStatus(`${action}: ${details}`);
}

function setFormMode(activity = null) {
  editingActivityId = activity?.id ?? null;
  document.querySelector("#dialog-eyebrow").textContent = activity
    ? "EDITAR ACTIVIDAD"
    : "NUEVA ACTIVIDAD";
  document.querySelector("#dialog-title").textContent = activity
    ? "Actualiza los detalles"
    : "Haz espacio para lo importante";
  document.querySelector("#form-note").textContent = activity
    ? "Los cambios se guardarán en este dispositivo."
    : "Tu actividad se guardará en este dispositivo.";
  saveButton.textContent = activity ? "Guardar cambios" : "Guardar actividad";

  if (activity) {
    fields.title.value = activity.title;
    fields.description.value = activity.description;
    fields.date.value = activity.date;
    fields.priority.value = activity.priority;
  } else {
    form.reset();
  }
}

function openActivityForm(activity = null) {
  setFormMode(activity);
  if (!dialog.open) {
    dialog.showModal();
  }
  firstField.focus();
}

function closeActivityForm() {
  if (dialog.open) {
    dialog.close();
  }
  form.reset();
  editingActivityId = null;
}

function formatActivityDate(value) {
  if (!value) {
    return "Sin fecha";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const options = value.includes("T")
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" };
  return new Intl.DateTimeFormat("es", options).format(date);
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function createActivityCard(activity) {
  const isCompleted = activity.status === "completed";
  const card = createElement(
    "article",
    `activity-card${isCompleted ? " is-completed" : ""}`,
  );
  const statusButton = createElement(
    "button",
    isCompleted ? "task-check is-checked" : "task-check",
    isCompleted ? "✓" : "",
  );
  statusButton.type = "button";
  statusButton.setAttribute(
    "aria-label",
    isCompleted ? `Marcar "${activity.title}" como pendiente` : `Completar "${activity.title}"`,
  );
  statusButton.addEventListener("click", () => toggleActivityStatus(activity));

  const copy = createElement("div", "activity-copy");
  copy.append(createElement("h3", "", activity.title));
  copy.append(createElement("p", "", activity.description || "Sin descripción."));

  const meta = createElement("div", "activity-meta");
  const date = createElement("span", "meta-item", `◷ ${formatActivityDate(activity.date)}`);
  const priority = createElement(
    "span",
    `priority priority-${activity.priority}`,
    priorityLabels[activity.priority] ?? "Prioridad media",
  );
  meta.append(date, priority);
  copy.append(meta);

  const actions = createElement("div", "activity-actions");
  const editButton = createElement("button", "more-button", "✎");
  editButton.type = "button";
  editButton.setAttribute("aria-label", `Editar ${activity.title}`);
  editButton.addEventListener("click", () => openActivityForm(activity));

  const deleteButton = createElement("button", "more-button delete-button", "×");
  deleteButton.type = "button";
  deleteButton.setAttribute("aria-label", `Eliminar ${activity.title}`);
  deleteButton.addEventListener("click", () => removeActivity(activity));
  actions.append(editButton, deleteButton);

  card.append(statusButton, copy, actions);
  return card;
}

function renderActivities(activities) {
  const pending = activities.filter((activity) => activity.status !== "completed");
  const completed = activities.filter((activity) => activity.status === "completed");

  document.querySelector("#total-count").textContent = String(activities.length);
  document.querySelector("#pending-count").textContent = String(pending.length);
  document.querySelector("#completed-count").textContent = String(completed.length);
  document.querySelector("#pending-section-count").textContent = String(pending.length).padStart(2, "0");
  document.querySelector("#completed-section-count").textContent = String(completed.length).padStart(2, "0");

  pendingList.replaceChildren();
  completedList.replaceChildren();

  if (pending.length === 0) {
    pendingList.append(createElement("p", "empty-state", "No tienes actividades pendientes. Agrega una para empezar."));
  } else {
    pending.forEach((activity) => pendingList.append(createActivityCard(activity)));
  }

  if (completed.length === 0) {
    completedList.append(createElement("p", "empty-state", "Aún no tienes actividades completadas."));
  } else {
    completed.forEach((activity) => completedList.append(createActivityCard(activity)));
  }
}

async function refreshActivities() {
  const activities = await getActivities();
  renderActivities(activities);
  if (window.Notification?.permission === "granted") {
    startReminderMonitoring();
  }
}

function updateSyncPanel(state, message, pendingCount, busy = false) {
  const labels = {
    idle: "Sincronización lista",
    syncing: "Sincronizando",
    offline: "Sin conexión",
    error: "Sincronización pendiente",
    success: "Todo sincronizado",
  };
  syncPanel.classList.toggle("is-syncing", state === "syncing");
  syncPanel.classList.toggle("is-error", state === "error");
  syncStateIcon.textContent = state === "success" ? "✓" : state === "error" ? "!" : "↻";
  syncStateLabel.textContent = labels[state] ?? labels.idle;
  syncStateMessage.textContent = message;
  syncPendingCount.textContent = `${pendingCount} ${pendingCount === 1 ? "pendiente" : "pendientes"}`;
  syncNowButton.disabled = busy || !navigator.onLine;
}

async function updatePendingQueueCount(state, message) {
  try {
    const queue = await getSyncQueue();
    updateSyncPanel(state, message, queue.length, state === "syncing");
    return queue.length;
  } catch (error) {
    reportError("No se pudo consultar la cola de sincronización", error);
    return null;
  }
}

async function requestApi(path, options = {}) {
  const response = await fetch(new URL(path, API_BASE_URL), {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`La API respondió con un formato inválido (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(result.message ?? result.error ?? `Error HTTP ${response.status}.`);
  }
  return result;
}

async function sendSyncOperation(operation) {
  const payload = JSON.stringify(operation.payload ?? { updatedAt: operation.timestamp });
  let result;

  if (operation.type === "create") {
    result = await requestApi("activities", { method: "POST", body: payload });
  } else if (operation.type === "update") {
    result = await requestApi(
      `activities/${encodeURIComponent(operation.activityId)}`,
      { method: "PUT", body: payload },
    );
  } else if (operation.type === "delete") {
    result = await requestApi(
      `activities/${encodeURIComponent(operation.activityId)}`,
      { method: "DELETE", body: payload },
    );
  } else {
    throw new Error(`Tipo de operación de sincronización desconocido: ${operation.type}`);
  }

  if (operation.type === "delete") {
    if (
      result.id !== operation.activityId
      || (result.deleted !== true && !(result.deleted === false && result.activity?.id === operation.activityId))
    ) {
      throw new Error("El backend no confirmó la eliminación.");
    }
  } else if (
    result.deleted !== true
    && result.activity?.id !== operation.activityId
  ) {
    throw new Error("El backend no confirmó la actividad enviada.");
  }

  return result;
}

async function pushPendingOperations() {
  let sentOperations = 0;
  while (true) {
    const operations = await getSyncQueue();
    if (operations.length === 0) {
      return sentOperations;
    }

    for (const operation of operations) {
      const confirmation = await sendSyncOperation(operation);
      await acknowledgeSyncOperation(operation.id, confirmation);
      sentOperations += 1;
      const remaining = await getSyncQueue();
      updateSyncPanel(
        "syncing",
        "El servidor confirmó un cambio.",
        remaining.length,
        true,
      );
    }
  }
}

function scheduleSynchronizationRetry() {
  if (retryTimerId !== null || !navigator.onLine) {
    return;
  }

  retryTimerId = window.setTimeout(() => {
    retryTimerId = null;
    synchronizeActivities();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 60_000);
}

function synchronizeActivities({ manual = false } = {}) {
  if (synchronizationPromise) {
    return synchronizationPromise;
  }

  if (retryTimerId !== null && manual) {
    window.clearTimeout(retryTimerId);
    retryTimerId = null;
  }

  synchronizationPromise = (async () => {
    let pendingCount = await updatePendingQueueCount(
      navigator.onLine ? "syncing" : "offline",
      navigator.onLine ? "Preparando cambios locales para el servidor." : "Los cambios se conservan en este dispositivo.",
    );

    if (!navigator.onLine) {
      updateSyncPanel(
        "offline",
        "Se sincronizará cuando vuelva la conexión.",
        pendingCount ?? 0,
      );
      return;
    }

    updateSyncPanel("syncing", "Enviando cambios y consultando el estado remoto.", pendingCount ?? 0, true);
    syncNowButton.disabled = true;

    try {
      await queueUntrackedActivities();
      let sentOperations = 0;
      let remainingOperations = 0;

      for (let pass = 0; pass < 3; pass += 1) {
        sentOperations += await pushPendingOperations();
        const snapshot = await requestApi("activities?includeDeleted=true");

        if (!snapshot || !Array.isArray(snapshot.activities) || typeof snapshot.deleted !== "object") {
          throw new Error("El backend devolvió una lista de actividades inválida.");
        }

        await reconcileRemoteSnapshot(snapshot);
        const queue = await getSyncQueue();
        remainingOperations = queue.length;
        if (remainingOperations === 0) {
          break;
        }
      }

      if (remainingOperations > 0) {
        throw new Error("Quedaron cambios locales por sincronizar. Se volverá a intentar.");
      }

      await refreshActivities();
      pendingCount = await updatePendingQueueCount(
        "success",
        "Las actividades de este dispositivo coinciden con el backend.",
      );
      retryDelay = 1000;
      if (retryTimerId !== null) {
        window.clearTimeout(retryTimerId);
        retryTimerId = null;
      }
      if (manual || sentOperations > 0) {
        showStatus("Sincronización completada con el servidor.");
      }
    } catch (error) {
      pendingCount = await updatePendingQueueCount(
        "error",
        `${error.message} Los cambios permanecen en la cola local.`,
      );
      console.error("TaskFlow: sincronización con el backend fallida.", error);
      showStatus("No se pudo sincronizar. Tus cambios siguen guardados en este dispositivo.");
      scheduleSynchronizationRetry();
    } finally {
      syncNowButton.disabled = !navigator.onLine;
    }
  })().finally(() => {
    synchronizationPromise = null;
  });

  return synchronizationPromise;
}

function queueSynchronization() {
  updatePendingQueueCount(
    navigator.onLine ? "idle" : "offline",
    navigator.onLine ? "Cambio guardado localmente; esperando sincronización." : "Cambio guardado localmente; se enviará al recuperar la conexión.",
  );
  if (navigator.onLine) {
    synchronizeActivities();
  }
}

async function toggleActivityStatus(activity) {
  const status = activity.status === "completed" ? "pending" : "completed";

  try {
    await updateActivity(activity.id, { status });
    queueSynchronization();
  } catch (error) {
    reportError("No se pudo cambiar el estado", error);
    return;
  }

  try {
    await refreshActivities();
  } catch (error) {
    reportError("El estado se guardó, pero no se pudo actualizar la lista", error);
    return;
  }

  showStatus(status === "completed" ? "Actividad completada." : "Actividad marcada como pendiente.");
}

async function removeActivity(activity) {
  const confirmed = window.confirm(`¿Quieres eliminar "${activity.title}"? Esta acción no se puede deshacer.`);
  if (!confirmed) {
    return;
  }

  try {
    await deleteActivity(activity.id);
    queueSynchronization();
  } catch (error) {
    reportError("No se pudo eliminar la actividad", error);
    return;
  }

  try {
    await refreshActivities();
  } catch (error) {
    reportError("La actividad se eliminó, pero no se pudo actualizar la lista", error);
    return;
  }

  showStatus("Actividad eliminada.");
}

addActivityButton.addEventListener("click", () => openActivityForm());
document.querySelectorAll("[data-open-form]").forEach((button) => {
  button.addEventListener("click", () => openActivityForm());
});
document.querySelectorAll("[data-close-form]").forEach((button) => {
  button.addEventListener("click", closeActivityForm);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = fields.title.value.trim();

  if (!title) {
    fields.title.setCustomValidity("Escribe un título para la actividad.");
    fields.title.reportValidity();
    return;
  }
  fields.title.setCustomValidity("");

  const activityData = {
    title,
    description: fields.description.value.trim(),
    date: fields.date.value,
    priority: fields.priority.value,
  };
  const isEditing = editingActivityId !== null;
  const activityId = editingActivityId;
  saveButton.disabled = true;

  try {
    if (isEditing) {
      await updateActivity(activityId, activityData);
    } else {
      await addActivity(activityData);
    }
    queueSynchronization();
  } catch (error) {
    reportError("No se pudo guardar la actividad", error);
    return;
  } finally {
    saveButton.disabled = false;
  }

  closeActivityForm();
  try {
    await refreshActivities();
  } catch (error) {
    reportError("La actividad se guardó, pero no se pudo actualizar la lista", error);
    return;
  }
  showStatus(isEditing ? "Actividad actualizada." : "Actividad agregada.");
});

fields.title.addEventListener("input", () => {
  fields.title.setCustomValidity("");
});

function updateNotificationPermissionUI() {
  const notificationsSupported = "Notification" in window;
  const serviceWorkersSupported = "serviceWorker" in navigator && window.isSecureContext;

  if (!notificationsSupported) {
    notificationPermissionStatus.textContent = "Este navegador no admite notificaciones.";
    enableNotificationsButton.disabled = true;
    testNotificationButton.disabled = true;
    return;
  }

  if (!serviceWorkersSupported) {
    notificationPermissionStatus.textContent = "Las notificaciones requieren Service Workers en HTTPS o localhost.";
    enableNotificationsButton.disabled = true;
    testNotificationButton.disabled = true;
    return;
  }

  switch (Notification.permission) {
    case "granted":
      notificationPermissionStatus.textContent = "Activadas. Recibirás recordatorios mientras TaskFlow esté abierta.";
      enableNotificationsButton.disabled = true;
      testNotificationButton.disabled = false;
      break;
    case "denied":
      notificationPermissionStatus.textContent = "Permiso rechazado. Puedes cambiarlo desde la configuración del sitio en el navegador.";
      enableNotificationsButton.disabled = true;
      testNotificationButton.disabled = true;
      break;
    default:
      notificationPermissionStatus.textContent = "Pendiente de permiso. Actívalas para recibir recordatorios.";
      enableNotificationsButton.disabled = false;
      testNotificationButton.disabled = true;
  }
}

async function showTaskNotification(body, tag, target) {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    throw new Error("Las notificaciones no tienen permiso.");
  }
  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    throw new Error("Las notificaciones requieren Service Workers en HTTPS o localhost.");
  }

  const registeredServiceWorker = await registerServiceWorker();
  if (!registeredServiceWorker) {
    throw new Error("El Service Worker no está disponible.");
  }
  const registration = await navigator.serviceWorker.ready;
  const options = {
    body,
    icon: new URL("./icons/taskflow.svg", document.baseURI).href,
    badge: new URL("./icons/taskflow.svg", document.baseURI).href,
    tag,
    renotify: false,
    data: { url: new URL(target, document.baseURI).href },
  };

  if ("vibrate" in navigator && typeof navigator.vibrate === "function") {
    options.vibrate = [180, 90, 180];
  }

  await registration.showNotification("TaskFlow", options);
}

async function checkDueReminders() {
  if (
    reminderCheckInProgress
    || !("Notification" in window)
    || Notification.permission !== "granted"
    || !("serviceWorker" in navigator)
  ) {
    return;
  }

  reminderCheckInProgress = true;
  try {
    const activities = await getActivities();
    const now = Date.now();

    for (const activity of activities) {
      if (
        activity.status !== "pending"
        || !activity.date
        || activity.reminderNotifiedAt
        || remindersShownThisSession.has(activity.id)
      ) {
        continue;
      }

      const dueTime = new Date(activity.date).getTime();
      if (!Number.isFinite(dueTime) || dueTime > now) {
        continue;
      }

      const description = activity.description || "Es hora de realizar esta actividad.";
      try {
        await showTaskNotification(
          `${activity.title}: ${description}`,
          `taskflow-reminder-${activity.id}`,
          "./#pending",
        );
        remindersShownThisSession.add(activity.id);
        await markActivityReminderNotified(activity.id);
      } catch (error) {
        reportError(`No se pudo enviar el recordatorio de "${activity.title}"`, error);
      }
    }
  } catch (error) {
    reportError("No se pudieron comprobar los recordatorios", error);
  } finally {
    reminderCheckInProgress = false;
  }
}

function startReminderMonitoring() {
  if (reminderIntervalId !== null) {
    return;
  }

  checkDueReminders();
  reminderIntervalId = window.setInterval(checkDueReminders, 30_000);
}

async function handleEnableNotifications() {
  if (!("Notification" in window)) {
    updateNotificationPermissionUI();
    return;
  }

  try {
    // Permission prompts must only be initiated from this explicit user action.
    const permission = await Notification.requestPermission();
    updateNotificationPermissionUI();

    if (permission === "granted") {
      startReminderMonitoring();
      showStatus("Notificaciones activadas.");
    } else if (permission === "denied") {
      showStatus("Permiso de notificaciones rechazado. Puedes cambiarlo en la configuración del sitio.");
    } else {
      showStatus("El permiso de notificaciones sigue pendiente.");
    }
  } catch (error) {
    reportError("No se pudo solicitar el permiso de notificaciones", error);
    updateNotificationPermissionUI();
  }
}

async function handleTestNotification() {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    updateNotificationPermissionUI();
    showStatus("Activa las notificaciones antes de probarlas.");
    return;
  }

  testNotificationButton.disabled = true;
  try {
    await showTaskNotification(
      "Esta es una notificación de prueba. Tus recordatorios aparecerán aquí.",
      `taskflow-test-${Date.now()}`,
      "./#notification-settings",
    );
    showStatus("Notificación de prueba enviada.");
  } catch (error) {
    reportError("No se pudo mostrar la notificación de prueba", error);
  } finally {
    updateNotificationPermissionUI();
  }
}

async function initialize() {
  try {
    await refreshActivities();
  } catch (error) {
    pendingList.replaceChildren(createElement("p", "empty-state", "No se pudieron cargar las actividades."));
    completedList.replaceChildren(createElement("p", "empty-state", "No se pudieron cargar las actividades."));
    reportError("No se pudieron cargar las actividades", error);
  }
  synchronizeActivities();
}

function updateConnectionStatus() {
  const isOnline = navigator.onLine;
  connectionStatus.classList.toggle("is-offline", !isOnline);
  connectionLabel.textContent = isOnline ? "En línea" : "Sin conexión";
  connectionStatus.setAttribute(
    "aria-label",
    isOnline ? "Estado de conexión: en línea" : "Estado de conexión: sin conexión",
  );
}

function handleOnline() {
  updateConnectionStatus();
  synchronizeActivities();
}

function handleOffline() {
  updateConnectionStatus();
  updatePendingQueueCount(
    "offline",
    "Se sincronizará cuando vuelva la conexión.",
  );
}

async function registerServiceWorker() {
  if (serviceWorkerRegistrationStarted) {
    return serviceWorkerRegistrationPromise;
  }
  serviceWorkerRegistrationStarted = true;

  if (!("serviceWorker" in navigator)) {
    showStatus("Este navegador no admite Service Workers.");
    return null;
  }

  if (!window.isSecureContext) {
    showStatus("El modo offline requiere HTTPS o localhost.");
    return null;
  }

  if (!navigator.onLine && navigator.serviceWorker.controller) {
    serviceWorkerRegistrationPromise = navigator.serviceWorker.ready;
    return serviceWorkerRegistrationPromise;
  }

  serviceWorkerRegistrationPromise = navigator.serviceWorker.register("./sw.js").catch((error) => {
    reportError("No se pudo activar el modo sin conexión", error);
    return null;
  });
  return serviceWorkerRegistrationPromise;
}

enableNotificationsButton.addEventListener("click", handleEnableNotifications);
testNotificationButton.addEventListener("click", handleTestNotification);
syncNowButton.addEventListener("click", () => synchronizeActivities({ manual: true }));
window.addEventListener("focus", updateNotificationPermissionUI);
document.addEventListener("visibilitychange", () => {
  updateNotificationPermissionUI();
  if (!document.hidden && "Notification" in window && Notification.permission === "granted") {
    checkDueReminders();
  }
});

updateConnectionStatus();
updateNotificationPermissionUI();
window.addEventListener("online", handleOnline);
window.addEventListener("offline", handleOffline);

initialize();
if (document.readyState === "complete") {
  registerServiceWorker();
} else {
  window.addEventListener("load", registerServiceWorker, { once: true });
}

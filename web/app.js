import { createClient } from "@supabase/supabase-js";

const STORAGE_KEY = "builder-desk-records-v1";
const HOME_VILLAGE = "Home Village";
const NIGHT_VILLAGE = "Night Village";
const TABLE_NAME = "builder_timers";
const SUPABASE_COLUMNS = "id, account, village, builder_number, finish_at, discord_alert_enabled, discord_alert_sent_at, discord_alert_claimed_at";
const config = import.meta.env ?? {};
const supabaseUrl = (config.VITE_SUPABASE_URL?.trim() ?? "")
  .replace(/\/+$/, "")
  .replace(/\/rest\/v1$/i, "");
const supabaseKey = config.VITE_SUPABASE_ANON_KEY?.trim() ?? "";
const isExampleConfig = /your-project-id|your-public-anon-key/i.test(`${supabaseUrl} ${supabaseKey}`);
const supabase = supabaseUrl && supabaseKey && !isExampleConfig
  ? createClient(supabaseUrl, supabaseKey)
  : null;

const elements = {
  accountInput: document.querySelector("#accountInput"),
  builderCountInput: document.querySelector("#builderCountInput"),
  addForm: document.querySelector("#addForm"),
  addStatus: document.querySelector("#addStatus"),
  villageFilter: document.querySelector("#villageFilter"),
  accountFilter: document.querySelector("#accountFilter"),
  showAllButton: document.querySelector("#showAllButton"),
  builderRows: document.querySelector("#builderRows"),
  emptyState: document.querySelector("#emptyState"),
  resultCount: document.querySelector("#resultCount"),
  activeCount: document.querySelector("#activeCount"),
  readyCount: document.querySelector("#readyCount"),
  accountCount: document.querySelector("#accountCount"),
  todayLabel: document.querySelector("#todayLabel"),
  editorEmpty: document.querySelector("#editorEmpty"),
  editorContent: document.querySelector("#editorContent"),
  editorVillage: document.querySelector("#editorVillage"),
  editorName: document.querySelector("#editorName"),
  editorAccount: document.querySelector("#editorAccount"),
  editorTimeLeft: document.querySelector("#editorTimeLeft"),
  durationInput: document.querySelector("#durationInput"),
  saveTimeButton: document.querySelector("#saveTimeButton"),
  markDoneButton: document.querySelector("#markDoneButton"),
  removeButton: document.querySelector("#removeButton"),
  editorStatus: document.querySelector("#editorStatus"),
  importButton: document.querySelector("#importButton"),
  exportButton: document.querySelector("#exportButton"),
  csvFile: document.querySelector("#csvFile"),
  storageLabel: document.querySelector("#storageLabel"),
  webhookSettingsButton: document.querySelector("#webhookSettingsButton"),
  webhookDialog: document.querySelector("#webhookDialog"),
  closeWebhookDialog: document.querySelector("#closeWebhookDialog"),
  webhookLockPanel: document.querySelector("#webhookLockPanel"),
  webhookAdminPassword: document.querySelector("#webhookAdminPassword"),
  unlockWebhooksButton: document.querySelector("#unlockWebhooksButton"),
  webhookManager: document.querySelector("#webhookManager"),
  webhookAccountSelect: document.querySelector("#webhookAccountSelect"),
  refreshWebhookAccountsButton: document.querySelector("#refreshWebhookAccountsButton"),
  webhookForm: document.querySelector("#webhookForm"),
  webhookSaveButton: document.querySelector("#webhookSaveButton"),
  webhookUrlInput: document.querySelector("#webhookUrlInput"),
  deleteWebhookButton: document.querySelector("#deleteWebhookButton"),
  lockWebhooksButton: document.querySelector("#lockWebhooksButton"),
  webhookStatus: document.querySelector("#webhookStatus"),
};

let builders = loadBuilders();
let selectedId = null;
let remoteReady = !supabase;
let webhookAdminPassword = "";
let webhookAccounts = [];

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function loadBuilders() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(stored)) return [];
    return stored.filter((row) => row && row.account && row.builder && Number.isFinite(Date.parse(row.finishAt)));
  } catch {
    return [];
  }
}

function saveBuilders() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(builders));
    return true;
  } catch {
    setAddStatus("Could not save in this browser. Check available storage space.", true);
    return false;
  }
}

function fromSupabaseRow(row) {
  return {
    id: row.id,
    account: row.account,
    village: row.village,
    builder: String(row.builder_number),
    finishAt: row.finish_at,
    discordAlertEnabled: row.discord_alert_enabled,
    discordAlertSentAt: row.discord_alert_sent_at,
    discordAlertClaimedAt: row.discord_alert_claimed_at,
  };
}

function toSupabaseRow(row) {
  return {
    account: row.account,
    village: row.village,
    builder_number: Number(row.builder),
    finish_at: row.finishAt,
    discord_alert_enabled: row.discordAlertEnabled ?? !finishIsDone(row),
    discord_alert_sent_at: row.discordAlertSentAt ?? null,
    discord_alert_claimed_at: row.discordAlertClaimedAt ?? null,
  };
}

async function fetchSupabaseBuilders() {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select(SUPABASE_COLUMNS)
    .order("account")
    .order("village")
    .order("builder_number");
  if (error) throw error;
  return data.map(fromSupabaseRow);
}

async function upsertSupabaseBuilders(rows) {
  if (!rows.length) return [];
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .upsert(rows.map(toSupabaseRow), { onConflict: "account,village,builder_number" })
    .select(SUPABASE_COLUMNS);
  if (error) throw error;
  return data.map(fromSupabaseRow);
}

function setAddStatus(message, isError = false) {
  elements.addStatus.textContent = message;
  elements.addStatus.classList.toggle("error", isError);
}

function setEditorStatus(message, isError = false) {
  elements.editorStatus.textContent = message;
  elements.editorStatus.classList.toggle("error", isError);
}

function setWebhookStatus(message, isError = false) {
  elements.webhookStatus.textContent = message;
  elements.webhookStatus.classList.toggle("error", isError);
}

async function callWebhookSettings(action, fields = {}) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const response = await fetch(`${supabaseUrl}/functions/v1/discord-webhook-settings`, {
    method: "POST",
    headers: {
      apikey: supabaseKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, adminPassword: webhookAdminPassword, ...fields }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function refreshWebhookAccountOptions(selectedAccount = "") {
  elements.webhookAccountSelect.replaceChildren(new Option("Choose a builder account", ""));
  for (const { account, webhookConfigured } of webhookAccounts) {
    const state = webhookConfigured ? "webhook saved" : "not set";
    elements.webhookAccountSelect.add(new Option(`${account} · ${state}`, account));
  }
  elements.webhookAccountSelect.value = selectedAccount;
  const selected = webhookAccounts.find((item) => normalize(item.account) === normalize(selectedAccount));
  elements.deleteWebhookButton.hidden = !selected?.webhookConfigured;
  elements.webhookSaveButton.disabled = !selectedAccount;
}

async function reloadWebhookAccounts(preferredAccount = "") {
  const result = await callWebhookSettings("list");
  webhookAccounts = Array.isArray(result.accounts) ? result.accounts : [];
  if (preferredAccount && !webhookAccounts.some((item) => normalize(item.account) === normalize(preferredAccount))) {
    webhookAccounts.push({ account: preferredAccount, webhookConfigured: true });
  }
  refreshWebhookAccountOptions(preferredAccount);
}

function lockWebhookSettings() {
  webhookAdminPassword = "";
  webhookAccounts = [];
  elements.webhookAdminPassword.value = "";
  elements.webhookUrlInput.value = "";
  elements.webhookAccountSelect.replaceChildren(new Option("Choose a builder account", ""));
  elements.webhookSaveButton.disabled = true;
  elements.deleteWebhookButton.hidden = true;
  elements.webhookManager.hidden = true;
  elements.webhookLockPanel.hidden = false;
  setWebhookStatus("");
}

async function unlockWebhookSettings() {
  const password = elements.webhookAdminPassword.value;
  if (!password) {
    setWebhookStatus("Enter the settings passcode.", true);
    return;
  }
  webhookAdminPassword = password;
  elements.unlockWebhooksButton.disabled = true;
  try {
    await reloadWebhookAccounts();
    elements.webhookAdminPassword.value = "";
    elements.webhookLockPanel.hidden = true;
    elements.webhookManager.hidden = false;
    refreshWebhookAccountOptions();
    setWebhookStatus(webhookAccounts.length
      ? `Loaded ${webhookAccounts.length} builder account${webhookAccounts.length === 1 ? "" : "s"}. Saved URLs stay hidden.`
      : "No builder accounts found yet. Add builders first, then refresh this list.");
    elements.webhookAccountSelect.focus();
  } catch (error) {
    webhookAdminPassword = "";
    setWebhookStatus(error.message, true);
  } finally {
    elements.unlockWebhooksButton.disabled = false;
  }
}

async function saveWebhookDestination(event) {
  event.preventDefault();
  const account = elements.webhookAccountSelect.value;
  const webhookUrl = elements.webhookUrlInput.value.trim();
  if (!account || !webhookUrl) {
    setWebhookStatus("Select a builder account and enter its Discord webhook URL.", true);
    return;
  }
  try {
    const result = await callWebhookSettings("save", { account, webhookUrl });
    let refreshed = true;
    try {
      await reloadWebhookAccounts(result.account);
    } catch {
      refreshed = false;
      if (!webhookAccounts.some((savedAccount) => normalize(savedAccount) === normalize(result.account))) {
        webhookAccounts.push(result.account);
      }
      refreshWebhookAccountOptions(result.account);
    }
    elements.webhookUrlInput.value = "";
    elements.webhookUrlInput.placeholder = "Paste a new URL to replace";
    setWebhookStatus(refreshed
      ? `Webhook successfully saved for ${result.account}. The URL is not shown here.`
      : `Webhook successfully saved for ${result.account}. Use Refresh accounts to reload the list.`);
  } catch (error) {
    setWebhookStatus(error.message, true);
  }
}

async function refreshWebhookAccounts() {
  elements.refreshWebhookAccountsButton.disabled = true;
  try {
    const previousSelection = elements.webhookAccountSelect.value;
    await reloadWebhookAccounts(previousSelection);
    setWebhookStatus(`Loaded ${webhookAccounts.length} builder account${webhookAccounts.length === 1 ? "" : "s"}.`);
  } catch (error) {
    setWebhookStatus(error.message, true);
  } finally {
    elements.refreshWebhookAccountsButton.disabled = false;
  }
}

async function deleteWebhookDestination() {
  const account = elements.webhookAccountSelect.value;
  if (!account) return;
  if (!window.confirm(`Remove the Discord destination for ${account}?`)) return;
  try {
    await callWebhookSettings("delete", { account });
    await reloadWebhookAccounts();
    elements.webhookAccountSelect.value = "";
    elements.webhookUrlInput.value = "";
    elements.webhookUrlInput.placeholder = "Select an account first";
    refreshWebhookAccountOptions();
    setWebhookStatus(`Removed the Discord webhook for ${account}. The builder account remains available.`);
  } catch (error) {
    setWebhookStatus(error.message, true);
  }
}

function normalize(value) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function currentVillage() {
  return document.querySelector('input[name="village"]:checked')?.value || HOME_VILLAGE;
}

function makeBuilderKey(row) {
  return [normalize(row.account), normalize(row.village), normalize(row.builder)].join("|");
}

function formatRemaining(finishAt, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((new Date(finishAt).getTime() - now) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const clock = [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
  return days ? `${days}d ${clock}` : clock;
}

function formatFinish(finishAt) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(finishAt));
}

function finishIsDone(row, now = Date.now()) {
  return new Date(row.finishAt).getTime() <= now;
}

function filteredBuilders() {
  const village = elements.villageFilter.value;
  const account = elements.accountFilter.value;
  return builders
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => (!village || row.village === village) && (!account || row.account === account))
    .sort((left, right) => {
      const accountOrder = left.row.account.localeCompare(right.row.account, undefined, { sensitivity: "base" });
      if (accountOrder) return accountOrder;
      const villageOrder = left.row.village.localeCompare(right.row.village, undefined, { sensitivity: "base" });
      if (villageOrder) return villageOrder;
      return Number(left.row.builder) - Number(right.row.builder);
    });
}

function refreshAccountFilter() {
  const currentValue = elements.accountFilter.value;
  const accounts = [...new Set(builders.map((row) => row.account))]
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
  elements.accountFilter.replaceChildren(new Option("All accounts", ""));
  for (const account of accounts) elements.accountFilter.add(new Option(account, account));
  elements.accountFilter.value = accounts.includes(currentValue) ? currentValue : "";
}

function updateOverview() {
  const now = Date.now();
  const ready = builders.filter((row) => finishIsDone(row, now)).length;
  const accounts = new Set(builders.map((row) => normalize(row.account)));
  elements.activeCount.textContent = String(builders.length - ready).padStart(2, "0");
  elements.readyCount.textContent = String(ready).padStart(2, "0");
  elements.accountCount.textContent = String(accounts.size).padStart(2, "0");
  elements.resultCount.textContent = String(filteredBuilders().length);
}

function renderRows() {
  const visible = filteredBuilders();
  elements.builderRows.replaceChildren();
  elements.emptyState.classList.toggle("visible", visible.length === 0);
  elements.resultCount.textContent = String(visible.length);

  if (selectedId && !visible.some(({ row }) => row.id === selectedId)) selectedId = null;

  const now = Date.now();
  for (const { row } of visible) {
    const isDone = finishIsDone(row, now);
    const tr = document.createElement("tr");
    tr.dataset.id = row.id;
    if (isDone) {
      tr.classList.add(row.village === NIGHT_VILLAGE ? "row-done-night" : "row-done-home");
    } else {
      tr.classList.add("row-active");
    }
    if (row.id === selectedId) tr.classList.add("selected");
    tr.setAttribute("aria-selected", String(row.id === selectedId));
    tr.addEventListener("click", () => {
      selectBuilder(row.id);
    });

    const builderCell = document.createElement("td");
    builderCell.textContent = `Builder ${row.builder}`;
    const villageCell = document.createElement("td");
    const villageChip = document.createElement("span");
    villageChip.className = `village-chip ${row.village === NIGHT_VILLAGE ? "night" : "home"}`;
    villageChip.textContent = row.village;
    villageCell.append(villageChip);
    const accountCell = document.createElement("td");
    accountCell.className = "account-cell";
    accountCell.textContent = row.account;
    const timerCell = document.createElement("td");
    timerCell.className = "timer-cell";
    timerCell.textContent = isDone ? "Done" : formatRemaining(row.finishAt, now);
    const finishCell = document.createElement("td");
    finishCell.className = "finish-cell";
    finishCell.textContent = formatFinish(row.finishAt);
    const selectCell = document.createElement("td");
    const selectButton = document.createElement("button");
    selectButton.className = "row-action";
    selectButton.type = "button";
    selectButton.setAttribute("aria-label", `Select ${row.account}, ${row.village}, builder ${row.builder}`);
    selectButton.title = "Select builder";
    selectButton.textContent = "Edit";
    selectButton.addEventListener("click", (event) => {
      event.stopPropagation();
      selectBuilder(row.id);
    });
    selectCell.append(selectButton);
    tr.append(builderCell, villageCell, accountCell, timerCell, finishCell, selectCell);
    elements.builderRows.append(tr);
  }
}

function renderEditor() {
  const row = builders.find((builder) => builder.id === selectedId);
  elements.editorEmpty.hidden = Boolean(row);
  elements.editorContent.hidden = !row;
  if (!row) return;

  const isNight = row.village === NIGHT_VILLAGE;
  elements.editorVillage.className = `village-chip ${isNight ? "night" : "home"}`;
  elements.editorVillage.textContent = row.village;
  elements.editorName.textContent = `Builder ${row.builder}`;
  elements.editorAccount.textContent = row.account;
  const isDone = finishIsDone(row);
  elements.editorTimeLeft.textContent = isDone ? "Done" : formatRemaining(row.finishAt);
  elements.markDoneButton.hidden = isDone;
}

function render() {
  updateOverview();
  renderRows();
  renderEditor();
}

function selectBuilder(id) {
  if (selectedId !== id) setEditorStatus("");
  selectedId = id;
  render();
}

async function addBuilders(event) {
  event.preventDefault();
  const account = elements.accountInput.value.trim();
  const count = Number(elements.builderCountInput.value);
  const village = currentVillage();
  if (!account) {
    setAddStatus("Enter an account name.", true);
    elements.accountInput.focus();
    return;
  }
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    setAddStatus("Choose a whole number from 1 to 20.", true);
    elements.builderCountInput.focus();
    return;
  }

  const existing = new Set(builders
    .filter((row) => normalize(row.account) === normalize(account) && row.village === village)
    .map((row) => String(row.builder)));
  const added = [];
  for (let number = 1; number <= count; number += 1) {
    const builder = String(number);
    if (existing.has(builder)) continue;
    const row = {
      id: makeId(),
      account,
      village,
      builder,
      finishAt: new Date().toISOString(),
      discordAlertEnabled: false,
      discordAlertSentAt: null,
      discordAlertClaimedAt: null,
    };
    added.push(row);
  }

  let committed = added;
  if (supabase) {
    if (!remoteReady) {
      setAddStatus("Supabase is not connected yet. Check its URL, key, and table setup.", true);
      return;
    }
    try {
      committed = await upsertSupabaseBuilders(added);
    } catch (error) {
      setAddStatus(`Could not save to Supabase: ${error.message}`, true);
      return;
    }
  }
  builders.push(...committed);
  if (!saveBuilders() && !supabase) return;
  elements.accountInput.value = "";
  elements.builderCountInput.value = "";
  elements.villageFilter.value = village;
  refreshAccountFilter();
  elements.accountFilter.value = account;
  const nextSelectedId = committed.at(-1)?.id ?? null;
  if (selectedId !== nextSelectedId) setEditorStatus("");
  selectedId = nextSelectedId;
  render();
  setAddStatus(added.length ? `Added ${added.length} ${village} builder${added.length === 1 ? "" : "s"} for ${account}.` : `Those builders already exist for ${account}.`);
}

function parseDuration(text) {
  const matcher = /(\d+)\s*([dhm])/gi;
  const parts = [...text.matchAll(matcher)];
  const residue = text.replace(matcher, "").trim();
  if (!parts.length || residue) throw new Error("Enter a time like 2d 5h 30m, or use 0m for done.");
  return parts.reduce((total, [, amount, unit]) => {
    const value = Number(amount);
    if (unit.toLowerCase() === "d") return total + value * 86400;
    if (unit.toLowerCase() === "h") return total + value * 3600;
    return total + value * 60;
  }, 0);
}

async function updateSelectedTime(markDone = false) {
  const row = builders.find((builder) => builder.id === selectedId);
  if (!row) {
    setEditorStatus("Select a builder first.", true);
    return;
  }
  try {
    const seconds = markDone ? 0 : parseDuration(elements.durationInput.value.trim());
    const finishAt = new Date(Date.now() + seconds * 1000).toISOString();
    const alertEnabled = seconds > 0;
    if (supabase) {
      if (!remoteReady) throw new Error("Supabase is not connected yet.");
      const { error } = await supabase
        .from(TABLE_NAME)
        .update({
          finish_at: finishAt,
          discord_alert_enabled: alertEnabled,
          discord_alert_sent_at: null,
          discord_alert_claimed_at: null,
        })
        .eq("id", row.id);
      if (error) throw error;
    }
    row.finishAt = finishAt;
    row.discordAlertEnabled = alertEnabled;
    row.discordAlertSentAt = null;
    row.discordAlertClaimedAt = null;
    if (!saveBuilders() && !supabase) return;
    elements.durationInput.value = "";
    setEditorStatus(markDone ? "Builder marked done." : "Timer updated.");
    render();
  } catch (error) {
    setEditorStatus(error.message, true);
  }
}

async function removeSelected() {
  const index = builders.findIndex((builder) => builder.id === selectedId);
  if (index < 0) {
    setEditorStatus("Select a builder first.", true);
    return;
  }
  const removed = builders[index];
  if (supabase) {
    if (!remoteReady) {
      setEditorStatus("Supabase is not connected yet.", true);
      return;
    }
    try {
      const { error } = await supabase.from(TABLE_NAME).delete().eq("id", removed.id);
      if (error) throw error;
    } catch (error) {
      setEditorStatus(`Could not remove builder: ${error.message}`, true);
      return;
    }
  }
  builders.splice(index, 1);
  selectedId = null;
  setEditorStatus("");
  if (!saveBuilders() && !supabase) {
    builders.splice(index, 0, removed);
    selectedId = removed.id;
    return;
  }
  refreshAccountFilter();
  render();
  setAddStatus(`Removed Builder ${removed.builder} from ${removed.account}.`);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function parseCsvFinish(value) {
  const localMatch = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (localMatch) {
    const [, year, month, day, hour, minute, second = "0"] = localMatch;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid finish time: ${value}`);
  return parsed;
}

async function importCsv(file) {
  try {
    const text = await file.text();
    if (!text.trim()) throw new Error("CSV file is empty.");
    const rows = parseCsv(text);
    const headers = rows.shift()?.map((header) => header.replace(/^\uFEFF/, "").trim().toLocaleLowerCase()) ?? [];
    const column = (name) => headers.indexOf(name.toLocaleLowerCase());
    const accountColumn = column("Account");
    const villageColumn = column("Village");
    const builderColumn = column("Builder");
    const finishColumn = column("Finish At");
    if ([accountColumn, builderColumn, finishColumn].some((index) => index < 0)) {
      throw new Error("CSV needs Account, Builder, and Finish At columns.");
    }

    const nextBuilders = builders.map((row) => ({ ...row }));
    const byKey = new Map(nextBuilders.map((row) => [makeBuilderKey(row), row]));
    let imported = 0;
    for (const cells of rows) {
      const account = (cells[accountColumn] ?? "").trim();
      const builder = (cells[builderColumn] ?? "").trim();
      const finishValue = (cells[finishColumn] ?? "").trim();
      if (!account || !builder || !finishValue) continue;
      const village = (villageColumn < 0 ? "" : cells[villageColumn] ?? "").trim() || HOME_VILLAGE;
      const finishAt = parseCsvFinish(finishValue).toISOString();
      const row = {
        id: makeId(),
        account,
        village,
        builder,
        finishAt,
        discordAlertEnabled: new Date(finishAt).getTime() > Date.now(),
        discordAlertSentAt: null,
        discordAlertClaimedAt: null,
      };
      const key = makeBuilderKey(row);
      const existing = byKey.get(key);
      if (existing) {
        existing.finishAt = row.finishAt;
        existing.discordAlertEnabled = row.discordAlertEnabled;
        existing.discordAlertSentAt = null;
        existing.discordAlertClaimedAt = null;
      } else {
        nextBuilders.push(row);
        byKey.set(key, row);
      }
      imported += 1;
    }
    if (supabase) {
      if (!remoteReady) throw new Error("Supabase is not connected yet.");
      await upsertSupabaseBuilders(nextBuilders);
      builders = await fetchSupabaseBuilders();
    } else {
      builders = nextBuilders;
      if (!saveBuilders()) return;
    }
    saveBuilders();
    refreshAccountFilter();
    render();
    setAddStatus(`Imported ${imported} builder row${imported === 1 ? "" : "s"} from ${file.name}.`);
  } catch (error) {
    setAddStatus(error.message || "Could not read that CSV file.", true);
  } finally {
    elements.csvFile.value = "";
  }
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportCsv() {
  const header = ["Account", "Village", "Builder", "Finish At"];
  const rows = builders.map((row) => [row.account, row.village, row.builder, new Date(row.finishAt).toLocaleString("sv-SE")]);
  const csv = [header, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "builder-timers.csv";
  link.click();
  URL.revokeObjectURL(url);
  setAddStatus(`Exported ${builders.length} builder row${builders.length === 1 ? "" : "s"}.`);
}

elements.addForm.addEventListener("submit", addBuilders);
elements.villageFilter.addEventListener("change", () => {
  selectedId = null;
  setEditorStatus("");
  render();
});
elements.accountFilter.addEventListener("change", () => {
  selectedId = null;
  setEditorStatus("");
  render();
});
elements.showAllButton.addEventListener("click", () => {
  elements.villageFilter.value = "";
  elements.accountFilter.value = "";
  selectedId = null;
  setEditorStatus("");
  render();
});
elements.saveTimeButton.addEventListener("click", () => updateSelectedTime());
elements.durationInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") updateSelectedTime();
});
elements.markDoneButton.addEventListener("click", () => updateSelectedTime(true));
elements.removeButton.addEventListener("click", removeSelected);
elements.importButton.addEventListener("click", () => elements.csvFile.click());
elements.csvFile.addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) importCsv(file);
});
elements.exportButton.addEventListener("click", exportCsv);
elements.webhookSettingsButton.addEventListener("click", () => {
  lockWebhookSettings();
  elements.webhookDialog.showModal();
});
elements.closeWebhookDialog.addEventListener("click", () => elements.webhookDialog.close());
elements.webhookDialog.addEventListener("close", lockWebhookSettings);
elements.unlockWebhooksButton.addEventListener("click", unlockWebhookSettings);
elements.webhookAdminPassword.addEventListener("keydown", (event) => {
  if (event.key === "Enter") unlockWebhookSettings();
});
elements.webhookAccountSelect.addEventListener("change", () => {
  const account = elements.webhookAccountSelect.value;
  const selected = webhookAccounts.find((item) => normalize(item.account) === normalize(account));
  elements.webhookUrlInput.value = "";
  elements.webhookUrlInput.placeholder = account ? "Paste a new URL to add or replace" : "Select an account first";
  refreshWebhookAccountOptions(account);
  setWebhookStatus(selected
    ? selected.webhookConfigured
      ? `A webhook is saved for ${selected.account}. Paste a URL to replace it.`
      : `No webhook is saved for ${selected.account} yet.`
    : "Select a builder account to manage its webhook.");
});
elements.webhookForm.addEventListener("submit", saveWebhookDestination);
elements.refreshWebhookAccountsButton.addEventListener("click", refreshWebhookAccounts);
elements.deleteWebhookButton.addEventListener("click", deleteWebhookDestination);
elements.lockWebhooksButton.addEventListener("click", lockWebhookSettings);

elements.todayLabel.textContent = new Intl.DateTimeFormat(undefined, {
  weekday: "short", month: "short", day: "numeric", year: "numeric",
}).format(new Date());
async function initialize() {
  if (!supabase) {
    elements.storageLabel.textContent = "LOCAL MODE";
    if ((supabaseUrl || supabaseKey) && !isExampleConfig) {
      setAddStatus("Set both Supabase environment variables to connect cloud storage.", true);
    }
    refreshAccountFilter();
    render();
    return;
  }

  elements.storageLabel.textContent = "CONNECTING";
  try {
    let remoteBuilders = await fetchSupabaseBuilders();
    if (!remoteBuilders.length && builders.length) {
      await upsertSupabaseBuilders(builders);
      remoteBuilders = await fetchSupabaseBuilders();
    }
    builders = remoteBuilders;
    remoteReady = true;
    elements.storageLabel.textContent = "SUPABASE";
    saveBuilders();
    refreshAccountFilter();
    render();
  } catch (error) {
    remoteReady = false;
    elements.storageLabel.textContent = "SUPABASE ERROR";
    setAddStatus(`Supabase connection failed: ${error.message}`, true);
    refreshAccountFilter();
    render();
  }
}

refreshAccountFilter();
render();
initialize();
window.setInterval(render, 1000);
import { createClient } from "@supabase/supabase-js";
import { HOUR, WORKDAY, HELPER_TYPES, helperKey, sharedWorkdayEnd, forecastLabAssistant, savedLabTime, remainingLabTime, labAssistantAvailability } from "./lab-assistant.js";

const STORAGE_KEY = "builder-desk-records-v1";
const ACCOUNT_ORDER_STORAGE_KEY = "builder-desk-account-order-v1";
const HOME_VILLAGE = "Home Village";
const NIGHT_VILLAGE = "Night Village";
const BUILDER_TYPE = "Builder";
const VILLAGE_BUILDER_TYPES = {
  [HOME_VILLAGE]: [BUILDER_TYPE, "Lab", "Pet House"],
  [NIGHT_VILLAGE]: [BUILDER_TYPE, "Lab"],
};
const TABLE_NAME = "builder_timers";
const SUPABASE_COLUMNS = "id, account, village, builder_type, builder_number, finish_at, discord_alert_enabled, discord_alert_sent_at, discord_alert_claimed_at";
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
  addAccountSelect: document.querySelector("#addAccountSelect"),
  builderCountInput: document.querySelector("#builderCountInput"),
  builderTypeSelect: document.querySelector("#builderTypeSelect"),
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
  accountSummary: document.querySelector("#accountSummary"),
  accountSummaryEmpty: document.querySelector("#accountSummaryEmpty"),
  accountOrderStatus: document.querySelector("#accountOrderStatus"),
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
  labAssistantPanel: document.querySelector("#labAssistantPanel"),
  labAssistantHeading: document.querySelector("#labAssistantHeading"),
  labAssistantState: document.querySelector("#labAssistantState"),
  labAssistantSaved: document.querySelector("#labAssistantSaved"),
  labAssistantSavedValue: document.querySelector("#labAssistantSavedValue"),
  labAssistantDialog: document.querySelector("#labAssistantDialog"),
  labAssistantDialogTarget: document.querySelector("#labAssistantDialogTarget"),
  labAssistantDialogTitle: document.querySelector("#labAssistantDialogTitle"),
  helperDialogEyebrow: document.querySelector("#helperDialogEyebrow"),
  helperLevelLabel: document.querySelector("#helperLevelLabel"),
  closeLabAssistantDialog: document.querySelector("#closeLabAssistantDialog"),
  labAssistantForm: document.querySelector("#labAssistantForm"),
  labAssistantStatus: document.querySelector("#labAssistantStatus"),
  labAssistantLevel: document.querySelector("#labAssistantLevel"),
  labAssistantWorkday: document.querySelector("#labAssistantWorkday"),
  labAssistantRepeat: document.querySelector("#labAssistantRepeat"),
  assignLabAssistantButton: document.querySelector("#assignLabAssistantButton"),
  stopLabAssistantButton: document.querySelector("#stopLabAssistantButton"),
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
let labAssistants = new Map();
let labAssistantsReady = !supabase;
let labAssistantSaving = false;
let accountOrder = [];
let accountOrderSaving = false;
let accountOrderReady = !supabase;
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
    const records = Array.isArray(stored) ? stored : stored.builders;
    if (!Array.isArray(records)) return [];
    return records
      .filter((row) => row && row.account && row.builder && Number.isFinite(Date.parse(row.finishAt)))
      .map((row) => ({ ...row, builderType: row.builderType || BUILDER_TYPE }));
  } catch {
    return [];
  }
}

function saveBuilders() {
  if (!labAssistantsReady) {
    setAddStatus("Helper data could not be loaded; browser data was not overwritten.", true);
    return false;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ builders, labAssistants: [...labAssistants.values()] }));
    return true;
  } catch {
    setAddStatus("Could not save in this browser. Check available storage space.", true);
    return false;
  }
}

function fromSupabaseAssistant(row) {
  if (!HELPER_TYPES[row.helper_type]) throw new Error("Run the updated Supabase setup to load helpers.");
  const timestamp = (value) => value === null ? null : new Date(value).getTime();
  return {
    accountKey: row.account_key,
    helperType: row.helper_type,
    level: row.level,
    timerId: row.timer_id,
    startedAt: timestamp(row.started_at),
    workdayEnd: timestamp(row.workday_end_at),
    workUntil: timestamp(row.work_until_at),
    nextSession: timestamp(row.next_session_at),
    baseFinish: timestamp(row.base_finish_at),
    projectedFinish: timestamp(row.projected_finish_at),
    repeat: row.keep_assigned,
    savedMs: row.saved_seconds * 1000,
  };
}

function loadLocalAssistants() {
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  if (Array.isArray(stored)) return new Map();
  if (!stored || !Array.isArray(stored.labAssistants)) throw new Error("Saved helper data is invalid.");
  return new Map(stored.labAssistants.map((assistant) => {
    const helperType = assistant.helperType ?? "Lab";
    if (!HELPER_TYPES[helperType]) throw new Error("Saved helper type is invalid.");
    return [helperKey(assistant.accountKey, helperType), { ...assistant, helperType }];
  }));
}

async function loadSupabaseAssistants() {
  const { data, error } = await supabase.from("lab_assistants").select("*");
  if (error) throw error;
  return new Map(data.map((row) => {
    const assistant = fromSupabaseAssistant(row);
    return [helperKey(assistant.accountKey, assistant.helperType), assistant];
  }));
}

function helperForRow(row) {
  return row?.village === HOME_VILLAGE ? HELPER_TYPES[row.builderType || BUILDER_TYPE] : null;
}

function assistantForRow(row) {
  return helperForRow(row)
    ? labAssistants.get(helperKey(normalize(row.account), row.builderType || BUILDER_TYPE))
    : null;
}

function hasTrackedLabAssistant(row, now = Date.now()) {
  const assistant = assistantForRow(row);
  return assistant?.timerId === row.id && assistant.projectedFinish > now;
}

function savedForLab(row, now) {
  const assistant = assistantForRow(row);
  if (assistant?.timerId !== row.id) return null;
  const finish = assistant.projectedFinish ?? assistant.baseFinish;
  return finish != null && new Date(row.finishAt).getTime() === Math.floor(finish)
    ? savedLabTime(assistant, now) : null;
}

function remainingForRow(row, now) {
  const assistant = assistantForRow(row);
  if (assistant?.projectedFinish != null && savedForLab(row, now) !== null) {
    return remainingLabTime(assistant, now);
  }
  return Math.max(0, new Date(row.finishAt).getTime() - now);
}

function canAssignLabAssistant(row, now) {
  if (!labAssistantsReady || labAssistantSaving || !helperForRow(row) || finishIsDone(row, now)) return false;
  const assistant = assistantForRow(row);
  if (assistant?.timerId !== row.id && assistant?.projectedFinish > now) return false;
  return labAssistantAvailability(assistant, now).available;
}

function fromSupabaseRow(row) {
  return {
    id: row.id,
    account: row.account,
    village: row.village,
    builderType: row.builder_type || BUILDER_TYPE,
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
    builder_type: row.builderType || BUILDER_TYPE,
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
    .upsert(rows.map(toSupabaseRow), { onConflict: "account,village,builder_type,builder_number" })
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
  for (const { account, webhookConfigured } of [...webhookAccounts].sort((left, right) => compareAccounts(left.account, right.account))) {
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

function compareAccounts(left, right) {
  const leftKey = normalize(left);
  const rightKey = normalize(right);
  if (leftKey === rightKey) return 0;
  const leftIndex = accountOrder.indexOf(leftKey);
  const rightIndex = accountOrder.indexOf(rightKey);
  if (leftIndex !== -1 || rightIndex !== -1) {
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  }
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function parseAccountOrder(value) {
  if (!Array.isArray(value) || value.some((account) => typeof account !== "string" || !account.trim())) {
    throw new Error("The saved account order is invalid.");
  }
  return [...new Set(value.map(normalize))];
}

async function loadAccountOrder() {
  if (supabase) {
    const { data, error } = await supabase.from("account_order").select("accounts").eq("id", 1).maybeSingle();
    if (error) throw error;
    return data ? parseAccountOrder(data.accounts) : [];
  }
  const stored = localStorage.getItem(ACCOUNT_ORDER_STORAGE_KEY);
  return stored === null ? [] : parseAccountOrder(JSON.parse(stored));
}

async function moveAccount(account, direction) {
  if (accountOrderSaving) return;
  if (!accountOrderReady) {
    setAccountOrderStatus("Account order is unavailable. Check the Supabase setup and reload.", true);
    return;
  }
  const accounts = [...new Set(builders.map((row) => normalize(row.account)))].sort(compareAccounts);
  const index = accounts.indexOf(normalize(account));
  const target = index + direction;
  if (index < 0 || target < 0 || target >= accounts.length) return;
  [accounts[index], accounts[target]] = [accounts[target], accounts[index]];
  const nextOrder = [...accounts, ...accountOrder.filter((key) => !accounts.includes(key))];
  accountOrderSaving = true;
  setAccountOrderStatus("Saving account order...");
  try {
    if (supabase) {
      const { error } = await supabase.from("account_order").upsert({ id: 1, accounts: nextOrder });
      if (error) throw error;
    } else {
      localStorage.setItem(ACCOUNT_ORDER_STORAGE_KEY, JSON.stringify(nextOrder));
    }
    accountOrder = nextOrder;
    refreshAccountFilter();
    refreshWebhookAccountOptions(elements.webhookAccountSelect.value);
    render();
    setAccountOrderStatus("Account order saved.");
  } catch (error) {
    setAccountOrderStatus(`Could not save account order: ${error.message}`, true);
  } finally {
    accountOrderSaving = false;
  }
}

function setAccountOrderStatus(message, isError = false) {
  elements.accountOrderStatus.textContent = message;
  elements.accountOrderStatus.classList.toggle("error", isError);
}

function currentVillage() {
  return document.querySelector('input[name="village"]:checked')?.value || HOME_VILLAGE;
}

function currentBuilderType() {
  return elements.builderTypeSelect.value || BUILDER_TYPE;
}

function refreshBuilderTypeOptions() {
  const village = currentVillage();
  const types = VILLAGE_BUILDER_TYPES[village] || VILLAGE_BUILDER_TYPES[HOME_VILLAGE];
  const selectedType = types.includes(currentBuilderType()) ? currentBuilderType() : BUILDER_TYPE;
  elements.builderTypeSelect.replaceChildren(...types.map((type) => new Option(type, type)));
  elements.builderTypeSelect.value = selectedType;
  elements.builderCountInput.placeholder = selectedType === BUILDER_TYPE ? "6" : "1";
}

function builderLabel(row) {
  const type = row.builderType || BUILDER_TYPE;
  return `${type} ${row.builder}`;
}

function makeBuilderKey(row) {
  return [normalize(row.account), normalize(row.village), normalize(row.builderType || BUILDER_TYPE), normalize(row.builder)].join("|");
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

function compareBuilderRows(left, right) {
  const accountComparison = compareAccounts(left.account, right.account);
  if (accountComparison) return accountComparison;
  const villageOrder = left.village.localeCompare(right.village, undefined, { sensitivity: "base" });
  if (villageOrder) return villageOrder;
  const typeOrder = (left.builderType || BUILDER_TYPE).localeCompare(right.builderType || BUILDER_TYPE, undefined, { sensitivity: "base" });
  if (typeOrder) return typeOrder;
  return Number(left.builder) - Number(right.builder);
}

function filteredBuilders() {
  const village = elements.villageFilter.value;
  const account = elements.accountFilter.value;
  return builders
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => (!village || row.village === village) && (!account || normalize(row.account) === normalize(account)))
    .sort((left, right) => compareBuilderRows(left.row, right.row));
}

function refreshAccountFilter() {
  const currentValue = elements.accountFilter.value;
  const selectedAccount = elements.addAccountSelect.value;
  const accounts = [...new Set(builders.map((row) => row.account))]
    .sort(compareAccounts);
  elements.accountFilter.replaceChildren(new Option("All accounts", ""));
  for (const account of accounts) elements.accountFilter.add(new Option(account, account));
  elements.accountFilter.value = accounts.includes(currentValue) ? currentValue : "";
  const uniqueAccounts = [...new Map(accounts.map((account) => [normalize(account), account])).values()];
  elements.addAccountSelect.replaceChildren(new Option("New account", ""));
  for (const account of uniqueAccounts) elements.addAccountSelect.add(new Option(account, account));
  elements.addAccountSelect.value = uniqueAccounts.find((account) => normalize(account) === normalize(selectedAccount)) || "";
  elements.accountInput.disabled = Boolean(elements.addAccountSelect.value);
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

function renderAccountSummary() {
  const accounts = new Map();
  const now = Date.now();
  for (const row of builders) {
    const key = normalize(row.account);
    if (!accounts.has(key)) {
      accounts.set(key, {
        name: row.account.trim(),
        value: row.account,
        home: { active: 0, total: 0 },
        night: { active: 0, total: 0 },
      });
    }
    const account = accounts.get(key);
    const village = row.village === NIGHT_VILLAGE ? account.night : account.home;
    village.total += 1;
    if (!finishIsDone(row, now)) village.active += 1;
  }

  const cards = document.createDocumentFragment();
  elements.accountSummaryEmpty.hidden = accounts.size > 0;
  const sortedAccounts = [...accounts.values()]
    .sort((left, right) => compareAccounts(left.name, right.name));
  for (const [index, account] of sortedAccounts.entries()) {
    const item = document.createElement("div");
    item.className = "account-summary-item";
    const card = document.createElement("button");
    card.type = "button";
    card.className = "account-summary-card";
    card.dataset.account = account.value;
    card.setAttribute("aria-pressed", String(normalize(elements.accountFilter.value) === normalize(account.value)));
    card.title = `Show all timers for ${account.name}`;
    const name = document.createElement("span");
    name.className = "account-summary-name";
    name.textContent = account.name;
    card.append(name);
    for (const [label, counts, className] of [
      ["Home", account.home, "home"],
      ["Night", account.night, "night"],
    ]) {
      const village = document.createElement("span");
      village.className = `village-chip ${className}`;
      village.textContent = `${label}: ${counts.active}/${counts.total}`;
      village.setAttribute("aria-label", `${label} Village: ${counts.active} in progress out of ${counts.total} timers`);
      card.append(village);
    }
    const controls = document.createElement("div");
    controls.className = "account-order-controls";
    for (const [direction, label, symbol, disabled] of [
      [-1, "earlier", "←", index === 0],
      [1, "later", "→", index === sortedAccounts.length - 1],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "account-order-button";
      button.dataset.account = account.value;
      button.dataset.direction = String(direction);
      button.setAttribute("aria-label", `Move ${account.name} ${label}`);
      button.title = `Move ${label}`;
      button.textContent = symbol;
      button.disabled = disabled || !accountOrderReady;
      controls.append(button);
    }
    item.append(card, controls);
    cards.append(item);
  }
  const nextCards = [...cards.children];
  const currentCards = [...elements.accountSummary.children];
  if (nextCards.length !== currentCards.length || nextCards.some((card, index) => !card.isEqualNode(currentCards[index]))) {
    const focusedAccount = elements.accountSummary.contains(document.activeElement)
      ? document.activeElement.dataset.account
      : null;
    const focusedDirection = document.activeElement.dataset?.direction;
    elements.accountSummary.replaceChildren(cards);
    if (focusedAccount !== null) {
      const buttons = nextCards.flatMap((card) => [...card.querySelectorAll("button")]);
      const focusedButton = buttons.find((button) => button.dataset.account === focusedAccount
        && button.dataset.direction === focusedDirection && !button.disabled)
        || buttons.find((button) => button.dataset.account === focusedAccount && !button.disabled);
      focusedButton?.focus({ preventScroll: true });
    }
  }
}

function renderRows() {
  const visible = filteredBuilders();
  const focused = elements.builderRows.contains(document.activeElement) ? document.activeElement : null;
  const focusedId = focused?.closest("tr")?.dataset.id;
  const focusedAction = focused?.dataset.action;
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
    const builderName = document.createElement("span");
    builderName.textContent = builderLabel(row);
    builderCell.append(builderName);
    if (canAssignLabAssistant(row, now)) {
      const assignButton = document.createElement("button");
      assignButton.type = "button";
      assignButton.className = "row-action assistant-row-action";
      assignButton.dataset.action = "assign";
      const helper = helperForRow(row);
      assignButton.textContent = helper.action;
      assignButton.setAttribute("aria-label", `Assign ${helper.name} to ${row.account}, ${builderLabel(row)}`);
      assignButton.addEventListener("click", (event) => {
        event.stopPropagation();
        openLabAssistantDialog(row.id);
      });
      builderCell.append(assignButton);
    }
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
    const saved = savedForLab(row, now);
    if (saved !== null) {
      const savedDisplay = document.createElement("span");
      savedDisplay.className = "assistant-row-saved";
      const savedLabel = document.createElement("span");
      savedLabel.className = "assistant-saved-label";
      savedLabel.textContent = "Saved: ";
      const savedValue = document.createElement("span");
      savedValue.className = "assistant-saved-value";
      savedValue.textContent = formatRemaining(saved, 0);
      savedDisplay.append(savedLabel, savedValue);
      timerCell.append(savedDisplay);
    }
    const remaining = document.createElement("span");
    remaining.textContent = isDone ? "Done" : formatRemaining(remainingForRow(row, now), 0);
    timerCell.append(remaining);
    const finishCell = document.createElement("td");
    finishCell.className = "finish-cell";
    finishCell.textContent = formatFinish(row.finishAt);
    const selectCell = document.createElement("td");
    const selectButton = document.createElement("button");
    selectButton.className = "row-action";
    selectButton.dataset.action = "select";
    selectButton.type = "button";
    selectButton.setAttribute("aria-label", `Select ${row.account}, ${row.village}, ${builderLabel(row)}`);
    selectButton.title = "Select timer";
    selectButton.textContent = "Edit";
    selectButton.addEventListener("click", (event) => {
      event.stopPropagation();
      selectBuilder(row.id);
    });
    selectCell.append(selectButton);
    tr.append(builderCell, villageCell, accountCell, timerCell, finishCell, selectCell);
    elements.builderRows.append(tr);
  }
  if (focusedId && focusedAction) {
    const row = [...elements.builderRows.rows].find((item) => item.dataset.id === focusedId);
    row?.querySelector(`[data-action="${focusedAction}"]`)?.focus({ preventScroll: true });
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
  elements.editorName.textContent = builderLabel(row);
  elements.editorAccount.textContent = row.account;
  const now = Date.now();
  const isDone = finishIsDone(row, now);
  elements.editorTimeLeft.textContent = isDone ? "Done" : formatRemaining(remainingForRow(row, now), 0);
  const saved = savedForLab(row, now);
  elements.labAssistantSaved.hidden = saved === null;
  elements.labAssistantSavedValue.textContent = saved === null ? "" : formatRemaining(saved, 0);
  elements.markDoneButton.hidden = isDone;
  renderLabAssistant(row, isDone);
}

function renderLabAssistant(row, isDone) {
  const helper = helperForRow(row);
  elements.labAssistantPanel.hidden = !helper;
  if (!helper) return;
  elements.labAssistantHeading.textContent = helper.name;
  const assistant = assistantForRow(row);
  const now = Date.now();
  const availability = labAssistantAvailability(assistant, now);
  const activePlan = assistant?.timerId && assistant.projectedFinish > now;
  const ownPlan = activePlan && assistant.timerId === row.id;
  const reserved = activePlan && assistant.repeat;
  elements.labAssistantState.textContent = !labAssistantsReady
    ? "Helper data is unavailable. Check the Supabase setup and reload."
    : activePlan && !ownPlan
      ? `${helper.name} is assigned to another timer.`
    : reserved
      ? `Kept assigned. Next workday in ${formatRemaining(availability.availableAt, now)}.`
      : availability.available
        ? `${helper.name} ready to assign.`
        : `Next available in ${formatRemaining(availability.availableAt, now)}.`;
  elements.stopLabAssistantButton.hidden = !ownPlan;
  elements.stopLabAssistantButton.disabled = labAssistantSaving;
}

function openLabAssistantDialog(id) {
  const row = builders.find((builder) => builder.id === id);
  if (!row || !canAssignLabAssistant(row, Date.now())) return;
  selectBuilder(id);
  const helper = helperForRow(row);
  const assistant = assistantForRow(row);
  elements.labAssistantDialogTitle.textContent = `Assign ${helper.name}`;
  elements.helperDialogEyebrow.textContent = `HOME VILLAGE ${row.builderType || BUILDER_TYPE}`.toUpperCase();
  elements.helperLevelLabel.textContent = `${helper.name} level (1-${helper.maxLevel})`;
  elements.labAssistantLevel.max = String(helper.maxLevel);
  elements.assignLabAssistantButton.textContent = helper.action;
  elements.labAssistantDialogTarget.textContent = `${row.account} — ${builderLabel(row)}`;
  elements.labAssistantLevel.value = String(assistant?.level ?? 1);
  elements.labAssistantWorkday.value = "";
  elements.labAssistantRepeat.checked = false;
  elements.labAssistantStatus.textContent = "";
  elements.labAssistantStatus.classList.remove("error");
  elements.labAssistantDialog.showModal();
}

async function assignLabAssistant(event) {
  event.preventDefault();
  const row = builders.find((builder) => builder.id === selectedId);
  const helper = helperForRow(row);
  if (!helper) {
    elements.labAssistantStatus.textContent = "Select a Home Village Builder or Lab timer.";
    elements.labAssistantStatus.classList.add("error");
    return;
  }
  const level = Number(elements.labAssistantLevel.value);
  const repeat = elements.labAssistantRepeat.checked;
  try {
    if (!labAssistantsReady) throw new Error("Helper data is unavailable. Check the setup and reload.");
    if (!Number.isInteger(level) || level < 1 || level > helper.maxLevel) throw new Error(`Choose a ${helper.name} level from 1 to ${helper.maxLevel}.`);
    const now = Date.now();
    const current = assistantForRow(row);
    const key = helperKey(normalize(row.account), row.builderType || BUILDER_TYPE);
    if (finishIsDone(row, now)) throw new Error("Start an upgrade before assigning the helper.");
    if (current?.timerId !== row.id && current?.projectedFinish > now) throw new Error(`The ${helper.name} is assigned to another timer.`);
    if (!labAssistantAvailability(current, now).available) throw new Error(`The ${helper.name} is not available yet.`);
    const workdayText = elements.labAssistantWorkday.value.trim();
    const workdaySeconds = workdayText ? parseDuration(workdayText) : null;
    if (workdaySeconds !== null && (workdaySeconds < 1 || workdaySeconds > WORKDAY / 1000)) {
      throw new Error("Enter a shared workday remaining between 1 second and 23 hours.");
    }
    labAssistantSaving = true;
    elements.assignLabAssistantButton.disabled = true;
    render();
    if (supabase) {
      const { data, error } = await supabase.rpc("assign_village_helper", {
        p_helper_type: row.builderType || BUILDER_TYPE,
        p_timer_id: row.id,
        p_level: level,
        p_keep_assigned: repeat,
        p_workday_seconds: workdaySeconds,
        p_expected_finish: row.finishAt,
      });
      if (error) throw error;
      const index = builders.findIndex((builder) => builder.id === row.id);
      if (index >= 0) builders[index] = fromSupabaseRow(data.timer);
      const assistant = fromSupabaseAssistant(data.assistant);
      labAssistants.set(key, assistant);
    } else {
      const baseFinish = new Date(row.finishAt).getTime();
      const workdayEnd = sharedWorkdayEnd(labAssistants.values(), normalize(row.account), now)
        ?? now + (workdaySeconds ?? WORKDAY / 1000) * 1000;
      const forecast = forecastLabAssistant(now, baseFinish, workdayEnd, level, repeat, row.builderType || BUILDER_TYPE);
      const assistant = {
        accountKey: normalize(row.account),
        helperType: row.builderType || BUILDER_TYPE,
        level,
        timerId: row.id,
        startedAt: now,
        workdayEnd,
        workUntil: Math.min(now + HOUR, forecast.projectedFinish),
        nextSession: forecast.nextSession,
        baseFinish,
        projectedFinish: forecast.projectedFinish,
        repeat,
        savedMs: savedForLab(row, now) ?? 0,
      };
      const previousAssistant = current;
      const previousRow = { ...row };
      row.finishAt = new Date(forecast.projectedFinish).toISOString();
      row.discordAlertEnabled = true;
      row.discordAlertSentAt = null;
      row.discordAlertClaimedAt = null;
      labAssistants.set(key, assistant);
      if (!saveBuilders()) {
        Object.assign(row, previousRow);
        if (previousAssistant) labAssistants.set(key, previousAssistant);
        else labAssistants.delete(key);
        throw new Error("Could not save the helper assignment in this browser.");
      }
    }
    if (supabase) saveBuilders();
    elements.labAssistantWorkday.value = "";
    elements.labAssistantDialog.close();
    setEditorStatus(`${helper.name} assignment tracked. Assign it in the game too.`);
  } catch (error) {
    elements.labAssistantStatus.textContent = error.message;
    elements.labAssistantStatus.classList.add("error");
  } finally {
    labAssistantSaving = false;
    elements.assignLabAssistantButton.disabled = false;
    render();
  }
}

async function stopLabAssistant() {
  const row = builders.find((builder) => builder.id === selectedId);
  if (!row || !hasTrackedLabAssistant(row)) {
    setEditorStatus("There is no active helper assignment on this timer.", true);
    return;
  }
  if (!window.confirm("Stop tracking this assignment? Future projected boosts will be removed, but time already saved is kept. If the assistant continues working in the game, the estimate will not match.")) return;
  labAssistantSaving = true;
  render();
  try {
    if (supabase) {
      const { data, error } = await supabase.rpc("stop_village_helper", {
        p_helper_type: row.builderType || BUILDER_TYPE, p_timer_id: row.id,
      });
      if (error) throw error;
      const index = builders.findIndex((builder) => builder.id === row.id);
      if (index >= 0) builders[index] = fromSupabaseRow(data.timer);
      const assistant = fromSupabaseAssistant(data.assistant);
      labAssistants.set(helperKey(assistant.accountKey, assistant.helperType), assistant);
    } else {
      const now = Date.now();
      const key = helperKey(normalize(row.account), row.builderType || BUILDER_TYPE);
      const assistant = labAssistants.get(key);
      const saved = savedLabTime(assistant, now);
      const availability = labAssistantAvailability(assistant, now);
      const previousRow = { ...row };
      const restoredFinish = Math.max(now, assistant.baseFinish - (saved - (assistant.savedMs || 0)));
      row.finishAt = new Date(restoredFinish).toISOString();
      row.discordAlertEnabled = restoredFinish > now;
      row.discordAlertSentAt = null;
      row.discordAlertClaimedAt = null;
      labAssistants.set(key, {
        accountKey: normalize(row.account),
        helperType: assistant.helperType,
        level: assistant.level,
        timerId: row.id,
        startedAt: availability.startedAt,
        workdayEnd: availability.workdayEnd,
        workUntil: now,
        nextSession: null,
        baseFinish: restoredFinish,
        projectedFinish: null,
        repeat: false,
        savedMs: saved,
      });
      if (!saveBuilders()) {
        Object.assign(row, previousRow);
        labAssistants.set(key, assistant);
        throw new Error("Could not stop tracking in this browser.");
      }
    }
    if (supabase) saveBuilders();
    setEditorStatus("Helper tracking stopped. Time already saved was kept.");
  } catch (error) {
    setEditorStatus(error.message, true);
  } finally {
    labAssistantSaving = false;
    render();
  }
}

function render() {
  updateOverview();
  renderAccountSummary();
  renderRows();
  renderEditor();
}

function selectBuilder(id) {
  if (selectedId !== id) {
    setEditorStatus("");
  }
  selectedId = id;
  render();
}

async function addBuilders(event) {
  event.preventDefault();
  if (!supabase && !labAssistantsReady) {
    setAddStatus("Helper data could not be loaded; timers cannot be saved.", true);
    return;
  }
  const enteredAccount = elements.addAccountSelect.value || elements.accountInput.value.trim();
  const account = builders.find((row) => normalize(row.account) === normalize(enteredAccount))?.account || enteredAccount;
  const count = Number(elements.builderCountInput.value);
  const village = currentVillage();
  const builderType = currentBuilderType();
  if (!account) {
    setAddStatus("Select an existing account or enter a new account name.", true);
    elements.accountInput.focus();
    return;
  }
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    setAddStatus("Choose a whole number from 1 to 20.", true);
    elements.builderCountInput.focus();
    return;
  }

  const existing = new Set(builders
    .filter((row) => normalize(row.account) === normalize(account)
      && row.village === village
      && normalize(row.builderType || BUILDER_TYPE) === normalize(builderType))
    .map((row) => String(row.builder)));
  const added = [];
  for (let number = 1; number <= count; number += 1) {
    const builder = String(number);
    if (existing.has(builder)) continue;
    const row = {
      id: makeId(),
      account,
      village,
      builderType,
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
  refreshBuilderTypeOptions();
  elements.villageFilter.value = village;
  refreshAccountFilter();
  elements.addAccountSelect.value = [...elements.addAccountSelect.options]
    .find((option) => normalize(option.value) === normalize(account))?.value || "";
  elements.accountInput.disabled = Boolean(elements.addAccountSelect.value);
  elements.accountFilter.value = account;
  const nextSelectedId = committed.at(-1)?.id ?? null;
  if (selectedId !== nextSelectedId) setEditorStatus("");
  selectedId = nextSelectedId;
  render();
  setAddStatus(added.length
    ? `Added ${added.length} ${builderType} timer${added.length === 1 ? "" : "s"} for ${account} in ${village}.`
    : `Those ${builderType} timers already exist for ${account} in ${village}.`);
}

function parseDuration(text) {
  const matcher = /(\d+)\s*([dhms])/gi;
  const parts = [...text.matchAll(matcher)];
  const residue = text.replace(matcher, "").trim();
  if (!parts.length || residue) throw new Error("Enter a time like 2d 5h 30m or 30s, or use 0m for done.");
  return parts.reduce((total, [, amount, unit]) => {
    const value = Number(amount);
    if (unit.toLowerCase() === "d") return total + value * 86400;
    if (unit.toLowerCase() === "h") return total + value * 3600;
    if (unit.toLowerCase() === "m") return total + value * 60;
    return total + value;
  }, 0);
}

async function updateSelectedTime(markDone = false) {
  if (!supabase && !labAssistantsReady) {
    setEditorStatus("Helper data could not be loaded; timers cannot be saved.", true);
    return;
  }
  const row = builders.find((builder) => builder.id === selectedId);
  if (!row) {
    setEditorStatus("Select a builder first.", true);
    return;
  }
  if (hasTrackedLabAssistant(row)) {
    setEditorStatus("Stop helper tracking before changing this timer.", true);
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
    setEditorStatus(markDone ? `${builderLabel(row)} marked done.` : "Timer updated.");
    render();
  } catch (error) {
    setEditorStatus(error.message, true);
  }
}

async function removeSelected() {
  if (!supabase && !labAssistantsReady) {
    setEditorStatus("Helper data could not be loaded; timers cannot be saved.", true);
    return;
  }
  const index = builders.findIndex((builder) => builder.id === selectedId);
  if (index < 0) {
    setEditorStatus("Select a builder first.", true);
    return;
  }
  const removed = builders[index];
  if (hasTrackedLabAssistant(removed)) {
    setEditorStatus("Stop helper tracking before removing this timer.", true);
    return;
  }
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
  setAddStatus(`Removed ${builderLabel(removed)} from ${removed.account}.`);
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
    if (!supabase && !labAssistantsReady) throw new Error("Helper data could not be loaded; timers cannot be saved.");
    const text = await file.text();
    if (!text.trim()) throw new Error("CSV file is empty.");
    const rows = parseCsv(text);
    const headers = rows.shift()?.map((header) => header.replace(/^\uFEFF/, "").trim().toLocaleLowerCase()) ?? [];
    const column = (name) => headers.indexOf(name.toLocaleLowerCase());
    const accountColumn = column("Account");
    const villageColumn = column("Village");
    const builderColumn = column("Builder");
    const builderTypeColumn = column("Builder Type");
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
        builderType: (builderTypeColumn < 0 ? "" : cells[builderTypeColumn] ?? "").trim() || BUILDER_TYPE,
        builder,
        finishAt,
        discordAlertEnabled: new Date(finishAt).getTime() > Date.now(),
        discordAlertSentAt: null,
        discordAlertClaimedAt: null,
      };
      const key = makeBuilderKey(row);
      const existing = byKey.get(key);
      if (existing) {
        if (hasTrackedLabAssistant(existing) && new Date(existing.finishAt).getTime() !== new Date(finishAt).getTime()) {
          throw new Error(`Stop helper tracking before importing changes to ${existing.account}'s ${builderLabel(existing)}.`);
        }
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
  const header = ["Account", "Village", "Builder Type", "Builder", "Finish At"];
  const rows = [...builders].sort(compareBuilderRows)
    .map((row) => [row.account, row.village, row.builderType || BUILDER_TYPE, row.builder, new Date(row.finishAt).toLocaleString("sv-SE")]);
  const csv = [header, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "builder-timers.csv";
  link.click();
  URL.revokeObjectURL(url);
  setAddStatus(`Exported ${builders.length} timer row${builders.length === 1 ? "" : "s"}.`);
}

elements.addForm.addEventListener("submit", addBuilders);
elements.addAccountSelect.addEventListener("change", () => {
  elements.accountInput.disabled = Boolean(elements.addAccountSelect.value);
  setAddStatus("");
});
elements.builderTypeSelect.addEventListener("change", refreshBuilderTypeOptions);
document.querySelectorAll('input[name="village"]').forEach((input) => {
  input.addEventListener("change", refreshBuilderTypeOptions);
});
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
elements.accountSummary.addEventListener("click", (event) => {
  const moveButton = event.target.closest(".account-order-button");
  if (moveButton) {
    moveAccount(moveButton.dataset.account, Number(moveButton.dataset.direction));
    return;
  }
  const card = event.target.closest(".account-summary-card");
  if (!card) return;
  elements.accountFilter.value = card.dataset.account;
  elements.villageFilter.value = "";
  elements.accountFilter.dispatchEvent(new Event("change"));
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
elements.labAssistantForm.addEventListener("submit", assignLabAssistant);
elements.closeLabAssistantDialog.addEventListener("click", () => elements.labAssistantDialog.close());
elements.stopLabAssistantButton.addEventListener("click", stopLabAssistant);
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
    try {
      accountOrder = await loadAccountOrder();
    } catch (error) {
      setAccountOrderStatus(`Could not load account order: ${error.message}`, true);
    }
    try {
      labAssistants = loadLocalAssistants();
    } catch (error) {
      labAssistantsReady = false;
      setAddStatus(`Could not load helper data: ${error.message}`, true);
    }
    refreshAccountFilter();
    refreshBuilderTypeOptions();
    render();
    return;
  }

  elements.storageLabel.textContent = "CONNECTING";
  try {
    let remoteBuilders = await fetchSupabaseBuilders();
    if (!remoteBuilders.length && builders.length) {
      const localAssistants = loadLocalAssistants();
      if ([...localAssistants.values()].some((assistant) => assistant.timerId && assistant.projectedFinish > Date.now())) {
        throw new Error("Stop active local helper tracking before migrating timers to Supabase.");
      }
      await upsertSupabaseBuilders(builders);
      remoteBuilders = await fetchSupabaseBuilders();
    }
    builders = remoteBuilders;
    remoteReady = true;
    elements.storageLabel.textContent = "SUPABASE";
    try {
      labAssistants = await loadSupabaseAssistants();
      labAssistantsReady = true;
    } catch (error) {
      setAddStatus(`Could not load helper data: ${error.message}. Run the Supabase setup and reload.`, true);
    }
    if (labAssistantsReady) saveBuilders();
    try {
      accountOrder = await loadAccountOrder();
      accountOrderReady = true;
    } catch (error) {
      setAccountOrderStatus(`Could not load account order: ${error.message}. Run the Supabase setup and reload.`, true);
    }
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
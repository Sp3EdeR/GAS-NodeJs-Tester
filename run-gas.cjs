const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const util = require("node:util");
const {spawnSync} = require("node:child_process");

// Each [first, second] pair means `first` must be loaded before `second`.
const loadOrder = [
  ["linkify.js.gs", "linkify-html.js.gs"]
];

const projectDir = path.resolve(__dirname, "..");
const logFile = path.join(__dirname, "run-gas.log");

async function fetchInChild() {
  const request = JSON.parse(fs.readFileSync(0, "utf8"));
  const headers = new Headers(request.options.headers);
  const options = request.options;
  let body = options.payload;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    body = new URLSearchParams(body).toString();
    if (!headers.has("content-type"))
      headers.set("content-type", "application/x-www-form-urlencoded");
  } else if (Array.isArray(body)) {
    body = Buffer.from(body);
  }
  if (options.contentType)
    headers.set("content-type", options.contentType);
  const response = await fetch(request.url, {
    method: options.method || "get", headers, body,
    redirect: options.followRedirects === false ? "manual" : "follow",
    signal: AbortSignal.timeout(30000)
  });
  process.stdout.write(JSON.stringify({
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: Buffer.from(await response.arrayBuffer()).toString("base64")
  }));
}

function fetchUrl(url, options = {}) {
  const result = spawnSync(process.execPath, [__filename, "--fetch"], {
    input: JSON.stringify({url, options}), encoding: "utf8",
    timeout: 35000, maxBuffer: 64 * 1024 * 1024,
    env: {...process.env, ELECTRON_RUN_AS_NODE: "1"}
  });
  if (result.error || result.status !== 0)
    throw new Error(`HTTP request failed for ${url}: ${result.error?.message || result.stderr.trim()}`);
  const response = JSON.parse(result.stdout);
  if (response.status >= 400 && !options.muteHttpExceptions)
    throw new Error(`HTTP error ${response.status} when accessing ${url}`);
  const bytes = Buffer.from(response.body, "base64");
  const getContentText = (charset = "utf-8") => new TextDecoder(charset).decode(bytes);
  return {
    getResponseCode: () => response.status,
    getHeaders: () => response.headers,
    getContent: () => Array.from(bytes, value => value > 127 ? value - 256 : value),
    getContentText, toString: () => getContentText()
  };
}

function formatDate(date, timeZone, pattern) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(date).map(part => [part.type, part.value]));
  const tokens = {
    yyyy: parts.year, YYYY: parts.year, MM: parts.month, dd: parts.day,
    HH: parts.hour, mm: parts.minute, ss: parts.second
  };
  return pattern.replace(/'([^']*)'|yyyy|YYYY|MM|dd|HH|mm|ss/g,
    (token, literal) => literal === undefined ? tokens[token] : literal);
}

function createProperties() {
  const values = Object.create(null);
  return {
    getProperty: key => values[key] ?? null,
    setProperty(key, value) { values[key] = String(value); return this; },
    deleteProperty(key) { delete values[key]; return this; }
  };
}

function createSpreadsheetService(log) {
  const spreadsheets = new Map();
  function createSheet(parent, name) {
    const cells = new Map();
    const formulas = new Map();
    let maxRows = 1000;
    let maxColumns = 26;
    const key = (row, column) => `${row}:${column}`;
    const sheet = {
      getName: () => name,
      setName(value) { name = value; return sheet; },
      getParent: () => parent,
      getIndex: () => parent.getSheets().indexOf(sheet) + 1,
      getLastRow: () => Math.max(0, ...Array.from(cells.keys(), cell => Number(cell.split(":")[0]))),
      getMaxRows: () => maxRows,
      getMaxColumns: () => maxColumns,
      setFrozenRows: () => sheet,
      insertRowsAfter(after, count) {
        if (after !== maxRows) throw new Error("Only grid extension is implemented");
        maxRows += count;
        return sheet;
      },
      insertColumnsAfter(after, count) {
        if (after !== maxColumns) throw new Error("Only grid extension is implemented");
        maxColumns += count;
        return sheet;
      },
      deleteRows(start, count) {
        for (const store of [cells, formulas]) {
          const remaining = Array.from(store.entries());
          store.clear();
          for (const [cell, value] of remaining) {
            const [row, column] = cell.split(":").map(Number);
            if (row < start) store.set(cell, value);
            else if (row >= start + count) store.set(key(row - count, column), value);
          }
        }
        maxRows -= count;
        return sheet;
      },
      getRange(row, column, rows = 1, columns = 1) {
        if (row < 1 || column < 1 || rows < 1 || columns < 1 ||
            row + rows - 1 > maxRows || column + columns - 1 > maxColumns)
          throw new Error(`Invalid range in ${name}: ${row},${column},${rows},${columns}`);
        const range = {
          getValues: () => Array.from({length: rows}, (_, rowOffset) =>
            Array.from({length: columns}, (_, columnOffset) =>
              cells.get(key(row + rowOffset, column + columnOffset)) ?? "")),
          setValues(values) {
            if (values.length !== rows || values.some(valuesRow => valuesRow.length !== columns))
              throw new Error("Range and value dimensions differ");
            values.forEach((valuesRow, rowOffset) => valuesRow.forEach((value, columnOffset) => {
              const cell = key(row + rowOffset, column + columnOffset);
              formulas.delete(cell);
              if (value === "") cells.delete(cell);
              else cells.set(cell, value);
            }));
            log("Spreadsheet.Range.setValues", {spreadsheet: parent.getId(), sheet: name,
              row, column, values});
            return range;
          },
          setValue: value => range.setValues([[value]]),
          setRichTextValues: values => range.setValues(values.map(valuesRow =>
            valuesRow.map(value => value.getText()))),
          getFormula: () => formulas.get(key(row, column)) || "",
          setFormula(formula) {
            range.setValue(formula);
            formulas.set(key(row, column), formula);
            return range;
          },
          clearContent() {
            for (let rowOffset = 0; rowOffset < rows; rowOffset++) {
              for (let columnOffset = 0; columnOffset < columns; columnOffset++) {
                const cell = key(row + rowOffset, column + columnOffset);
                cells.delete(cell);
                formulas.delete(cell);
              }
            }
            return range;
          }
        };
        return range;
      },
      appendRow(values) {
        const row = sheet.getLastRow() + 1;
        maxRows = Math.max(maxRows, row);
        sheet.getRange(row, 1, 1, values.length).setValues([values]);
        return sheet;
      }
    };
    return sheet;
  }
  const SpreadsheetApp = {
    create(name) {
      const id = `local-sheet-${spreadsheets.size + 1}`;
      const sheets = [];
      let active;
      const spreadsheet = {
        getId: () => id,
        getName: () => name,
        getSheets: () => sheets.slice(),
        getSheetByName: sheetName => sheets.find(sheet => sheet.getName() === sheetName) || null,
        insertSheet(sheetName, index = sheets.length) {
          const sheet = createSheet(spreadsheet, sheetName);
          sheets.splice(index, 0, sheet);
          active = sheet;
          return sheet;
        },
        getActiveSheet: () => active,
        setActiveSheet(sheet) { active = sheet; return sheet; },
        moveActiveSheet(position) {
          sheets.splice(sheets.indexOf(active), 1);
          sheets.splice(position - 1, 0, active);
        }
      };
      spreadsheet.insertSheet("Sheet1");
      spreadsheets.set(id, spreadsheet);
      log("SpreadsheetApp.create", {id, name});
      return spreadsheet;
    },
    openById(id) {
      if (!spreadsheets.has(id)) throw new Error(`Unknown local spreadsheet: ${id}`);
      return spreadsheets.get(id);
    },
    newRichTextValue() {
      let text = "";
      return {
        setText(value) { text = String(value); return this; },
        build: () => ({getText: () => text})
      };
    }
  };
  const mimeType = "application/vnd.google-apps.spreadsheet";
  return {
    SpreadsheetApp,
    MimeType: {GOOGLE_SHEETS: mimeType},
    DriveApp: {
      getFilesByName(name) {
        const matches = Array.from(spreadsheets.values()).filter(sheet => sheet.getName() === name);
        let index = 0;
        return {
          hasNext: () => index < matches.length,
          next() {
            const sheet = matches[index++];
            return {getId: () => sheet.getId(), getMimeType: () => mimeType};
          }
        };
      }
    }
  };
}

function applyLoadOrder(files, pairs) {
  const ordered = [...files];
  for (const [first, second] of pairs) {
    const firstIndex = ordered.indexOf(first);
    const secondIndex = ordered.indexOf(second);
    if (firstIndex === -1 || secondIndex === -1 || firstIndex < secondIndex)
      continue;
    ordered.splice(firstIndex, 1);
    ordered.splice(ordered.indexOf(second), 0, first);
  }
  return ordered;
}

function createContext(log = console.log, {src = "", trgt = ""} = {}) {
  let sequence = 0;
  const calendars = [];
  const triggers = [];
  const scriptProperties = createProperties();
  const userProperties = createProperties();
  const write = (method, payload, extra = {}) => {
    const resource = {...JSON.parse(JSON.stringify(payload)), ...extra};
    log(method, resource);
    return resource;
  };
  const context = vm.createContext({
    console: Object.fromEntries(["log", "info", "warn", "error", "debug"].map(level => [level, log])),
    Logger: {log},
    UrlFetchApp: {
      fetch(url, options) {
        log("UrlFetchApp.fetch %s %s", options?.method || "get", url);
        const response = fetchUrl(url, options);
        log("HTTP %s %s", response.getResponseCode(), url);
        return response;
      }
    },
    Calendar: {
      newCalendar: () => ({}), newEvent: () => ({}),
      newEventSource: () => ({}), newEventOrganizer: () => ({}),
      CalendarList: {list: () => ({items: calendars.slice()})},
      Settings: {
        get(name) {
          if (name !== "timezone") throw new Error(`Unsupported calendar setting: ${name}`);
          return {value: "Europe/Budapest"};
        }
      },
      Calendars: {
        insert(calendar) {
          const result = write("Calendar.Calendars.insert", calendar,
            {id: `local-calendar-${++sequence}`, accessRole: "owner"});
          calendars.push(result);
          return result;
        }
      },
      Events: {
        list: () => ({items: []}),
        insert: (event, calendarId) => write("Calendar.Events.insert", event,
          {id: `local-event-${++sequence}`, status: "confirmed", calendarId}),
        update: (event, calendarId, id) => write("Calendar.Events.update", event,
          {id, status: "confirmed", calendarId}),
        remove: (calendarId, id) => log("Calendar.Events.remove", {calendarId, id})
      }
    },
    CalendarApp: {EventColor: {
      PALE_BLUE: "1", PALE_GREEN: "2", MAUVE: "3", PALE_RED: "4", YELLOW: "5",
      ORANGE: "6", CYAN: "7", GRAY: "8", BLUE: "9", GREEN: "10", RED: "11"
    }},
    PropertiesService: {
      getScriptProperties: () => scriptProperties,
      getUserProperties: () => userProperties
    },
    Utilities: {
      DigestAlgorithm: {MD5: "md5", SHA_256: "sha256"},
      computeDigest: (algorithm, value) => Array.from(
        crypto.createHash(algorithm).update(value).digest(),
        byte => byte > 127 ? byte - 256 : byte
      ),
      formatDate,
      sleep(milliseconds) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger(trigger) {
        const index = triggers.indexOf(trigger);
        if (index !== -1) triggers.splice(index, 1);
        log("ScriptApp.deleteTrigger", {handler: trigger.getHandlerFunction()});
      },
      newTrigger(handler) {
        const schedule = {};
        const builder = {
          timeBased() { return builder; },
          create() {
            const trigger = {getHandlerFunction: () => handler};
            triggers.push(trigger);
            log("ScriptApp.newTrigger", {handler, schedule});
            return trigger;
          }
        };
        for (const method of ["everyHours", "everyMinutes", "everyDays", "after"])
          builder[method] = value => { schedule[method] = value; return builder; };
        return builder;
      }
    },
    MailApp: {sendEmail: (...args) => log("MailApp.sendEmail (not sent)", ...args)},
    Tasks: {
      newTask: () => ({}),
      Tasklists: {list: () => ({items: [{id: "local-tasks", title: "Local tasks"}]})},
      Tasks: {
        list: () => ({items: []}),
        insert: (task, taskListId) => write("Tasks.Tasks.insert", task,
          {id: `local-task-${++sequence}`, taskListId}),
        remove: (taskListId, id) => log("Tasks.Tasks.remove", {taskListId, id})
      }
    },
    Maps: {
      newGeocoder() {
        const geocoder = {
          setBounds() { return geocoder; },
          setLanguage() { return geocoder; },
          setRegion() { return geocoder; },
          geocode(location) {
            log("Maps.geocode (emulated; no Google credentials)", location);
            return {status: "REQUEST_DENIED", results: []};
          }
        };
        return geocoder;
      }
    },
    ...createSpreadsheetService(log)
  });
  const files = applyLoadOrder(
    fs.readdirSync(projectDir).filter(name => name.endsWith(".gs") && name !== "Code.gs").sort(),
    loadOrder
  );
  for (const name of [...files, "Code.gs"])
    vm.runInContext(fs.readFileSync(path.join(projectDir, name), "utf8"), context, {filename: name});
  const total = context.sourceCalendars.length;
  const matches = (value, pattern) => !pattern || new RegExp(pattern).test(value);
  context.sourceCalendars = context.sourceCalendars.filter(mapping =>
    matches(mapping.src, src) && matches(mapping.trgt, trgt));
  log("Source filters: src=%j, trgt=%j; keeping %s of %s mappings", src, trgt,
    context.sourceCalendars.length, total);
  return context;
}

function main() {
  fs.writeFileSync(logFile, "", "utf8");
  const log = (...args) => {
    const message = util.formatWithOptions({depth: null, maxArrayLength: null, maxStringLength: null}, ...args);
    console.log(message);
    fs.appendFileSync(logFile, message + "\n", "utf8");
  };
  try {
    const {values, positionals} = util.parseArgs({
      options: {
        src: {type: "string", default: ""},
        trgt: {type: "string", default: ""}
      },
      allowPositionals: true
    });
    if (positionals.length > 1)
      throw new Error("Expected at most one GAS entry point");
    const entryPoint = positionals[0] || "startSync";
    log("GAS local runner: %s; Node %s; %s", entryPoint, process.versions.node, new Date().toISOString());
    log("Live source HTTP; empty calendar reads; Google writes are emulated. Log: %s", logFile);
    const context = createContext(log, values);
    if (!/^[A-Za-z_$][\w$]*$/.test(entryPoint) || typeof context[entryPoint] !== "function")
      throw new Error(`Unknown GAS entry point: ${entryPoint}`);
    context[entryPoint]();
    log("GAS entry point completed: %s", entryPoint);
  } catch (error) {
    log("FAILED: %s", error.stack || error);
    process.exitCode = 1;
  }
}

module.exports = {createContext, fetchUrl, formatDate};
if (require.main === module) {
  if (process.argv[2] === "--fetch")
    fetchInChild().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
  else
    main();
}
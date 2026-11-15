const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {spawnSync} = require("node:child_process");

const eventLabel = "\u00c9rtes\u00edt\u0151k/Esem\u00e9nyek";
const toSignedBytes = buffer => Array.from(buffer, byte => byte > 127 ? byte - 256 : byte);

/**
 * Decodes EML fixtures into Gmail-shaped message resources using a MIME parser.
 * @param {string} directory Directory containing EML files.
 * @param {object} options Loader settings and logger.
 * @returns {Promise<object[]>} Messages with normalized UTF-8 MIME body parts.
 */
async function loadMailDirectory(directory, {allowMissing = false, log = console.log} = {}) {
  const {simpleParser} = require("mailparser");
  if (allowMissing && !fs.existsSync(directory)) {
    log("No EML directory at %s; using an empty inbox", directory);
    return [];
  }
  const files = fs.readdirSync(directory).filter(name => /\.eml$/i.test(name)).sort();
  const messages = [];
  for (const name of files) {
    const raw = fs.readFileSync(path.join(directory, name));
    const mail = await simpleParser(raw);
    const headers = mail.headerLines.map(({line}) => {
      const separator = line.indexOf(":");
      return {name: line.slice(0, separator),
        value: line.slice(separator + 1).replace(/\r?\n[ \t]+/g, " ").trim()};
    });
    for (const [header, value] of [["From", mail.from?.text], ["Subject", mail.subject]]) {
      const existing = headers.find(item => item.name.toLowerCase() === header.toLowerCase());
      if (existing && value) existing.value = value;
    }
    const receivedHeader = headers.find(header => header.name.toLowerCase() === "received");
    const receivedDate = receivedHeader?.value.match(/;\s*([^;]+)$/)?.[1];
    const received = Date.parse(receivedDate || "") || mail.date?.getTime() ||
      fs.statSync(path.join(directory, name)).mtimeMs;
    const labelHeader = headers.find(header => header.name.toLowerCase() === "x-gmail-labels");
    const labels = labelHeader ? labelHeader.value.split(",").map(label => label.trim()) :
      ["INBOX", eventLabel];
    const id = "local-message-" + crypto.createHash("sha256").update(name).update(raw)
      .digest("hex").slice(0, 24);
    const threadId = "local-thread-" + crypto.createHash("sha256").update(mail.subject || id)
      .digest("hex").slice(0, 16);
    const part = (mimeType, text) => ({mimeType,
      headers: [{name: "Content-Type", value: mimeType + '; charset="UTF-8"'}],
      body: {size: Buffer.byteLength(text), data: toSignedBytes(Buffer.from(text))}});
    const parts = [];
    if (mail.text) parts.push(part("text/plain", mail.text));
    if (mail.html) parts.push(part("text/html", mail.html));
    const attachments = {};
    for (const attachment of mail.attachments) {
      const attachmentId = "attachment-" + Object.keys(attachments).length;
      attachments[attachmentId] = {size: attachment.size,
        data: toSignedBytes(attachment.content)};
      parts.push({mimeType: attachment.contentType, filename: attachment.filename || "",
        body: {attachmentId, size: attachment.size}, headers: []});
    }
    messages.push({id, threadId, internalDate: String(received), labels,
      snippet: (mail.text || "").replace(/\s+/g, " ").slice(0, 200),
      payload: {mimeType: "multipart/alternative", headers, body: {size: 0}, parts},
      raw: raw.toString("base64url"), attachments, sizeEstimate: raw.length});
  }
  log("Loaded %s EML messages from %s", messages.length, directory);
  return messages;
}

/**
 * Creates an isolated Advanced Gmail service supporting message-level reads/cleanup.
 * @param {Function} log Local operation logger.
 * @param {object[]} inputMessages Decoded EML fixtures or Gmail-shaped test messages.
 * @returns {object} Emulated Gmail service; no requests contact Google.
 */
function createGmailService(log, inputMessages = []) {
  const labels = new Map([["INBOX", "INBOX"], ["TRASH", "TRASH"], ["SPAM", "SPAM"]]);
  const labelId = name => {
    const aliases = {Inbox: "INBOX", Trash: "TRASH", Spam: "SPAM"};
    name = aliases[name] || name;
    if (!labels.has(name)) labels.set(name, "Label_" + labels.size);
    return labels.get(name);
  };
  labelId(eventLabel);
  const messages = new Map(inputMessages.map(message => {
    const data = structuredClone(message);
    data.labelIds = data.labelIds || (data.labels || ["INBOX", eventLabel]).map(labelId);
    delete data.labels;
    return [data.id, data];
  }));
  const getMessage = id => {
    if (!messages.has(id)) throw new Error(`Unknown local Gmail message: ${id}`);
    return messages.get(id);
  };
  const headerValue = (message, name) => message.payload.headers.find(header =>
    header.name.toLowerCase() === name.toLowerCase())?.value || "";
  const user = id => {
    if (id !== "me") throw new Error("Only the local Gmail user 'me' is supported");
  };
  return {
    Users: {
      Labels: {
        list(userId) {
          user(userId);
          log("Gmail.Users.Labels.list");
          return {labels: Array.from(labels, ([name, id]) => ({id, name,
            type: id.startsWith("Label_") ? "user" : "system"}))};
        }
      },
      Messages: {
        list(userId, options = {}) {
          user(userId);
          const query = options.q || "";
          const from = query.match(/\bfrom:([^\s]+)/)?.[1];
          const before = query.match(/\bbefore:(\d+)/)?.[1];
          const excluded = Array.from(query.matchAll(/-in:(\w+)/g), match =>
            match[1].toUpperCase());
          const selected = Array.from(messages.values()).filter(message =>
            (options.labelIds || []).every(id => message.labelIds.includes(id)) &&
            excluded.every(id => !message.labelIds.includes(id)) &&
            (options.includeSpamTrash || !message.labelIds.some(id =>
              ["SPAM", "TRASH"].includes(id))) &&
            (!from || headerValue(message, "From").toLowerCase().includes(from.toLowerCase())) &&
            (!before || Number(message.internalDate) < Number(before) * 1000))
            .sort((first, second) => Number(second.internalDate) - Number(first.internalDate) ||
              first.id.localeCompare(second.id));
          const start = Number(options.pageToken || 0);
          const limit = Math.min(500, options.maxResults || 100);
          const page = selected.slice(start, start + limit)
            .map(({id, threadId}) => ({id, threadId}));
          log("Gmail.Users.Messages.list", {query, start, count: page.length});
          return {messages: page, resultSizeEstimate: selected.length,
            ...(start + limit < selected.length ? {nextPageToken: String(start + limit)} : {})};
        },
        get(userId, id, {format = "full", metadataHeaders} = {}) {
          user(userId);
          const data = getMessage(id);
          const {raw, attachments, ...message} = structuredClone(data);
          if (format === "raw") {
            message.raw = raw;
            delete message.payload;
          } else if (format === "minimal") {
            delete message.payload;
          } else if (format === "metadata") {
            message.payload = {headers: message.payload.headers.filter(header =>
              !metadataHeaders || metadataHeaders.some(name =>
                name.toLowerCase() === header.name.toLowerCase()))};
          } else if (format !== "full") {
            throw new Error(`Unsupported Gmail format: ${format}`);
          }
          log("Gmail.Users.Messages.get", {id, format});
          return message;
        },
        batchModify({ids, addLabelIds = [], removeLabelIds = []}, userId) {
          user(userId);
          if (!ids.length || ids.length > 1000)
            throw new Error("Gmail batchModify needs between 1 and 1,000 message IDs");
          const selected = ids.map(getMessage);
          for (const message of selected) {
            message.labelIds = [...new Set([...message.labelIds, ...addLabelIds])]
              .filter(id => !removeLabelIds.includes(id));
          }
          log("Gmail.Users.Messages.batchModify (emulated)", {ids, addLabelIds, removeLabelIds});
          return {};
        },
        Attachments: {
          get(userId, messageId, attachmentId) {
            user(userId);
            const attachment = getMessage(messageId).attachments?.[attachmentId];
            if (!attachment) throw new Error(`Unknown local Gmail attachment: ${attachmentId}`);
            return structuredClone(attachment);
          }
        }
      }
    }
  };
}

/**
 * Decodes a directory in a child process so GAS callers can use Gmail synchronously.
 * @param {Function} log Local operation logger.
 * @param {string} directory Directory containing EML files.
 * @param {object} options Directory loader settings.
 * @returns {object} Emulated Gmail service.
 */
function createGmailDirectoryService(log, directory, {allowMissing = false} = {}) {
  const result = spawnSync(process.execPath, [__filename], {
    input: JSON.stringify({directory, allowMissing}), encoding: "utf8",
    timeout: 120000, maxBuffer: 64 * 1024 * 1024,
    env: {...process.env, ELECTRON_RUN_AS_NODE: "1"}
  });
  if (result.error || result.status !== 0) {
    const error = new Error(`EML loading failed for ${directory}: ${
      result.error?.message || result.stderr.trim()}`);
    log("%s", error.message);
    throw error;
  }
  const {messages, logs} = JSON.parse(result.stdout);
  for (const args of logs) log(...args);
  return createGmailService(log, messages);
}

module.exports = {loadMailDirectory, createGmailService, createGmailDirectoryService};
if (require.main === module) {
  const {directory, allowMissing} = JSON.parse(fs.readFileSync(0, "utf8"));
  const logs = [];
  loadMailDirectory(directory, {allowMissing, log: (...args) => logs.push(args)})
    .then(messages => process.stdout.write(JSON.stringify({messages, logs})))
    .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
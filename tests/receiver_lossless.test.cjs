"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const source = fs.readFileSync(path.join(__dirname, "../exchange_mail_bridge/apps_script/Code.gs"), "utf8");
const headers = ["MessageId", "ReceivedTime", "FromName", "FromEmail", "Subject", "BodyPreview", "HasAttachments", "AttachmentCount", "AttachmentNames", "AttachmentLinks", "BodyImageUrls", "BodyHtmlLink", "BodyLinks", "BodyTextFull", "ConversationId", "WebLink", "ImportedAt"];
function digest(text) { return crypto.createHash("sha256").update(text, "utf8").digest("hex"); }
function metadata(text) { return { sha256: digest(text), utf8Bytes: Buffer.byteLength(text, "utf8"), utf16Length: text.length }; }
function message(overrides = {}) {
  const value = Object.assign({ id: "synthetic-message", subject: "Synthetic", bodyHtml: "<p>Universität 🛡</p>", bodyTextRaw: " Original\r\n🛡\u0000 ", bodyTextFull: "Universität 🛡", attachments: [], bodyLinks: [], bodyImageUrls: [] }, overrides);
  value.bodyIntegrity = { version: 2 };
  for (const key of ["bodyHtml", "bodyTextRaw", "bodyTextFull"]) value.bodyIntegrity[key] = metadata(value[key]);
  return value;
}
function harness(initialRows) {
  const rows = initialRows || [headers.concat(["AutoReplyStatus", "AutoReplySentAt", "AutoReplyReason"])];
  const files = new Map();
  let writeCount = 0;
  let createCount = 0;
  let corruptNextFile = false;
  const sheet = {
    getLastRow() { return rows.length; },
    getRange(row, col, count = 1, width = 1) { return {
      getValues() { return Array.from({ length: count }, (_, r) => Array.from({ length: width }, (_, c) => (rows[row - 1 + r] || [])[col - 1 + c] ?? "")); },
      getValue() { return (rows[row - 1] || [])[col - 1] ?? ""; },
      setValues(values) {
        assert.ok(col + width - 1 <= 17, "must not write status/application columns");
        writeCount++;
        values.forEach((valuesRow, r) => { rows[row - 1 + r] ||= []; valuesRow.forEach((value, c) => { rows[row - 1 + r][col - 1 + c] = value; }); });
      }
    }; },
    appendRow(row) { rows.push(Array.from(row)); writeCount++; },
    setFrozenRows() {},
    insertRowBefore() { throw Error("must not re-order existing rows"); }
  };
  function file(id, text) { return { getId: () => id, getUrl: () => "https://drive.google.com/file/d/" + id + "/view", getBlob: () => ({ getDataAsString: () => text }) }; }
  const folder = { createFile(name, text) { createCount++; const id = "synthetic_file_" + createCount; const result = file(id, corruptNextFile ? text + "CORRUPTED" : text); corruptNextFile = false; files.set(id, result); return result; } };
  const context = {
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => ({ BRIDGE_TOKEN: "synthetic-token", SHEET_ID: "synthetic-sheet" })[key] || "" }) },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet, insertSheet: () => sheet }) },
    DriveApp: { getFoldersByName: () => ({ hasNext: () => true, next: () => folder }), createFolder: () => folder, getFileById(id) { if (!files.has(id)) throw Error("missing synthetic file"); return files.get(id); } },
    Utilities: { DigestAlgorithm: { SHA_256: "SHA_256" }, Charset: { UTF_8: "UTF-8" }, computeDigest: (_, text) => Array.from(crypto.createHash("sha256").update(text, "utf8").digest()), newBlob: text => ({ getBytes: () => Array.from(Buffer.from(text, "utf8")) }) },
    MimeType: { HTML: "text/html", BINARY: "application/octet-stream" },
    ContentService: { MimeType: { JSON: "application/json" }, createTextOutput: text => ({ text, setMimeType() { return this; } }) }
  };
  for (const key of ["GmailApp", "MailApp", "UrlFetchApp", "ScriptApp"]) context[key] = new Proxy({}, { get() { throw Error("FORBIDDEN REAL API " + key); } });
  vm.createContext(context); vm.runInContext(source, context);
  return { context, rows, files, writeCount: () => writeCount, createCount: () => createCount, corruptNext() { corruptNextFile = true; }, post(messages) { return JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ token: "synthetic-token", messages }) } }).text); } };
}
const checks = [];
function check(name, fn) { try { fn(); checks.push({ name, pass: true }); } catch (e) { checks.push({ name, pass: false, error: e.message }); } }
check("large HTML and raw source preserve exact Unicode/NUL/tail", () => {
  const h = harness(); const msg = message({ bodyHtml: "<html>" + "x".repeat(220000) + "🛡\u0000TAIL</html>", bodyTextFull: "x".repeat(60000) + "TAIL" });
  assert.equal(h.post([msg]).appended, 1);
  const link = h.rows[1][11]; const receipt = h.context.parseBodyReceipt_(link);
  const htmlId = link.match(/\/d\/([^/]+)/)[1];
  assert.equal(h.files.get(htmlId).getBlob().getDataAsString(), msg.bodyHtml);
  const manifest = JSON.parse(h.files.get(receipt.sourceManifestId).getBlob().getDataAsString());
  assert.equal(manifest.bodyTextRaw, msg.bodyTextRaw);
  assert.equal(manifest.bodyTextFull, msg.bodyTextFull);
  assert.equal(receipt.sha256, digest(msg.bodyHtml));
  assert.equal(Number(receipt.utf8Bytes), Buffer.byteLength(msg.bodyHtml));
  assert.equal(Number(receipt.utf16Length), msg.bodyHtml.length);
  assert.match(h.rows[1][13], /BRIDGE-V2 VORSCHAU/);
  assert.ok(h.rows[1][13].length < 50000);
});
check("same ID and same content idempotent without new Drive files", () => { const h = harness(); const m = message(); h.post([m]); const creates = h.createCount(); const writes = h.writeCount(); assert.equal(h.post([m]).skipped, 1); assert.equal(h.createCount(), creates); assert.equal(h.writeCount(), writes); });
check("duplicate IDs within one batch create one row", () => { const h = harness(); const result = h.post([message(), message()]); assert.equal(result.appended, 1); assert.equal(result.skipped, 1); assert.equal(h.rows.length, 2); });
check("changed full source refreshes receipt but preserves sent status and ImportedAt", () => {
  const h = harness(); h.post([message()]); const oldLink = h.rows[1][11]; const imported = h.rows[1][16];
  h.rows[1][17] = "sent"; h.rows[1][18] = "2026-01-01T01:00:00Z"; h.rows[1][19] = "already processed";
  assert.equal(h.post([message({ bodyHtml: "<p>Changed original</p>" })]).updated, 1);
  assert.notEqual(h.rows[1][11], oldLink); assert.equal(h.rows[1][16], imported);
  assert.deepEqual(h.rows[1].slice(17), ["sent", "2026-01-01T01:00:00Z", "already processed"]);
});
check("legacy client cannot downgrade v2 source or status", () => { const h = harness(); h.post([message()]); const old = JSON.stringify(h.rows[1]); const legacy = message({ bodyHtml: "<p>Shorter</p>" }); delete legacy.bodyIntegrity; assert.equal(h.post([legacy]).skipped, 1); assert.equal(JSON.stringify(h.rows[1]), old); });
check("legacy source can be stored but is never falsely v2 verified", () => { const h = harness(); const legacy = message({ bodyHtml: "<p>" + "x".repeat(220000) + "TAIL</p>" }); delete legacy.bodyIntegrity; assert.equal(h.post([legacy]).appended, 1); assert.equal(h.context.parseBodyReceipt_(h.rows[1][11]), null); const id = h.rows[1][11].match(/\/d\/([^/]+)/)[1]; assert.equal(h.files.get(id).getBlob().getDataAsString(), legacy.bodyHtml); });
check("bad checksum fails before any Sheet or Drive write", () => { const h = harness(); const m = message(); m.bodyIntegrity.bodyHtml.sha256 = "0".repeat(64); const result = h.post([m]); assert.equal(result.ok, false); assert.equal(result.statusCode, 422); assert.equal(h.writeCount(), 0); assert.equal(h.createCount(), 0); });
check("bad length fails before any mutation", () => { const h = harness(); const m = message(); m.bodyIntegrity.bodyHtml.utf16Length++; assert.equal(h.post([m]).statusCode, 422); assert.equal(h.writeCount(), 0); assert.equal(h.createCount(), 0); });
check("one invalid message prevents entire batch mutation", () => { const h = harness(); const bad = message({ id: "bad" }); delete bad.bodyTextRaw; assert.equal(h.post([message(), bad]).statusCode, 422); assert.equal(h.writeCount(), 0); assert.equal(h.createCount(), 0); });
check("hard byte cap rejects without truncation", () => { const h = harness(); const m = message({ bodyHtml: "x".repeat(8 * 1024 * 1024 + 1) }); const result = h.post([m]); assert.equal(result.statusCode, 422); assert.match(result.error, /nothing was truncated/); assert.equal(h.writeCount(), 0); assert.equal(h.createCount(), 0); });
check("Drive readback corruption cannot produce a verified row", () => { const h = harness(); h.corruptNext(); const result = h.post([message()]); assert.equal(result.ok, false); assert.match(result.error, /read-back verification failed/); assert.equal(h.writeCount(), 0); assert.equal(h.rows.length, 1); });
check("unexpected existing column order fails without overwriting header", () => { const h = harness([["DifferentHeader", ...headers.slice(1), "AutoReplyStatus"]]); const result = h.post([message()]); assert.equal(result.ok, false); assert.match(result.error, /Unexpected transport column order/); assert.equal(h.writeCount(), 0); assert.equal(h.createCount(), 0); });
check("doGet proves protocol and hashed destination only", () => { const h = harness(); const result = JSON.parse(h.context.doGet().text); assert.equal(result.protocolVersion, 2); assert.equal(result.targetSheetSha256, digest("synthetic-sheet")); assert.ok(!JSON.stringify(result).includes("synthetic-sheet")); assert.ok(!JSON.stringify(result).includes("synthetic-token")); assert.equal(h.writeCount(), 0); });
check("marked preview never splits a surrogate pair", () => { const h = harness(); const text = "x".repeat(44999) + "🛡" + "tail"; const cell = h.context.bodyTextCell_(text, ""); assert.ok(!/[\uD800-\uDBFF]\n/.test(cell)); assert.match(cell, /VORSCHAU/); });
check("formula-like source is preserved in manifest and marked as a text preview", () => { const h = harness(); const m = message({ bodyTextFull: "=SYNTHETIC_FORMULA()" }); h.post([m]); assert.match(h.rows[1][13], /^\[BRIDGE-V2 VORSCHAU\]/); const r = h.context.parseBodyReceipt_(h.rows[1][11]); assert.equal(JSON.parse(h.files.get(r.sourceManifestId).getBlob().getDataAsString()).bodyTextFull, m.bodyTextFull); });
check("actual Python serializer to JS receiver preserves source beyond both old limits", () => {
  const script = [
    "import sys,json",
    "from types import SimpleNamespace",
    "sys.path.insert(0,'exchange_mail_bridge')",
    "import exchange_to_apps_script as b",
    "m=SimpleNamespace(id='cross-runtime',subject='Synthetic',body='<html>'+('x'*230000)+'\\U0001f6e1\\x00HTML_TAIL</html>',text_body=('t'*60000)+'\\r\\n\\U0001f6e1\\x00RAW_TAIL',attachments=[],has_attachments=False)",
    "print(json.dumps(b.serialize_item(m,False,True,2500000,200000),ensure_ascii=True))"
  ].join("\n");
  const result = spawnSync("python", ["-B", "-c", script], { cwd: path.join(__dirname, ".."), encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const m = JSON.parse(result.stdout); const h = harness(); assert.equal(h.post([m]).appended, 1);
  const r = h.context.parseBodyReceipt_(h.rows[1][11]);
  const manifest = JSON.parse(h.files.get(r.sourceManifestId).getBlob().getDataAsString());
  assert.equal(manifest.bodyTextRaw, m.bodyTextRaw); assert.match(manifest.bodyTextRaw, /RAW_TAIL$/);
  const htmlId = h.rows[1][11].match(/\/d\/([^/]+)/)[1];
  assert.equal(h.files.get(htmlId).getBlob().getDataAsString(), m.bodyHtml); assert.match(m.bodyHtml, /HTML_TAIL<\/html>$/);
});
const originalFixtureReport = {};
if (process.argv[2]) {
  check("confirmed original HTML Python-to-Drive roundtrip and duplicate preserve processed state", () => {
    const fixturePath = path.resolve(process.argv[2]);
    const fixtureBytes = fs.readFileSync(fixturePath);
    const originalHtml = fixtureBytes.toString("utf8");
    assert.equal(digest(originalHtml), "0a5ad3aa2521780cba38202b9a8f39b8ca9361dd355b0a45f6ad47555947e36b", "fixture must be the independently confirmed original");
    assert.ok(Buffer.from(originalHtml, "utf8").equals(fixtureBytes), "fixture is exact valid UTF-8");
    const script = [
      "import sys,json",
      "from pathlib import Path",
      "from types import SimpleNamespace",
      "sys.path.insert(0,'exchange_mail_bridge')",
      "import exchange_to_apps_script as b",
      "original=Path(sys.argv[1]).read_bytes().decode('utf-8')",
      // Original EWS plain alternative is unavailable: do not fabricate it.
      "m=SimpleNamespace(id='confirmed-original-offline-fixture',subject='DTAD Suchprofilergebnis',body=original,text_body='',attachments=[],has_attachments=False)",
      "print(json.dumps(b.serialize_item(m,False,True,2500000,200000),ensure_ascii=True))"
    ].join("\n");
    const result = spawnSync("python", ["-B", "-c", script, fixturePath], { cwd: path.join(__dirname, ".."), encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, "offline serializer must succeed without printing source");
    const m = JSON.parse(result.stdout); const h = harness();
    assert.ok(m.bodyHtml === originalHtml, "serializer preserves exact original HTML");
    assert.equal(h.post([m]).appended, 1);
    const r = h.context.parseBodyReceipt_(h.rows[1][11]);
    const htmlId = h.rows[1][11].match(/\/d\/([^/]+)/)[1];
    assert.ok(h.files.get(htmlId).getBlob().getDataAsString() === originalHtml, "Drive stub preserves exact original HTML");
    assert.equal(r.sha256, digest(originalHtml));
    assert.equal(Number(r.utf8Bytes), fixtureBytes.length);
    assert.equal(Number(r.utf16Length), originalHtml.length);
    h.rows[1][17] = "sent"; h.rows[1][18] = "2026-01-01T01:00:00Z"; h.rows[1][19] = "already processed";
    const before = JSON.stringify(h.rows[1]); const creates = h.createCount(); const writes = h.writeCount();
    assert.equal(h.post([m]).skipped, 1);
    assert.ok(JSON.stringify(h.rows[1]) === before, "duplicate cannot alter source or status");
    assert.equal(h.createCount(), creates); assert.equal(h.writeCount(), writes);
    Object.assign(originalFixtureReport, { sha256: digest(originalHtml), utf8Bytes: fixtureBytes.length, utf16Length: originalHtml.length, originalPlainAlternativeAvailable: false, duplicatePreservedStatus: true });
    if (process.argv[3]) {
      const consumerSource = fs.readFileSync(path.resolve(process.argv[3]), "utf8");
      let deniedApiAttempts = 0;
      const sandbox = {
        Logger: { log() {} },
        Utilities: {
          DigestAlgorithm: { SHA_256: "sha256" },
          newBlob(text) { return { getBytes() { return Array.from(Buffer.from(text, "utf8")); } }; },
          computeDigest(algorithm, bytes) { return Array.from(crypto.createHash(algorithm).update(Buffer.from(bytes)).digest()); }
        },
        DriveApp: { getFileById(id) { assert.ok(h.files.has(id), "consumer reads only mock transport files"); return h.files.get(id); } },
        __row: Object.fromEntries(headers.map((key, index) => [key, h.rows[1][index]]))
      };
      for (const name of ["MailApp", "GmailApp", "UrlFetchApp", "SpreadsheetApp", "ScriptApp", "PropertiesService", "CacheService"]) sandbox[name] = new Proxy({}, { get() { deniedApiAttempts++; throw Error("FORBIDDEN API " + name); } });
      vm.createContext(sandbox);
      vm.runInContext(consumerSource + "\nCONFIG.ENABLE_ONLINE_CPV_LOOKUP=false;", sandbox);
      vm.runInContext("globalThis.__context=buildExchangeMessageContext_(__row); globalThis.__result=analyzeTenderMail_(__context.text,__context,{silent:true});", sandbox, { timeout: 45000 });
      assert.ok(sandbox.__context.html === originalHtml, "consumer receives full checksum-verified original HTML");
      assert.equal(sandbox.__context.sourceIntegrityRequiresReview, false);
      const entries = Array.from(sandbox.__result.entries || []);
      assert.equal(entries.length, 12);
      const accepted = entries.filter(e => e.evaluation && e.evaluation.isRelevant).map(e => Number(e.index));
      assert.deepEqual(accepted, [10]);
      assert.equal(deniedApiAttempts, 0);
      Object.assign(originalFixtureReport, { consumerSha256: digest(consumerSource), entries: entries.length, acceptedIndices: accepted, externalApiAttempts: deniedApiAttempts });
    }
  });
}
const finalFailures = checks.filter(x => !x.pass);
console.log(JSON.stringify({ mode: "NO-SEND/OFFLINE/LOSSLESS-RECEIVER", passed: checks.length - finalFailures.length, failed: finalFailures.length, failures: finalFailures, originalFixture: process.argv[2] ? originalFixtureReport : "not supplied; synthetic suite only" }, null, 2));
process.exitCode = finalFailures.length ? 1 : 0;

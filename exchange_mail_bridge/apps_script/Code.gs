const DEFAULT_SHEET_NAME = 'Exchange Mail';
const DEFAULT_ATTACHMENT_FOLDER_NAME = 'Exchange Mail Attachments';
const DEFAULT_BODY_FOLDER_NAME = 'Exchange Mail Bodies';
const BODY_TRANSPORT_VERSION = 2;
const MAX_BODY_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_POST_PAYLOAD_BYTES = 12 * 1024 * 1024;
const MAX_SHEET_BODY_UNITS = 45000;

function doGet() {
  const targetSheet = PropertiesService.getScriptProperties().getProperty('SHEET_ID') || '';
  return jsonResponse({
    ok: true,
    service: 'exchange-mail-bridge',
    protocolVersion: BODY_TRANSPORT_VERSION,
    targetSheetSha256: targetSheet ? sha256Utf8_(targetSheet) : '',
    message: 'POST messages to this web app endpoint.'
  });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const props = PropertiesService.getScriptProperties();
    const expectedToken = props.getProperty('BRIDGE_TOKEN');
    const sheetId = props.getProperty('SHEET_ID');
    const sheetName = props.getProperty('SHEET_NAME') || DEFAULT_SHEET_NAME;

    if (!expectedToken || !sheetId) {
      return jsonResponse({ ok: false, error: 'Missing SHEET_ID or BRIDGE_TOKEN in Script Properties.' }, 500);
    }

    const payload = parsePayload_(e);
    if (payload.token !== expectedToken) {
      return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401);
    }

    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    // Validate every declared v2 source before any Sheet/Drive mutation.
    try {
      messages.forEach((message) => {
        if (!message || typeof message !== 'object') throw new Error('Invalid message object.');
        if (message.bodyIntegrity !== undefined) verifyBodyIntegrity_(message);
        else if (utf8Bytes_(String(message.bodyHtml || '')) > MAX_BODY_SOURCE_BYTES) {
          throw new Error('Legacy HTML exceeds the hard byte limit; nothing was truncated.');
        }
      });
    } catch (error) {
      return jsonResponse({ ok: false, error: String(error.message || error) }, 422);
    }
    const sheet = getOrCreateSheet_(sheetId, sheetName);
    const headers = ensureHeader_(sheet);
    const columns = getColumnMap_(headers);

    const existingRows = getExistingIdRows_(sheet);
    const now = new Date().toISOString();
    let appended = 0;
    let skipped = 0;
    let updated = 0;

    messages.forEach((message) => {
      const messageId = clean_(message.id);
      if (!messageId) {
        skipped += 1;
        return;
      }

      const rowNumber = existingRows.get(messageId);
      const existingRow = rowNumber ? sheet.getRange(rowNumber, 1, 1, 17).getValues()[0] : null;
      const existingBodyHtmlLink = existingRow ? String(existingRow[columns.BodyHtmlLink - 1] || '') : '';
      const isV2 = Boolean(message.bodyIntegrity && message.bodyIntegrity.version === BODY_TRANSPORT_VERSION);
      // An older client must never downgrade a verified record or its source.
      if (!isV2 && parseBodyReceipt_(existingBodyHtmlLink)) {
        skipped += 1;
        return;
      }
      const existingAttachmentLinks = rowNumber && columns.AttachmentLinks
        ? clean_(sheet.getRange(rowNumber, columns.AttachmentLinks).getValue())
        : '';
      const hasStaleAttachmentLinks = Boolean(existingAttachmentLinks) && !validAttachmentLinks_(existingAttachmentLinks);
      const savedAttachmentLinks = hasStaleAttachmentLinks ? '' : existingAttachmentLinks;
      const attachmentLinks = savedAttachmentLinks || saveAttachments_(message, props);
      const hasStaleBodyHtmlLink = Boolean(existingBodyHtmlLink) && !validAttachmentLinks_(existingBodyHtmlLink);
      const savedBodyHtmlLink = hasStaleBodyHtmlLink ? '' : existingBodyHtmlLink;
      const bodyHtmlLink = isV2
        ? saveVerifiedBodySources_(message, props, existingBodyHtmlLink)
        : savedBodyHtmlLink || saveBodyHtml_(message, props);
      const importedAt = existingRow ? existingRow[columns.ImportedAt - 1] : now;
      const row = buildRow_(message, attachmentLinks, bodyHtmlLink, importedAt);

      if (rowNumber) {
        if (hasEnrichment_(message) || attachmentLinks || bodyHtmlLink || hasStaleAttachmentLinks || hasStaleBodyHtmlLink) {
          if (JSON.stringify(existingRow) === JSON.stringify(row)) {
            skipped += 1;
          } else {
            // Only the original seventeen transport columns. AutoReply and
            // other application columns after them are never read/rewritten.
            sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
            updated += 1;
          }
        } else {
          skipped += 1;
        }
        return;
      }

      const newRowNumber = sheet.getLastRow() + 1;
      sheet.getRange(newRowNumber, 1, 1, row.length).setValues([row]);
      existingRows.set(messageId, newRowNumber);
      appended += 1;
    });
    return jsonResponse({ ok: true, appended, updated, skipped, protocolVersion: BODY_TRANSPORT_VERSION });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error && error.message ? error.message : error) }, 500);
  } finally {
    lock.releaseLock();
  }
}

function setupConfigOnce() {
  PropertiesService.getScriptProperties().setProperties({
    SHEET_ID: 'PASTE_GOOGLE_SHEET_ID_HERE',
    BRIDGE_TOKEN: 'PASTE_LONG_RANDOM_TOKEN_HERE',
    SHEET_NAME: DEFAULT_SHEET_NAME,
    ATTACHMENT_FOLDER_NAME: DEFAULT_ATTACHMENT_FOLDER_NAME,
    BODY_FOLDER_NAME: DEFAULT_BODY_FOLDER_NAME
  }, true);
}

function authorizeDriveOnce() {
  getOrCreateDriveFolder_(DEFAULT_ATTACHMENT_FOLDER_NAME);
  getOrCreateDriveFolder_(DEFAULT_BODY_FOLDER_NAME);
}

function parsePayload_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('Missing JSON body.');
  }
  if (utf8Bytes_(e.postData.contents) > MAX_POST_PAYLOAD_BYTES) {
    throw new Error('JSON payload exceeds the hard byte limit; nothing was truncated.');
  }
  return JSON.parse(e.postData.contents);
}

function getOrCreateSheet_(sheetId, sheetName) {
  const spreadsheet = SpreadsheetApp.openById(sheetId);
  return spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
}

function ensureHeader_(sheet) {
  const headers = [
    'MessageId',
    'ReceivedTime',
    'FromName',
    'FromEmail',
    'Subject',
    'BodyPreview',
    'HasAttachments',
    'AttachmentCount',
    'AttachmentNames',
    'AttachmentLinks',
    'BodyImageUrls',
    'BodyHtmlLink',
    'BodyLinks',
    'BodyTextFull',
    'ConversationId',
    'WebLink',
    'ImportedAt'
  ];

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    return headers;
  }

  const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const isHeaderPresent = headers.every((header, index) => current[index] === header);
  if (!isHeaderPresent) {
    throw new Error('Unexpected transport column order; no existing columns were changed.');
  }
  return headers;
}

function getExistingIdRows_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return new Map();
  }

  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const rows = new Map();
  values.forEach((row, index) => {
    const messageId = String(row[0] || '');
    if (messageId) {
      rows.set(messageId, index + 2);
    }
  });
  return rows;
}

function getColumnMap_(headers) {
  return headers.reduce((columns, header, index) => {
    columns[header] = index + 1;
    return columns;
  }, {});
}

function buildRow_(message, attachmentLinks, bodyHtmlLink, importedAt) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  return [
    clean_(message.id),
    clean_(message.receivedTime),
    clean_(message.fromName),
    clean_(message.fromEmail),
    clean_(message.subject),
    clean_(message.bodyPreview),
    Boolean(message.hasAttachments || attachments.length > 0),
    Number(message.attachmentCount || attachments.length || 0),
    clean_(attachmentNames_(attachments)),
    clean_(attachmentLinks),
    clean_(bodyImageUrls_(message)),
    clean_(bodyHtmlLink),
    clean_(bodyLinks_(message)),
    message.bodyIntegrity && message.bodyIntegrity.version === BODY_TRANSPORT_VERSION
      ? bodyTextCell_(message.bodyTextFull, bodyHtmlLink)
      : clean_(message.bodyTextFull),
    clean_(message.conversationId),
    clean_(message.webLink),
    importedAt
  ];
}

function hasEnrichment_(message) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const bodyImageUrls = Array.isArray(message.bodyImageUrls) ? message.bodyImageUrls : [];
  const bodyLinks = Array.isArray(message.bodyLinks) ? message.bodyLinks : [];
  return attachments.length > 0
    || bodyImageUrls.length > 0
    || bodyLinks.length > 0
    || Boolean(message.bodyHtml)
    || Boolean(message.bodyTextFull)
    || Number(message.attachmentCount || 0) > 0;
}

function saveAttachments_(message, props) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (attachments.length === 0) {
    return '';
  }

  const folderName = props.getProperty('ATTACHMENT_FOLDER_NAME') || DEFAULT_ATTACHMENT_FOLDER_NAME;
  const folder = getOrCreateDriveFolder_(folderName);
  const links = [];

  attachments.forEach((attachment, index) => {
    if (!attachment.base64) {
      return;
    }

    const safeMessageId = clean_(message.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'message';
    const safeName = clean_(attachment.name || `attachment-${index + 1}`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    const fileName = `${safeMessageId}_${index + 1}_${safeName}`;
    const bytes = Utilities.base64Decode(attachment.base64);
    const blob = Utilities.newBlob(bytes, clean_(attachment.contentType) || MimeType.BINARY, fileName);
    const file = folder.createFile(blob);
    links.push(file.getUrl());
  });

  return links.join('\n');
}

function saveBodyHtml_(message, props) {
  const html = message.bodyHtml === null || message.bodyHtml === undefined ? '' : String(message.bodyHtml);
  if (utf8Bytes_(html) > MAX_BODY_SOURCE_BYTES) {
    throw new Error('Legacy HTML exceeds the hard byte limit; nothing was truncated.');
  }
  if (!html) {
    return '';
  }

  const folderName = props.getProperty('BODY_FOLDER_NAME') || DEFAULT_BODY_FOLDER_NAME;
  const folder = getOrCreateDriveFolder_(folderName);
  const safeMessageId = clean_(message.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'message';
  const safeSubject = clean_(message.subject || 'mail-body').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'mail-body';
  const fileName = `${safeMessageId}_${safeSubject}.html`;
  const file = folder.createFile(fileName, html, MimeType.HTML);
  return file.getUrl();
}

function sha256Utf8_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8)
    .map((value) => (value & 255).toString(16).padStart(2, '0')).join('');
}

function utf8Bytes_(value) {
  return Utilities.newBlob(String(value)).getBytes().length;
}

function verifyBodyIntegrity_(message) {
  const integrity = message && message.bodyIntegrity;
  if (!integrity || integrity.version !== BODY_TRANSPORT_VERSION) {
    throw new Error('Unsupported body transport integrity version.');
  }
  if (typeof message.id !== 'string' || !message.id || message.id.length > 50000 || /\u0000/.test(message.id)) {
    throw new Error('Invalid lossless transport message id.');
  }
  let totalBytes = 0;
  ['bodyHtml', 'bodyTextRaw', 'bodyTextFull'].forEach((name) => {
    const value = message[name];
    const expected = integrity[name];
    if (typeof value !== 'string' || !expected || !/^[a-f0-9]{64}$/.test(String(expected.sha256 || ''))
        || !Number.isSafeInteger(expected.utf8Bytes) || expected.utf8Bytes < 0
        || !Number.isSafeInteger(expected.utf16Length) || expected.utf16Length < 0) {
      throw new Error('Missing or invalid source integrity metadata for ' + name + '.');
    }
    const bytes = utf8Bytes_(value);
    totalBytes += bytes;
    if (value.length !== expected.utf16Length || bytes !== expected.utf8Bytes || sha256Utf8_(value) !== expected.sha256) {
      throw new Error('Source integrity mismatch for ' + name + '; no source was truncated.');
    }
  });
  if (totalBytes > MAX_BODY_SOURCE_BYTES) {
    throw new Error('Lossless transport source exceeds the hard byte limit; nothing was truncated.');
  }
  const sourceEnvelope = JSON.stringify({ version: BODY_TRANSPORT_VERSION, messageId: message.id,
    bodyIntegrity: integrity, bodyTextRaw: message.bodyTextRaw, bodyTextFull: message.bodyTextFull });
  if (utf8Bytes_(sourceEnvelope) > MAX_BODY_SOURCE_BYTES - 4096) {
    throw new Error('Lossless source manifest exceeds the hard byte limit; nothing was truncated.');
  }
  return integrity;
}

function parseBodyReceipt_(link) {
  const parts = String(link || '').split('#');
  if (parts.length !== 2 || !/^https:\/\/drive\.google\.com\//.test(parts[0])) {
    return null;
  }
  const values = {};
  parts[1].split('&').forEach((part) => {
    const index = part.indexOf('=');
    if (index > 0) values[part.slice(0, index)] = part.slice(index + 1);
  });
  return values.bridge === 'v2' && /^[a-f0-9]{64}$/.test(values.sha256 || '') ? values : null;
}

function verifiedStoredSourcesMatch_(link, message) {
  const receipt = parseBodyReceipt_(link);
  const expected = message.bodyIntegrity;
  if (!receipt || receipt.sha256 !== expected.bodyHtml.sha256
      || receipt.textSha256 !== expected.bodyTextFull.sha256 || receipt.rawTextSha256 !== expected.bodyTextRaw.sha256
      || Number(receipt.utf8Bytes) !== expected.bodyHtml.utf8Bytes || Number(receipt.utf16Length) !== expected.bodyHtml.utf16Length
      || !/^[a-zA-Z0-9_-]+$/.test(receipt.sourceManifestId || '') || !/^[a-f0-9]{64}$/.test(receipt.sourceManifestSha256 || '')) {
    return false;
  }
  const htmlId = String(link).match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!htmlId) return false;
  try {
    const html = DriveApp.getFileById(htmlId[1]).getBlob().getDataAsString('UTF-8');
    const source = DriveApp.getFileById(receipt.sourceManifestId).getBlob().getDataAsString('UTF-8');
    const manifest = JSON.parse(source);
    return html === message.bodyHtml && sha256Utf8_(source) === receipt.sourceManifestSha256
      && manifest.version === BODY_TRANSPORT_VERSION && manifest.messageId === message.id
      && manifest.bodyTextRaw === message.bodyTextRaw && manifest.bodyTextFull === message.bodyTextFull;
  } catch (error) {
    return false;
  }
}

function saveVerifiedBodySources_(message, props, existingLink) {
  const integrity = verifyBodyIntegrity_(message);
  if (verifiedStoredSourcesMatch_(existingLink, message)) return existingLink;
  const folder = getOrCreateDriveFolder_(props.getProperty('BODY_FOLDER_NAME') || DEFAULT_BODY_FOLDER_NAME);
  const safeMessageId = message.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'message';
  const stem = safeMessageId + '_' + integrity.bodyHtml.sha256.slice(0, 16);
  const htmlFile = folder.createFile(stem + '.html', message.bodyHtml, MimeType.HTML);
  const storedHtml = htmlFile.getBlob().getDataAsString('UTF-8');
  if (storedHtml !== message.bodyHtml || sha256Utf8_(storedHtml) !== integrity.bodyHtml.sha256) {
    throw new Error('Drive HTML read-back verification failed; no receipt was stored.');
  }
  const source = JSON.stringify({
    version: BODY_TRANSPORT_VERSION, messageId: message.id, bodyIntegrity: integrity,
    bodyHtmlLink: htmlFile.getUrl(), bodyTextRaw: message.bodyTextRaw, bodyTextFull: message.bodyTextFull
  });
  const sourceFile = folder.createFile(stem + '.source.json', source, 'application/json');
  if (sourceFile.getBlob().getDataAsString('UTF-8') !== source) {
    throw new Error('Drive source manifest read-back verification failed; no receipt was stored.');
  }
  return htmlFile.getUrl() + '#bridge=v2&sha256=' + integrity.bodyHtml.sha256
    + '&utf8Bytes=' + integrity.bodyHtml.utf8Bytes + '&utf16Length=' + integrity.bodyHtml.utf16Length
    + '&sourceManifestId=' + sourceFile.getId() + '&sourceManifestSha256=' + sha256Utf8_(source)
    + '&textSha256=' + integrity.bodyTextFull.sha256 + '&rawTextSha256=' + integrity.bodyTextRaw.sha256;
}

function bodyTextCell_(value, receiptLink) {
  const text = String(value || '');
  if (text.length <= MAX_SHEET_BODY_UNITS && !/\u0000/.test(text) && !/^=/.test(text)) return text;
  const receipt = parseBodyReceipt_(receiptLink);
  const sourceLink = receipt ? 'https://drive.google.com/file/d/' + receipt.sourceManifestId + '/view' : '';
  let preview = text.replace(/\u0000/g, '').slice(0, MAX_SHEET_BODY_UNITS);
  if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
  return '[BRIDGE-V2 VORSCHAU]\n' + preview + '\n[Vollstaendige unverkuerzte Quelle: ' + sourceLink + ']';
}

function validAttachmentLinks_(value) {
  const text = clean_(value);
  if (!text) {
    return false;
  }
  return text.split(/\s+/).some((part) => /^https?:\/\//i.test(part));
}

function getOrCreateDriveFolder_(folderName) {
  const folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(folderName);
}

function attachmentNames_(attachments) {
  return attachments
    .map((attachment) => attachment.name || attachment.contentId || attachment.contentType || 'attachment')
    .join('\n');
}

function bodyImageUrls_(message) {
  const urls = Array.isArray(message.bodyImageUrls) ? message.bodyImageUrls : [];
  return urls.join('\n');
}

function bodyLinks_(message) {
  const links = Array.isArray(message.bodyLinks) ? message.bodyLinks : [];
  return links.join('\n');
}

function clean_(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(/\u0000/g, '').slice(0, 50000);
}

function cleanLarge_(value, limit) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(/\u0000/g, '').slice(0, limit);
}

function jsonResponse(payload, statusCode) {
  if (statusCode) {
    payload.statusCode = statusCode;
  }

  const output = ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);

  // Apps Script web apps do not let us reliably set HTTP status codes from ContentService.
  return output;
}

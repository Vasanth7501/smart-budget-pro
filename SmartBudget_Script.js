// ╔══════════════════════════════════════════════════════╗
// ║     SmartBudget Pro — Google Apps Script Backend     ║
// ║   OTP Login + Multi-User Google Sheet Database       ║
// ║   Paste this ENTIRE file into Apps Script editor     ║
// ╚══════════════════════════════════════════════════════╝

// ── Sheet names (don't change these) ──
const S_USERS  = 'Users';
const S_DATA   = 'BudgetData';
const S_OTP    = 'OTPStore';
const S_BILLS  = 'Bills';

// ── OTP expires in 10 minutes ──
const OTP_TTL = 10 * 60 * 1000;

// ══════════════════════════════
//  MAIN ROUTER
// ══════════════════════════════
function doGet(e) {
  const p = e.parameter;
  const action = p.action || '';

  if (action === 'sendOTP')   return sendOTP(p.email);
  if (action === 'verifyOTP') return verifyOTP(p.email, p.otp);
  if (action === 'loadData')  return loadData(p.email, p.token);
  if (action === 'loadBills') return loadBills(p.email, p.token);
  if (action === 'ping')      return ok({ status: 'connected' });

  return err('Unknown action');
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action || '';

    if (action === 'saveMonth') return saveMonth(body.email, body.token, body.key, body.data);
    if (action === 'saveBills') return saveBills(body.email, body.token, body.bills);

    return err('Unknown action');
  } catch (ex) {
    return err(ex.message);
  }
}

// ══════════════════════════════
//  OTP — SEND
// ══════════════════════════════
function sendOTP(email) {
  if (!email || !isEmail(email))
    return err('Invalid email address');

  const otp    = String(Math.floor(100000 + Math.random() * 900000));
  const token  = Utilities.getUuid().replace(/-/g,'');
  const expiry = Date.now() + OTP_TTL;

  // Save OTP to sheet
  saveOTP(email.toLowerCase(), otp, expiry, token);

  // Send beautiful email
  try {
    GmailApp.sendEmail(
      email,
      'SmartBudget Pro — Your OTP',
      `Your OTP is: ${otp}\nValid for 10 minutes.`,
      {
        htmlBody: buildOTPEmail(otp),
        name: 'SmartBudget Pro'
      }
    );
    // Register user if new
    registerUser(email.toLowerCase());
    return ok({ sent: true });
  } catch (ex) {
    return err('Email send failed: ' + ex.message);
  }
}

// ══════════════════════════════
//  OTP — VERIFY
// ══════════════════════════════
function verifyOTP(email, otp) {
  if (!email || !otp) return err('Email and OTP required');

  const stored = getOTP(email.toLowerCase());
  if (!stored)             return err('No OTP found. Request a new one.');
  if (Date.now() > stored.expiry) return err('OTP expired. Request a new one.');
  if (stored.otp !== String(otp).trim()) return err('Wrong OTP. Try again.');

  // Clear OTP after successful verify
  clearOTP(email.toLowerCase());

  return ok({ verified: true, token: stored.token, email: email.toLowerCase() });
}

// ══════════════════════════════
//  BUDGET DATA — LOAD
// ══════════════════════════════
function loadData(email, token) {
  if (!email) return err('Email required');

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(S_DATA);
  if (!sheet) return ok({ months: {} });

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return ok({ months: {} });

  // Columns: A=email, B=monthKey, C=jsonData, D=updatedAt
  const rows   = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  const months = {};
  rows.forEach(r => {
    if (r[0].toLowerCase() === email.toLowerCase() && r[1]) {
      try { months[r[1]] = JSON.parse(r[2]); }
      catch(e) {}
    }
  });
  return ok({ months });
}

// ══════════════════════════════
//  BUDGET DATA — SAVE ONE MONTH
// ══════════════════════════════
function saveMonth(email, token, key, data) {
  if (!email || !key || !data) return err('Missing fields');

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(S_DATA);
  if (!sheet) {
    sheet = ss.insertSheet(S_DATA);
    sheet.appendRow(['Email', 'MonthKey', 'Data (JSON)', 'Updated At']);
    sheet.getRange(1,1,1,4).setBackground('#059669').setFontColor('#fff').setFontWeight('bold');
  }

  const lastRow = sheet.getLastRow();
  const emailLow = email.toLowerCase();

  // Find existing row for this email + month
  if (lastRow >= 2) {
    const emails = sheet.getRange(2, 1, lastRow-1, 2).getValues();
    for (let i = 0; i < emails.length; i++) {
      if (emails[i][0].toLowerCase() === emailLow && emails[i][1] === key) {
        const rowNum = i + 2;
        sheet.getRange(rowNum, 3).setValue(JSON.stringify(data));
        sheet.getRange(rowNum, 4).setValue(new Date());
        return ok({ saved: true, action: 'updated', row: rowNum });
      }
    }
  }

  // New row
  sheet.appendRow([emailLow, key, JSON.stringify(data), new Date()]);
  return ok({ saved: true, action: 'created' });
}

// ══════════════════════════════
//  BILLS — LOAD
// ══════════════════════════════
function loadBills(email, token) {
  if (!email) return err('Email required');

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(S_BILLS);
  if (!sheet) return ok({ bills: [] });

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return ok({ bills: [] });

  const rows = sheet.getRange(2, 1, lastRow-1, 2).getValues();
  for (const r of rows) {
    if (r[0].toLowerCase() === email.toLowerCase()) {
      try { return ok({ bills: JSON.parse(r[1]) }); }
      catch(e) { return ok({ bills: [] }); }
    }
  }
  return ok({ bills: [] });
}

// ══════════════════════════════
//  BILLS — SAVE
// ══════════════════════════════
function saveBills(email, token, bills) {
  if (!email) return err('Email required');

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(S_BILLS);
  if (!sheet) {
    sheet = ss.insertSheet(S_BILLS);
    sheet.appendRow(['Email', 'Bills (JSON)', 'Updated At']);
    sheet.getRange(1,1,1,3).setBackground('#2563eb').setFontColor('#fff').setFontWeight('bold');
  }

  const emailLow = email.toLowerCase();
  const lastRow  = sheet.getLastRow();

  if (lastRow >= 2) {
    const emails = sheet.getRange(2, 1, lastRow-1, 1).getValues().flat();
    const idx    = emails.findIndex(e => e.toLowerCase() === emailLow);
    if (idx >= 0) {
      const rowNum = idx + 2;
      sheet.getRange(rowNum, 2).setValue(JSON.stringify(bills));
      sheet.getRange(rowNum, 3).setValue(new Date());
      return ok({ saved: true });
    }
  }

  sheet.appendRow([emailLow, JSON.stringify(bills), new Date()]);
  return ok({ saved: true });
}

// ══════════════════════════════
//  USER REGISTRY
// ══════════════════════════════
function registerUser(email) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(S_USERS);
  if (!sheet) {
    sheet = ss.insertSheet(S_USERS);
    sheet.appendRow(['Email', 'First Login', 'Last Login', 'Login Count']);
    sheet.getRange(1,1,1,4).setBackground('#7c3aed').setFontColor('#fff').setFontWeight('bold');
  }

  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const emails = sheet.getRange(2, 1, lastRow-1, 1).getValues().flat();
    const idx    = emails.findIndex(e => e.toLowerCase() === email);
    if (idx >= 0) {
      const rowNum = idx + 2;
      const count  = sheet.getRange(rowNum, 4).getValue() || 0;
      sheet.getRange(rowNum, 3).setValue(new Date()); // last login
      sheet.getRange(rowNum, 4).setValue(count + 1);  // login count
      return;
    }
  }
  // New user
  sheet.appendRow([email, new Date(), new Date(), 1]);
}

// ══════════════════════════════
//  OTP HELPERS
// ══════════════════════════════
function saveOTP(email, otp, expiry, token) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(S_OTP);
  if (!sheet) {
    sheet = ss.insertSheet(S_OTP);
    sheet.hideSheet();
    sheet.appendRow(['Email', 'OTP', 'Expiry', 'Token']);
  }

  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const emails = sheet.getRange(2, 1, lastRow-1, 1).getValues().flat();
    const idx    = emails.findIndex(e => e === email);
    if (idx >= 0) {
      const rowNum = idx + 2;
      sheet.getRange(rowNum, 2, 1, 3).setValues([[otp, expiry, token]]);
      return;
    }
  }
  sheet.appendRow([email, otp, expiry, token]);
}

function getOTP(email) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(S_OTP);
  if (!sheet || sheet.getLastRow() < 2) return null;

  const rows = sheet.getRange(2, 1, sheet.getLastRow()-1, 4).getValues();
  for (const r of rows) {
    if (r[0] === email) return { otp: String(r[1]), expiry: Number(r[2]), token: String(r[3]) };
  }
  return null;
}

function clearOTP(email) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(S_OTP);
  if (!sheet || sheet.getLastRow() < 2) return;

  const emails = sheet.getRange(2, 1, sheet.getLastRow()-1, 1).getValues().flat();
  const idx    = emails.findIndex(e => e === email);
  if (idx >= 0) sheet.deleteRow(idx + 2);
}

// ══════════════════════════════
//  EMAIL TEMPLATE
// ══════════════════════════════
function buildOTPEmail(otp) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif">
  <div style="max-width:480px;margin:40px auto;border-radius:20px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,.12)">

    <!-- Header -->
    <div style="background:#0f172a;padding:32px;text-align:center">
      <div style="font-size:32px;margin-bottom:8px">💰</div>
      <div style="color:#4ade80;font-size:22px;font-weight:800;letter-spacing:-0.5px">SmartBudget Pro</div>
      <div style="color:#64748b;font-size:13px;margin-top:4px">Personal Finance Tracker</div>
    </div>

    <!-- Body -->
    <div style="background:#ffffff;padding:36px 32px;text-align:center">
      <p style="color:#374151;font-size:15px;margin-bottom:6px">Your one-time login code:</p>

      <!-- OTP Box -->
      <div style="background:#f0fdf4;border:2px solid #4ade80;border-radius:16px;padding:24px;margin:20px 0;display:inline-block;min-width:240px">
        <div style="font-size:42px;font-weight:900;letter-spacing:14px;color:#16a34a;font-family:monospace">${otp}</div>
      </div>

      <p style="color:#6b7280;font-size:13px;line-height:1.7;margin:0">
        ⏱️ Valid for <strong>10 minutes</strong><br>
        🔒 Don't share this code with anyone<br>
        ❌ Didn't request this? Ignore this email
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#f8fafc;padding:18px;text-align:center;border-top:1px solid #e2e8f0">
      <p style="color:#9ca3af;font-size:11px;margin:0">SmartBudget Pro · Secure Login · Powered by Google</p>
    </div>

  </div>
</body>
</html>`;
}

// ══════════════════════════════
//  UTILS
// ══════════════════════════════
function isEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

function ok(data) {
  return ContentService
    .createTextOutput(JSON.stringify({ success: true, ...data }))
    .setMimeType(ContentService.MimeType.JSON);
}

function err(msg) {
  return ContentService
    .createTextOutput(JSON.stringify({ success: false, error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ══════════════════════════════
//  AUTO CLEANUP (set daily trigger)
//  Apps Script → Triggers → cleanupOTPs → Daily
// ══════════════════════════════
function cleanupOTPs() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(S_OTP);
  if (!sheet || sheet.getLastRow() < 2) return;

  const rows = sheet.getRange(2, 1, sheet.getLastRow()-1, 3).getValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (Date.now() > Number(rows[i][2])) sheet.deleteRow(i + 2);
  }
}

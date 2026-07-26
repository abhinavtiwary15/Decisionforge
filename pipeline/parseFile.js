/**
 * pipeline/parseFile.js
 * Native Node.js module to parse headers and rows from CSV files.
 * Provides fallback header detection and row ingestion without Python dependency.
 */

const fs = require('fs');

/**
 * Split CSV line handling quotes
 */
function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' || char === "'") {
      if (inQuotes && line[i + 1] === char) {
        current += char;
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Reads first non-empty line of CSV file and returns list of headers.
 */
function detectCsvHeaders(filePath) {
  const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line) {
      const headers = parseCsvLine(line);
      return headers.filter(h => h !== null && h !== undefined && h !== '');
    }
  }
  throw new Error('CSV file is empty or contains no headers.');
}

/**
 * Reads CSV file and returns array of row objects mapping header -> value.
 */
function readCsvRows(filePath) {
  const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const lines = content.split(/\r?\n/);
  let headers = null;
  const rows = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const values = parseCsvLine(line);
    if (!headers) {
      headers = values.map(h => h.trim());
      continue;
    }

    const rowObj = {};
    let hasValue = false;
    headers.forEach((h, i) => {
      const val = values[i] !== undefined ? values[i] : '';
      rowObj[h] = val;
      if (val !== '') hasValue = true;
    });

    if (hasValue) {
      rows.append ? rows.push(rowObj) : rows.push(rowObj);
    }
  }

  return rows;
}

function parseDateVal(val) {
  if (!val) return [null, 'Date is missing'];
  const raw = String(val).trim();
  
  // Try DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD
  let match = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (match) {
    const d = match[1].padStart(2, '0');
    const m = match[2].padStart(2, '0');
    const y = match[3];
    return [`${y}-${m}-${d}`, null];
  }

  match = raw.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (match) {
    const y = match[1];
    const m = match[2].padStart(2, '0');
    const d = match[3].padStart(2, '0');
    return [`${y}-${m}-${d}`, null];
  }

  return [null, `Date '${raw}' is in an unsupported format.`];
}

function parseFloatVal(val, fieldName) {
  if (val === null || val === undefined || String(val).trim() === '') return [0.0, null];
  const raw = String(val).replace(/,/g, '').trim();
  const num = parseFloat(raw);
  if (isNaN(num)) return [0.0, `Field '${fieldName}' has non-numeric value '${val}'.`];
  return [num, null];
}

/**
 * Native Node JS Purchase Register Ingestion
 */
function ingestPurchaseRegisterJs(filePath, mapping) {
  const rows = readCsvRows(filePath);
  const records = [];
  const dataQualityFlags = [];
  const issues = [];
  
  const GSTIN_RE = /^(0[1-9]|[12][0-9]|3[0-7])[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/i;

  const requiredMapped = ['invoice_number', 'vendor_gstin', 'taxable_value'];

  rows.forEach((row, idx) => {
    const rowNum = idx + 2;
    let invoiceNumber = null;
    const invCol = mapping.invoice_number;
    if (invCol && row[invCol] !== undefined) {
      invoiceNumber = String(row[invCol] || '').trim();
    }

    const rowMissing = [];
    requiredMapped.forEach(req => {
      const mappedCol = mapping[req];
      if (!mappedCol || row[mappedCol] === undefined || row[mappedCol] === null || String(row[mappedCol]).trim() === '') {
        rowMissing.push(req);
      }
    });

    if (rowMissing.length > 0) {
      issues.push({
        row: rowNum,
        invoice_number: invoiceNumber || '<unknown>',
        field: 'mapping',
        problem: `Row is missing required columns: ${rowMissing.join(', ')}`
      });
      return;
    }

    const rawInvNum = String(row[mapping.invoice_number] || '').trim();
    const rawGstin = String(row[mapping.vendor_gstin] || '').trim();
    const rawTaxable = row[mapping.taxable_value];

    const rawName = mapping.vendor_name ? row[mapping.vendor_name] : null;
    const rawDate = mapping.invoice_date ? row[mapping.invoice_date] : null;
    const rawCgst = mapping.cgst ? row[mapping.cgst] : null;
    const rawSgst = mapping.sgst ? row[mapping.sgst] : null;
    const rawIgst = mapping.igst ? row[mapping.igst] : null;
    const rawItc = mapping.total_itc_claimed ? row[mapping.total_itc_claimed] : null;

    const [taxableVal, errTax] = parseFloatVal(rawTaxable, 'taxable_value');
    if (errTax) {
      issues.push({ row: rowNum, invoice_number: rawInvNum, field: 'taxable_value', problem: errTax });
      return;
    }

    const errList = [];
    let parsedDate = null;
    if (rawDate !== null && rawDate !== undefined && String(rawDate).trim() !== '') {
      const [pDate, errDate] = parseDateVal(rawDate);
      parsedDate = pDate;
      if (errDate) errList.push(['invoice_date', errDate]);
    }

    const [cgstVal, errCgst] = parseFloatVal(rawCgst, 'cgst');
    if (errCgst) errList.push(['cgst', errCgst]);

    const [sgstVal, errSgst] = parseFloatVal(rawSgst, 'sgst');
    if (errSgst) errList.push(['sgst', errSgst]);

    const [igstVal, errIgst] = parseFloatVal(rawIgst, 'igst');
    if (errIgst) errList.push(['igst', errIgst]);

    let [itcVal, errItc] = parseFloatVal(rawItc, 'total_itc_claimed');
    if (errItc) errList.push(['total_itc_claimed', errItc]);

    if (!mapping.total_itc_claimed && !errCgst && !errSgst && !errIgst) {
      itcVal = Math.round((cgstVal + sgstVal + igstVal) * 100) / 100;
    }

    if (errList.length > 0) {
      errList.forEach(([fld, msg]) => {
        issues.push({ row: rowNum, invoice_number: rawInvNum, field: fld, problem: msg });
      });
      return;
    }

    const validGstin = GSTIN_RE.test(rawGstin.toUpperCase());
    const recordDict = {
      invoice_number: rawInvNum,
      vendor_gstin: rawGstin.trim().toUpperCase(),
      vendor_name: rawName !== null && rawName !== undefined ? String(rawName).trim() : null,
      invoice_date: parsedDate,
      taxable_value: taxableVal,
      cgst: cgstVal,
      sgst: sgstVal,
      igst: igstVal,
      total_itc_claimed: itcVal
    };

    if (!validGstin) {
      dataQualityFlags.push({
        vendor_gstin: rawGstin,
        vendor_name: recordDict.vendor_name,
        invoice_number: rawInvNum,
        invoice_date: parsedDate,
        flag_type: 'INVALID_GSTIN',
        flag_detail: `GSTIN '${rawGstin}' failed structural format verification.`
      });
      issues.push({
        row: rowNum,
        invoice_number: rawInvNum,
        field: 'vendor_gstin',
        problem: `Invalid GSTIN format '${rawGstin}'`
      });
    } else {
      records.push(recordDict);
    }
  });

  const skipped = rows.length - records.length - dataQualityFlags.length;
  return {
    records,
    data_quality_flags: dataQualityFlags,
    summary: {
      total: rows.length,
      clean: records.length,
      flagged: dataQualityFlags.length,
      skipped,
      issues_count: issues.length
    },
    issues
  };
}

module.exports = {
  detectCsvHeaders,
  readCsvRows,
  ingestPurchaseRegisterJs
};

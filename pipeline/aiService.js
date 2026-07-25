/**
 * pipeline/aiService.js
 * =====================
 * Native Node.js service for Gemini API interaction, explanation generation,
 * communication drafting, and numeric grounding validation.
 *
 * Fully replaces spawnSync('python', ...) for Gemini features so Vercel Node
 * serverless deployment runs AI features directly with 0 Python dependency.
 */

const fs = require('fs');
const path = require('path');

// ── Environment & API Key Resolution ─────────────────────────────────────────
function getGeminiApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    const envLocalPath = path.join(__dirname, '..', '.env.local');
    if (fs.existsSync(envLocalPath)) {
      const content = fs.readFileSync(envLocalPath, 'utf8');
      for (const line of content.split('\n')) {
        if (line.trim().startsWith('GEMINI_API_KEY=')) {
          let val = line.trim().split('=', 2)[1];
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          return val;
        }
      }
    }
  } catch (e) {
    console.warn('[aiService] Failed to read .env.local for API key:', e.message);
  }
  return null;
}

// ── In-Memory Caches ──────────────────────────────────────────────────────────
const explanationCache = new Map();
const commCache = new Map();

// Load static file cache if available on startup/init
const EXPLANATION_CACHE_FILE = path.join(__dirname, '..', 'data', 'explanation_cache.json');
const COMM_CACHE_FILE = path.join(__dirname, '..', 'data', 'communication_cache.json');

try {
  if (fs.existsSync(EXPLANATION_CACHE_FILE)) {
    const data = JSON.parse(fs.readFileSync(EXPLANATION_CACHE_FILE, 'utf8'));
    Object.entries(data).forEach(([k, v]) => explanationCache.set(k, v));
  }
} catch (e) {}

try {
  if (fs.existsSync(COMM_CACHE_FILE)) {
    const data = JSON.parse(fs.readFileSync(COMM_CACHE_FILE, 'utf8'));
    Object.entries(data).forEach(([k, v]) => commCache.set(k, v));
  }
} catch (e) {}

// ── Formatters & Fallbacks ───────────────────────────────────────────────────
function fmtAmt(val) {
  if (val === null || val === undefined || val === '') return '0.00';
  const num = parseFloat(val);
  if (isNaN(num)) return String(val);
  return num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getFallbackExplanation(record) {
  const mismatchType = record.mismatch_type || 'UNKNOWN';
  const inv = record.invoice_number || 'unknown';
  const vendor = record.vendor_name || 'unknown';
  const prAmt = record.purchase_register_amount;
  const gstrAmt = record.gstr2b_amount;
  const atRisk = record.itc_at_risk;
  const fp = record.filing_period;

  if (mismatchType === 'CLEAN_MATCH') {
    return `Invoice ${inv} from vendor ${vendor} reconciles perfectly.`;
  } else if (mismatchType === 'TIMING_DIFFERENCE') {
    const fpStr = fp || 'a different period';
    return `Invoice ${inv} from vendor ${vendor} amounts match within tolerance, but was filed in GSTR-2B under period ${fpStr} -- timing difference.`;
  } else if (mismatchType === 'MISSING_IN_2B') {
    return `Invoice ${inv} claims Rs.${fmtAmt(prAmt)} ITC from vendor ${vendor} but has no corresponding entry in GSTR-2B; ITC at risk is Rs.${fmtAmt(atRisk)}.`;
  } else if (mismatchType === 'MISSING_IN_REGISTER') {
    return `Invoice ${inv} from vendor ${vendor} (taxable value Rs.${fmtAmt(gstrAmt)}) appears in GSTR-2B but was not recorded in the Purchase Register.`;
  } else if (mismatchType === 'AMOUNT_MISMATCH') {
    const diff = Math.abs(parseFloat(prAmt || 0) - parseFloat(gstrAmt || 0));
    return `Invoice ${inv} from vendor ${vendor} has a taxable value/tax amount mismatch: Purchase Register reports Rs.${fmtAmt(prAmt)} vs Rs.${fmtAmt(gstrAmt)} in GSTR-2B (difference Rs.${fmtAmt(diff)}).`;
  } else if (mismatchType === 'DUPLICATE_CLAIM') {
    return `Invoice ${inv} from vendor ${vendor} is claimed multiple times in the Purchase Register; ITC at risk is Rs.${fmtAmt(atRisk)}.`;
  } else {
    return `Invoice ${inv} from vendor ${vendor} has a reconciliation mismatch of type ${mismatchType}.`;
  }
}

function getFallbackCommunication(record, draftType, lang = 'en') {
  const inv = record.invoice_number || 'unknown';
  const vendor = record.vendor_name || 'unknown';
  const prAmt = record.purchase_register_amount;
  const gstrAmt = record.gstr2b_amount;
  const atRisk = record.itc_at_risk;
  const clientSalutation = record.client_name || 'Client';

  if (lang === 'hi') {
    if (draftType === 'vendor') {
      return `प्रिय टीम,\n\nहमारे रिकॉर्ड के अनुसार आपके द्वारा जारी किए गए इनवॉइस नंबर ${inv} का विवरण हमारे जीएसटीआर-2बी (GSTR-2B) में मेल नहीं खा रहा है।\nपरचेज रजिस्टर राशि: ₹${fmtAmt(prAmt)}\nजीएसटीआर-2बी राशि: ₹${fmtAmt(gstrAmt)}\nकृपया इस विसंगति की जांच करें और अपने जीएसटीआर-1 रिटर्न को संशोधित करें।\n\nसधन्यवाद`;
    } else {
      return `प्रिय ${clientSalutation},\n\nहम आपको सूचित करना चाहते हैं कि आपके इनवॉइस नंबर ${inv} (विक्रेता: ${vendor}) पर जीएसटी विसंगति पाई गई है।\n\nविवरण:\nइस विसंगति के कारण आपका ₹${fmtAmt(atRisk)} का इनपुट टैक्स क्रेडिट (ITC) अस्थायी रूप से जोखिम में है।\n\nअनुशंसित कार्रवाई:\nहम विक्रेता से संपर्क करने और उनके GSTR-1 रिटर्न को संशोधित कराने की सलाह देते हैं ताकि ITC दावा सुरक्षित किया जा सके।\n\nसादर,\nऑडिट टीम`;
    }
  } else {
    if (draftType === 'vendor') {
      return `Dear Vendor Team,\n\nWe noticed a GST reconciliation discrepancy regarding Invoice ${inv}.\nPurchase Register Amount: Rs. ${fmtAmt(prAmt)}\nGSTR-2B Reported Amount: Rs. ${fmtAmt(gstrAmt)}\nPlease review this discrepancy and amend your GSTR-1 filing as necessary.\n\nRegards`;
    } else {
      return `Dear ${clientSalutation},\n\nWe are writing to inform you regarding a GST reconciliation discrepancy identified for Invoice ${inv} issued by vendor ${vendor}.\n\nSummary of Discrepancy:\nThe Input Tax Credit (ITC) currently at risk of disallowance is Rs. ${fmtAmt(atRisk)}.\n\nRecommended Next Steps:\nWe advise submitting a formal compliance notice to the vendor requesting an immediate amendment in their GSTR-1 filing.\n\nRegards,\nAudit Team`;
    }
  }
}

// ── Grounding Verification ──────────────────────────────────────────────────
function validateNumericGrounding(text, record) {
  const prAmt = record.purchase_register_amount;
  const gstrAmt = record.gstr2b_amount;
  const atRisk = record.itc_at_risk;

  // 1. Compile allowed input values
  const allowedAmounts = [];
  [prAmt, gstrAmt, atRisk].forEach(val => {
    if (val !== null && val !== undefined && val !== '') {
      const num = parseFloat(val);
      if (!isNaN(num)) allowedAmounts.push(num);
    }
  });

  // 2. Compile digits of invoice_number and filing_period to exclude
  const invNum = String(record.invoice_number || '');
  const filingPer = String(record.filing_period || '');

  const excludedPatterns = new Set();
  (invNum.match(/\d+/g) || []).forEach(part => {
    excludedPatterns.add(part);
    excludedPatterns.add(String(parseInt(part, 10)));
  });
  (filingPer.match(/\d+/g) || []).forEach(part => {
    excludedPatterns.add(part);
    excludedPatterns.add(String(parseInt(part, 10)));
  });

  // 3. Find all potential numbers in generated text
  const rawTokens = text.match(/\b\d+(?:,\d+)*(?:\.\d+)?\b/g) || [];

  for (const token of rawTokens) {
    const cleanedToken = token.replace(/,/g, '');
    const valFloat = parseFloat(cleanedToken);
    if (isNaN(valFloat)) continue;

    const valIntStr = String(Math.floor(valFloat));
    if (excludedPatterns.has(valIntStr) || excludedPatterns.has(token)) {
      continue;
    }

    let isAmountShaped = false;
    if (valFloat >= 100) {
      isAmountShaped = true;
    } else if (token.includes('.')) {
      isAmountShaped = true;
    }

    if (!isAmountShaped) continue;

    let matched = false;
    for (const allowed of allowedAmounts) {
      if (Math.abs(valFloat - allowed) <= 1.0) {
        matched = true;
        break;
      }
    }

    if (!matched) {
      console.warn(`[aiService] Grounding verification failed: token '${token}' (${valFloat}) not in allowed ${JSON.stringify(allowedAmounts)}.`);
      return false;
    }
  }

  return true;
}

// ── Gemini REST API Call ─────────────────────────────────────────────────────
async function callGeminiApi(prompt, timeoutMs = 10000) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable not set.');
  }

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 300,
      thinkingConfig: { thinkingBudget: 0 }
    }
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`Gemini API HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error('Empty response payload from Gemini API.');
    }
    return text.trim();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── Public Service Functions ──────────────────────────────────────────────────

/**
 * Generate (or fetch cached) Gemini explanation for a single reconciliation match.
 */
async function generateExplanation(record) {
  const mid = record.invoice_id || record.gstr2b_id || `${record.invoice_number}_${record.vendor_gstin}`;

  if (explanationCache.has(mid)) {
    return explanationCache.get(mid);
  }

  const inv = record.invoice_number || 'unknown';
  const vendor = record.vendor_name || 'unknown';
  const prAmt = record.purchase_register_amount ?? record.pr_total_itc_claimed;
  const gstrAmt = record.gstr2b_amount ?? record.b_itc_available;
  const mtype = record.mismatch_type || 'UNKNOWN';

  const normRecord = {
    invoice_number: inv,
    vendor_name: vendor,
    purchase_register_amount: prAmt,
    gstr2b_amount: gstrAmt,
    itc_at_risk: record.itc_at_risk,
    mismatch_type: mtype,
    filing_period: record.filing_period
  };

  const fmt = (v) => (v === null || v === undefined || v === '' ? 'N/A' : parseFloat(v).toFixed(2));

  const prompt = `Facts:
- Invoice Number: ${inv}
- Vendor Name: ${vendor}
- Purchase Register ITC Amount: ${fmt(prAmt)}
- GSTR-2B ITC Amount: ${fmt(gstrAmt)}
- Mismatch Type: ${mtype}

Task:
Write a single concise sentence (under 30 words) explaining this GST reconciliation mismatch for a auditor. Use only the factual amounts provided above. Do not speculate or introduce any other numbers or facts.
Explanation:`;

  try {
    const rawText = await callGeminiApi(prompt, 12000);
    const cleaned = rawText.replace(/```/g, '').replace(/\*\*/g, '').trim();

    if (validateNumericGrounding(cleaned, normRecord)) {
      explanationCache.set(mid, cleaned);
      return cleaned;
    } else {
      console.warn(`[aiService] Grounding failed for explanation mid=${mid}. Using fallback.`);
    }
  } catch (e) {
    console.warn(`[aiService] Gemini API call failed for explanation mid=${mid}:`, e.message);
  }

  const fallback = getFallbackExplanation(normRecord);
  explanationCache.set(mid, fallback);
  return fallback;
}

/**
 * Generate (or fetch cached) communication draft (vendor or client) in English or Hindi.
 */
async function generateCommunicationDraft(record, draftType = 'vendor', lang = 'en') {
  const mid = record.match_id || record.invoice_id || record.gstr2b_id || `${record.invoice_number}_${record.vendor_gstin}`;
  const cacheKey = `${mid}:${draftType}:${lang}`;

  if (commCache.has(cacheKey)) {
    return commCache.get(cacheKey);
  }

  const inv = record.invoice_number || 'unknown';
  const vendor = record.vendor_name || 'unknown';
  const prAmt = record.purchase_register_amount ?? record.pr_total_itc_claimed;
  const gstrAmt = record.gstr2b_amount ?? record.b_itc_available;
  const atRisk = record.itc_at_risk;
  const clientName = record.client_name || 'Client';
  const mtype = record.mismatch_type || 'UNKNOWN';

  const normRecord = {
    match_id: mid,
    invoice_number: inv,
    vendor_name: vendor,
    client_name: clientName,
    purchase_register_amount: prAmt,
    gstr2b_amount: gstrAmt,
    itc_at_risk: atRisk,
    mismatch_type: mtype,
    filing_period: record.filing_period
  };

  const fmt = (v) => (v === null || v === undefined || v === '' ? 'N/A' : parseFloat(v).toFixed(2));
  const langInstruction = lang === 'en' ? 'Write in English.' : 'Write in Hindi (using Devanagari script).';

  let prompt = '';
  if (draftType === 'vendor') {
    prompt = `Facts:
- Invoice Number: ${inv}
- Purchase Register ITC Amount: ${fmt(prAmt)}
- GSTR-2B ITC Amount: ${fmt(gstrAmt)}
- Mismatch Type: ${mtype}

Task:
Write a professional and polite email to the vendor requesting them to check and amend their GST filing for this invoice. Do not speculate. Use only the factual amounts provided. Do not introduce any other figures or invoices.
${langInstruction}
Email:`;
  } else {
    prompt = `Facts:
- Client Name: ${clientName}
- Invoice Number: ${inv}
- Vendor Name: ${vendor}
- ITC At Risk Amount: ${fmt(atRisk)}

Task:
Write a complete, professional, multi-paragraph communication addressed directly to the client ('Dear ${clientName},'). Include a formal greeting using the client's name, an introductory paragraph introducing the GST reconciliation audit findings, a specific statement of the discrepancy and the exact ITC amount at risk, a recommended action paragraph for resolving the discrepancy with vendor ${vendor}, and a professional sign-off ('Regards, Audit Team'). Do not speculate. Use only the factual amounts provided. Do not introduce any other figures.
${langInstruction}
Summary:`;
  }

  try {
    const rawText = await callGeminiApi(prompt, 8000);
    const cleaned = rawText.replace(/```/g, '').replace(/\*\*/g, '').trim();

    if (validateNumericGrounding(cleaned, normRecord)) {
      commCache.set(cacheKey, cleaned);
      return cleaned;
    } else {
      console.warn(`[aiService] Grounding failed for comm draft key=${cacheKey}. Using fallback.`);
    }
  } catch (e) {
    console.warn(`[aiService] Gemini API call failed for comm draft key=${cacheKey}:`, e.message);
  }

  const fallback = getFallbackCommunication(normRecord, draftType, lang);
  commCache.set(cacheKey, fallback);
  return fallback;
}

module.exports = {
  validateNumericGrounding,
  getFallbackExplanation,
  getFallbackCommunication,
  generateExplanation,
  generateCommunicationDraft,
  callGeminiApi
};

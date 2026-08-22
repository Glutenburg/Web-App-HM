/* =========================================================================
 * TaHub shared parser module — SINGLE SOURCE OF TRUTH for workout parsing.
 *
 * Loaded two ways:
 *   - Browser:  <script src="lib/parser.js"></script>  ->  window.TaHubParser
 *   - Backend:  const P = require('../lib/parser')     (api/ serverless routes)
 *
 * Everything in here is pure (no DOM / localStorage / fetch), so the email
 * webhook parses files with EXACTLY the same logic as the manual upload UI.
 * ========================================================================= */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TaHubParser = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /* ---------- Constants ---------- */
  const ZONES = [
    { name: 'Z1', range: '< 140 bpm',    color: '#9ca3af' },
    { name: 'Z2', range: '140–150 bpm',  color: '#fc5200' },
    { name: 'Z3', range: '150–165 bpm',  color: '#f59e0b' },
    { name: 'Z4', range: '165–175 bpm',  color: '#ea580c' },
    { name: 'Z5', range: '175+ bpm',     color: '#dc2626' }
  ];
  const MAX_GPS_POINTS = 1500;
  const MAX_HR_SAMPLES = 1200;

  /* ---------- Tiny helpers ---------- */
  const pad2 = n => String(n).padStart(2, '0');
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /* ---------- Formatting & run math ---------- */
  // Pace (s/km) -> "M:SS" ; '—' when not computable
  function fmtPaceSec(secPerKm) {
    if (!isFinite(secPerKm) || secPerKm <= 0) return '—';
    const total = Math.round(secPerKm);
    return `${Math.floor(total / 60)}:${pad2(total % 60)}`;
  }
  function runPaceSec(run) {
    if (!run || !run.durationSec || !run.distanceKm) return NaN;
    return run.durationSec / run.distanceKm;
  }
  function fmtPacePerKm(run) {
    const p = fmtPaceSec(runPaceSec(run));
    return p === '—' ? p : p + '/km';
  }
  function fmtDuration(sec) {
    if (!isFinite(sec) || sec <= 0) return '—';
    const s = Math.round(sec);
    return `${Math.floor(s / 3600)}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
  }
  function isoDate(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  // Monday of the run's local date (weeks start Monday), as YYYY-MM-DD
  function mondayOf(iso) {
    const [y, m, d] = isoDate(iso).split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() - (dt.getDay() + 6) % 7);
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  }

  /* ---------- Flexible number extraction ---------- */
  // Accepts 8500 | {Avg:8500} | {Distance:8500} | [{...}] -> number | null
  function numLike(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (Array.isArray(v) && v.length) return numLike(v[0]);
    if (v && typeof v === 'object') {
      for (const k of ['Avg', 'Average', 'Value', 'Distance', 'Duration', 'Ascent', 'Sum', 'Max']) {
        if (typeof v[k] === 'number' && isFinite(v[k])) return v[k];
      }
    }
    return null;
  }
  // Suunto stores HR (and often cadence) in Hz — values < 5 are certainly Hz, multiply by 60.
  const toBpm = v => (v == null || isNaN(v)) ? null : (v < 5 ? Math.round(v * 60) : Math.round(v));
  function toSpm(v) {
    if (v == null || isNaN(v)) return null;
    let spm = v < 5 ? v * 60 : v;           // Hz -> steps/min
    if (spm >= 60 && spm < 110) spm *= 2;   // some devices log per-foot stride frequency
    return Math.round(spm);
  }

  /* ---------- Duration parsing ("1:02:03", "62:15", "62 min", "3723", "1h 5m 30s") ---------- */
  function parseDurationToken(str) {
    if (str == null) return null;
    const s = String(str).trim().toLowerCase().replace(/,/g, '');
    if (!s) return null;
    let m;
    if ((m = s.match(/^(\d{1,3}):(\d{2}):(\d{2})$/))) return +m[1] * 3600 + +m[2] * 60 + +m[3];
    if ((m = s.match(/^(\d{1,3}):(\d{2})$/))) return +m[1] * 60 + +m[2];            // MM:SS
    if ((m = s.match(/^(?:(\d+)\s*h)?[\s:]*(?:(\d+)\s*m(?:in|ins|utes?)?)?[\s:]*(?:(\d+)\s*s(?:ec|ecs|econds?)?)?$/)) && (m[1] || m[2] || m[3])) {
      return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
    }
    if ((m = s.match(/^(\d+(?:\.\d+)?)$/))) {
      const n = parseFloat(m[1]);
      return n > 180 ? n : n * 60;   // plain number: >180 read as seconds, otherwise minutes
    }
    return null;
  }

  /* ---------- Deep scans for series data (Suunto JSON) ---------- */
  function downsample(arr, maxN) {
    if (!arr || arr.length <= maxN) return arr;
    const step = (arr.length - 1) / (maxN - 1);
    return Array.from({ length: maxN }, (_, i) => arr[Math.round(i * step)]);
  }

  // Extract a numeric property from objects in a flat "Samples"-like array
  // (e.g. Samples[].HR or Samples[].Latitude). Returns array of numbers.
  function extractFromSamples(root, prop) {
    let arr = null;
    const visit = node => {
      if (arr || !node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        // large "Samples"-style array where some objects carry the property (check first 50 entries)
        if (!arr && node.length > 20 && node.slice(0, 50).some(o => o && typeof o === 'object' && prop in o)) { arr = node; return; }
        node.forEach(visit);
        return;
      }
      Object.values(node).forEach(visit);
    };
    visit(root);
    if (!arr) return [];
    return arr.map(s => typeof s[prop] === 'number' && isFinite(s[prop]) ? s[prop] : null).filter(v => v !== null);
  }

  // Recursively finds the longest numeric array whose key matches keyRe (e.g. HR sample series)
  function deepFindNumberArray(root, keyRe) {
    let best = null;
    const visit = node => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        if (keyRe.test(k) && Array.isArray(v) && v.length > 10 && v.every(n => typeof n === 'number' && isFinite(n))) {
          if (!best || v.length > best.length) best = v;
        }
        visit(v);
      }
    };
    visit(root);
    return best;
  }

  // Finds Latitude/Longitude arrays anywhere in the JSON (Values block, Samples of objects, ...),
  // converts radians -> degrees when needed, returns [[lat,lng], ...]
  function extractTrack(root) {
    const LAT_RE = /^(latitude|lat)$/i, LON_RE = /^(longitude|lng|lon)$/i;
    let best = null;      // {lat:[], lon:[]}
    let objPairs = null;  // array of {Latitude:.., Longitude:..}

    const visit = node => {
      if (Array.isArray(node)) {
        if (!objPairs && node.length > 3) {
          const withGPS = node.filter(o => o && typeof o === 'object' && typeof o.Latitude === 'number' && typeof o.Longitude === 'number');
          if (withGPS.length > 3) objPairs = withGPS;
        }
        node.forEach(visit);
        return;
      }
      if (!node || typeof node !== 'object') return;
      let latKey = null, lonKey = null;
      for (const k of Object.keys(node)) {
        if (!latKey && LAT_RE.test(k)) latKey = k;
        else if (!lonKey && LON_RE.test(k)) lonKey = k;
      }
      if (latKey && lonKey) {
        const la = node[latKey], lo = node[lonKey];
        if (Array.isArray(la) && Array.isArray(lo) && la.length > 5 && la.length === lo.length &&
            la.every(n => typeof n === 'number' && isFinite(n)) && lo.every(n => typeof n === 'number' && isFinite(n))) {
          if (!best || la.length > best.lat.length) best = { lat: la, lon: lo };
        }
      }
      Object.values(node).forEach(visit);
    };
    visit(root);
    if (objPairs && (!best || objPairs.length > best.lat.length)) {
      best = { lat: objPairs.map(o => o.Latitude), lon: objPairs.map(o => o.Longitude) };
    }
    if (!best) return [];

    // Radians or degrees? max |lat| <= 1.6 (< PI/2) strongly implies radians.
    const maxAbsLat = Math.max(...best.lat.map(Math.abs));
    const conv = v => maxAbsLat <= 1.6 ? v * (180 / Math.PI) : v;

    let pts = best.lat.map((la, i) => [
      Math.round(conv(la) * 1e5) / 1e5,
      Math.round(conv(best.lon[i]) * 1e5) / 1e5
    ]).filter(p => Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180);
    pts = downsample(pts, MAX_GPS_POINTS);
    return pts.length > 1 ? pts : [];
  }

  // Suunto DateTime: "/Date(1717245600000)/" or ISO string or epoch ms
  function parseHeaderDate(v) {
    if (v == null) return null;
    if (typeof v === 'number') return new Date(v).toISOString();
    const s = String(v);
    const m = s.match(/\/Date\((-?\d+)/);
    if (m) return new Date(parseInt(m[1], 10)).toISOString();
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  // The LOCAL calendar date the watch recorded (YYYY-MM-DD), independent of any
  // server timezone. "2026-08-21T04:38:33+07:00" -> "2026-08-21" even though its
  // UTC ISO is 2026-08-20T21:38Z. Used for record ids and Drive file names.
  function dateLocalFromHeader(v) {
    if (v == null) return null;
    if (typeof v === 'number') return new Date(v).toISOString().slice(0, 10);   // epoch: UTC date
    const s = String(v);
    const epoch = s.match(/\/Date\((-?\d+)/);
    if (epoch) return new Date(parseInt(epoch[1], 10)).toISOString().slice(0, 10);
    const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?(Z|[+-]\d{2}:?\d{2})?/);
    if (!m) return null;
    if (!m[2]) return m[1];                       // timezone-naive -> date exactly as written (device local)
    if (m[2] === 'Z') return m[1];                // UTC -> date as written
    const sign = m[2][0] === '-' ? -1 : 1;
    const offMin = sign * ((+m[2].slice(1, 3)) * 60 + +(m[2].slice(-2)));
    const d = new Date(s);                        // UTC instant
    if (isNaN(d.getTime())) return m[1];
    return new Date(d.getTime() + offMin * 60000).toISOString().slice(0, 10);   // wall-clock date at the offset
  }

  // Local date from free text that dateFromText would accept ("2026-08-21 06:38:33", ...)
  function dateLocalFromText(val) {
    if (!val) return null;
    const m = String(val).match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (m) return m[1];
    const d = new Date(String(val).trim().replace(/(\d)(st|nd|rd|th)/i, '$1'));
    return isNaN(d.getTime()) ? null : isoDate(d);
  }

  /* ---------- JSON parser (Suunto-style, incl. DeviceLog watch exports) ---------- */
  function parseSuuntoJson(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.DeviceLog && typeof data.DeviceLog === 'object') data = data.DeviceLog;   // e.g. "Ulsan"/Monkfish exports
    const H = data.Header || {};

    // Windows can sit top-level or in Header, each entry possibly wrapped: { Window: {...}, TimeISO8601 }
    const wins = [].concat(data.Windows || [], H.Windows || [])
      .map(w => (w && w.Window && typeof w.Window === 'object') ? w.Window : w)
      .filter(Boolean);
    const win = wins.find(w => w.Type === 'Move' || w.Type === 'Activity');
    const firstNum = (...vals) => { for (const v of vals) { const n = numLike(v); if (n != null) return n; } return null; };

    const distanceM = firstNum(H.Distance, win && win.Distance);
    const durationSec = firstNum(H.Duration, win && win.Duration);

    // HR from the Move/Activity window (Hz -> BPM), header fallback, sample-series fallback
    let hrAvg = null, hrMax = null;
    if (win && Array.isArray(win.HR) && win.HR[0]) { hrAvg = toBpm(win.HR[0].Avg); hrMax = toBpm(win.HR[0].Max); }
    if (hrAvg == null && H.HR) hrAvg = toBpm(numLike(H.HR));

    // HR sample series: per-sample objects (Samples[].HR) or numeric arrays (Values.HR)
    let hrSeries = extractFromSamples(data, 'HR');
    if (!hrSeries.length) hrSeries = deepFindNumberArray(data, /^(hr|heartrate|heart_rate)$/i) || [];
    if (hrSeries.length) {
      hrSeries = downsample(hrSeries, MAX_HR_SAMPLES)
        .map(v => toBpm(v))
        .filter(v => v != null && v > 60 && v < 240);
    }
    if (hrAvg == null && hrSeries.length) hrAvg = Math.round(hrSeries.reduce((a, b) => a + b, 0) / hrSeries.length);
    if (hrMax == null && hrSeries.length) hrMax = Math.max(...hrSeries);

    // Cadence: exact from StepCount / Duration (device-agnostic), else Move window (Hz), else sample mean.
    // Needed because some watches log per-foot stride frequency (Hz x120 = spm) instead of total spm.
    let cadence = null;
    const stepCount = numLike(H.StepCount);
    if (stepCount && durationSec) cadence = Math.round(stepCount / (durationSec / 60));
    if (cadence == null && win && Array.isArray(win.Cadence) && win.Cadence[0]) cadence = toSpm(win.Cadence[0].Avg);
    if (cadence == null) {
      const cadArr = extractFromSamples(data, 'Cadence');
      if (cadArr.length) cadence = toSpm(cadArr.reduce((a, b) => a + b, 0) / cadArr.length);
    }

    // Temperature: sample-series mean (Kelvin) is most accurate; header/window otherwise
    const tempLike = v => {
      if (typeof v === 'number' && isFinite(v)) return v;
      if (Array.isArray(v) && v.length) return tempLike(v[0]);
      if (v && typeof v === 'object') {
        if (typeof v.Avg === 'number') return v.Avg;
        if (typeof v.Max === 'number' && typeof v.Min === 'number') return (v.Max + v.Min) / 2;
      }
      return null;
    };
    let tempRaw = tempLike(H.Temperature);
    if (tempRaw == null && win) tempRaw = tempLike(win.Temperature);
    let tempC = tempRaw == null ? null : (tempRaw > 100 ? tempRaw - 273.15 : tempRaw);
    const tempSeries = extractFromSamples(data, 'Temperature');
    if (tempSeries.length) {
      const meanK = tempSeries.reduce((a, b) => a + b, 0) / tempSeries.length;
      tempC = Math.round((meanK - 273.15) * 10) / 10;
    } else if (tempC != null) {
      tempC = Math.round(tempC * 10) / 10;
    }

    const ascentM = firstNum(H.Ascent, win && win.Ascent);

    return {
      date: parseHeaderDate(H.DateTime),
      dateLocal: dateLocalFromHeader(H.DateTime),
      distanceKm: distanceM != null ? Math.round(distanceM / 10) / 100 : null,
      durationSec: durationSec,
      hrAvg: hrAvg,
      hrMax: hrMax,
      cadence: cadence,
      tempC: tempC,
      ascentM: ascentM != null ? Math.round(ascentM) : null,
      gps: extractTrack(data),
      hrSeries: hrSeries
    };
  }

  /* ---------- Markdown parser (regex) ---------- */
  // Extracts an ISO-ish date/datetime from arbitrary text ("2026-08-21 06:38:33", "Aug 20, 2026", ...)
  function dateFromText(val) {
    if (!val) return null;
    const s = String(val);
    const m = s.match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}))?)?/);
    if (m) {
      const d = new Date(`${m[1]}T${m[2] || '12:00'}:${m[3] || '00'}`);
      return isNaN(d.getTime()) ? null : d.toISOString();
    }
    const d = new Date(s.trim().replace(/(\d)(st|nd|rd|th)/i, '$1'));
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  function parseMarkdown(text) {
    const t = String(text || '');
    const grab = re => { const m = t.match(re); return m ? m[1] : null; };
    const grabLast = re => {
      const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let m, last = null; while ((m = rx.exec(t))) last = m; return last;
    };

    // date: "Date: ...", Thai "เวลาเริ่ม: ..." (Suunto MD reports), or first ISO date in the text
    const dateRaw = grab(/(?:date|เวลาเริ่ม|เวลาเริ่มต้น|start time)\s*[|:=]\s*(.+)/i)
      || grab(/\b(20\d{2}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)\b/);
    const date = dateRaw ? dateFromText(dateRaw) : null;
    const dateLocal = dateRaw ? dateLocalFromText(dateRaw) : null;

    const distM = t.match(/distance\s*[|:=]?\s*([\d.]+)\s*(km|kms|kilometers?|kilometres?|k|m|meters?|metres?|mi)?/i);
    let distanceKm = null;
    if (distM) {
      const val = parseFloat(distM[1]);
      const unit = (distM[2] || '').toLowerCase();
      if (/^k/.test(unit)) distanceKm = val;
      else if (/^m/.test(unit) && !/^mi/.test(unit)) distanceKm = val / 1000;
      else distanceKm = val > 60 ? val / 1000 : val;   // unitless: 8.5 -> km, 8500 -> m
    }

    // duration: "32:13", "1:02:03", "62 min", "1932.997 s" (also strips "1,932" grouping)
    const durM = t.match(/(?:duration|total time)\s*[|:=]\s*(\d{1,3}:\d{2}(?::\d{2})?|\d[\d.,]*\s*(?:h|hr|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)?)/i);
    const durationSec = durM ? parseDurationToken(durM[1]) : null;

    // HR: labelled first, then "HR: 140 / 175" pair, then JSON blobs like "HR":[{"Avg":2.403,"Max":3.017}]
    // embedded in MD reports (Hz -> BPM; the LAST blob is the Move/Activity window = whole workout)
    let hrAvg = grab(/(?:hr|heart\s?rate)[^\n:|]*avg[^\n:|]*[|:=]\s*(\d{2,3})/i) || grab(/avg[^\n:|]*(?:hr|heart\s?rate)[^\n:|]*[|:=]\s*(\d{2,3})/i);
    let hrMax = grab(/(?:hr|heart\s?rate)[^\n:|]*max[^\n:|]*[|:=]\s*(\d{2,3})/i) || grab(/max[^\n:|]*(?:hr|heart\s?rate)[^\n:|]*[|:=]\s*(\d{2,3})/i);
    if (hrAvg == null && hrMax == null) {
      const blob = grabLast(/"HR":\s*\[\s*\{\s*"Avg":([\d.]+)\s*,\s*"Max":([\d.]+)/i);
      if (blob) { hrAvg = toBpm(parseFloat(blob[1])); hrMax = toBpm(parseFloat(blob[2])); }
    }
    const hrPair = t.match(/(?:hr|heart\s?rate)\s*[|:=]\s*(\d{2,3})\s*\/\s*(\d{2,3})/i);
    if (hrPair) {
      if (hrAvg == null) hrAvg = hrPair[1];
      if (hrMax == null) hrMax = hrPair[2];
    } else if (hrAvg == null) {
      hrAvg = grab(/\bhr\s*[|:=]\s*(\d{2,3})/i);
    }

    // cadence: labelled, else exact StepCount / duration, else JSON blob ("Cadence":[{"Avg":1.154})
    let cadence = grab(/cadence[^\n:|]*[|:=]\s*(\d{2,3})\s*(?:spm)?/i);
    const stepM = grab(/step\s?count[^\n:|]*[|:=]\s*([\d,]+)/i);
    if (cadence == null && stepM && durationSec) {
      cadence = Math.round(parseFloat(stepM.replace(/,/g, '')) / (durationSec / 60));
    }
    if (cadence == null) {
      const cb = grabLast(/"Cadence":\s*\[\s*\{\s*"Avg":([\d.]+)/i);
      if (cb) cadence = toSpm(parseFloat(cb[1]));
    }

    const ascent = grab(/\bascent(?![a-z])[^\n:|]*[|:=]\s*(\d+(?:\.\d+)?)/i) || grab(/elevation[^\n:|]*[|:=]\s*(\d+(?:\.\d+)?)/i);

    // temp: first number on the "Temperature" line (skips "-" placeholders); Kelvin -> Celsius
    let temp = grab(/temp(?:erature)?\s*[|:=][^|\n]*?(-?\d+(?:\.\d+)?)/i);
    if (temp != null) {
      const tv = parseFloat(temp);
      temp = tv > 100 ? Math.round((tv - 273.15) * 10) / 10 : Math.round(tv * 10) / 10;
    }

    return {
      date, dateLocal, distanceKm, durationSec,
      hrAvg: hrAvg != null ? +hrAvg : null,
      hrMax: hrMax != null ? +hrMax : null,
      cadence: cadence != null ? +cadence : null,
      ascentM: ascent != null ? +ascent : null,
      tempC: temp, gps: [], hrSeries: []
    };
  }

  /* ---------- InBody CSV parser ---------- */
  // Splits one CSV row, respecting double-quoted fields
  function csvSplitLine(line) {
    const out = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ;
      } else if (ch === ',' && !inQ) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
  }

  // Normalizes a header cell: strips BOM, units "(kg)" / "(cm²)", dots and extra spaces
  const normKey = s => String(s).replace(/\uFEFF/g, '').replace(/\(.*?\)/g, '').replace(/\./g, '').replace(/\s+/g, ' ').trim().toLowerCase();

  // InBody dates come as "20260812081839" (local time); also accepts YYYYMMDD or free text
  function inbodyDate(v) {
    if (!v) return null;
    const s = String(v).trim();
    let m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).toISOString();
    m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0).toISOString();
    return dateFromText(s);
  }

  // "-" placeholders and "1,234" grouping -> number | null
  const numOrDash = v => {
    const s = String(v == null ? '' : v).trim();
    if (!s || s === '-' || s === '—') return null;
    const n = parseFloat(s.replace(/,/g, ''));
    return isNaN(n) ? null : n;
  };

  // normalized CSV header -> record field
  const INBODY_COLS = {
    'weight': 'weightKg',
    'skeletal muscle mass': 'smmKg',
    'soft lean mass': 'slmKg',
    'body fat mass': 'bfmKg',
    'bmi': 'bmi',
    'percent body fat': 'pbf',
    'basal metabolic rate': 'bmr',
    'inbody score': 'score',
    'right arm lean mass': 'leanRA', 'left arm lean mass': 'leanLA',
    'trunk lean mass': 'leanTrunk',
    'right leg lean mass': 'leanRL', 'left leg lean mass': 'leanLL',
    'right arm fat mass': 'fatRA', 'left arm fat mass': 'fatLA',
    'trunk fat mass': 'fatTrunk',
    'right leg fat mass': 'fatRL', 'left leg fat mass': 'fatLL',
    'waist hip ratio': 'whr',
    'waist circumference': 'waistCm',
    'visceral fat area': 'vfa',
    'visceral fat level': 'vfl',
    'total body water': 'tbwL',
    'intracellular water': 'icwL', 'extracellular water': 'ecwL',
    'ecw ratio': 'ecwRatio',
    'leg lean mass': 'legLeanKg',
    'protein': 'proteinKg',
    'mineral': 'mineralKg', 'bone mineral content': 'bmcKg',
    'body cell mass': 'bcmKg',
    'smi': 'smi',
    'whole body phase angle': 'phaseAngle'
  };

  // Parses an InBody CSV export into an array of records sorted by date (asc).
  // Returns [] when no usable measurement rows are found.
  function parseInBodyCsv(text) {
    const lines = String(text || '').split(/\r?\n/).filter(l => l.trim() !== '');
    if (lines.length < 2) return [];
    const headers = csvSplitLine(lines[0]).map(normKey);
    const dateIdx = headers.indexOf('date');
    if (dateIdx < 0) return [];
    const colMap = headers.map(h => INBODY_COLS[h] || null);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = csvSplitLine(lines[i]);
      const rec = {};
      cells.forEach((c, ci) => { if (colMap[ci]) rec[colMap[ci]] = numOrDash(c); });
      const date = inbodyDate(cells[dateIdx]);
      if (!date || rec.weightKg == null || !isFinite(rec.weightKg)) continue;  // junk / summary row
      rec.date = date;
      rec.id = 'b_' + date;                       // same timestamp = same scan (dedupe key)
      if (rec.pbf == null && rec.bfmKg != null) rec.pbf = Math.round(rec.bfmKg / rec.weightKg * 1000) / 10;
      rows.push(rec);
    }
    rows.sort((a, b) => new Date(a.date) - new Date(b.date));
    return rows;
  }

  /* ---------- HR zones ---------- */
  // Z1 <140 | Z2 140–150 | Z3 150–165 | Z4 165–175 | Z5 175+
  const hrZoneIndex = bpm => bpm >= 175 ? 4 : bpm >= 165 ? 3 : bpm >= 150 ? 2 : bpm >= 140 ? 1 : 0;

  function zoneDistribution(run) {
    if (!run) return null;
    const series = (run.hrSeries || []).filter(v => v > 60 && v < 240);
    if (series.length >= 10) {
      const counts = [0, 0, 0, 0, 0];
      series.forEach(v => counts[hrZoneIndex(v)]++);
      return { pcts: counts.map(c => c / series.length), mode: 'measured', samples: series.length };
    }
    if (run.hrAvg) {
      const ia = hrZoneIndex(run.hrAvg);
      const im = hrZoneIndex(Math.max(run.hrMax || run.hrAvg, run.hrAvg));
      const pcts = [0, 0, 0, 0, 0];
      if (ia === im) pcts[ia] = 1;
      else {
        const mids = []; for (let z = ia + 1; z < im; z++) mids.push(z);
        if (!mids.length) { pcts[ia] = 0.85; pcts[im] = 0.15; }
        else { pcts[ia] = 0.70; pcts[im] = 0.15; mids.forEach(z => pcts[z] = 0.15 / mids.length); }
      }
      return { pcts, mode: 'estimated' };
    }
    return null;
  }

  /* ---------- Record shaping ---------- */
  function guessType(res) {
    if (res.hrAvg != null && res.hrAvg >= 165) return 'Tempo';
    if (res.distanceKm != null && res.distanceKm >= 15) return 'Long';
    return 'Easy';
  }

  // Merges incoming records into an existing list by id (incoming wins).
  function mergeById(existing, incoming) {
    const map = new Map(existing.map(x => [x.id, x]));
    (incoming || []).forEach(x => { if (x && typeof x === 'object') map.set(x.id || uid(), x); });
    return [...map.values()];
  }

  // Normalizes a parsed result into a storable / syncable workout record.
  // CRITICAL: the record date ALWAYS comes from inside the file content —
  // never from the file name, and never from the email received time.
  // dateLocal is the watch's local calendar date (timezone-independent) and
  // drives the record id and the Google Drive file name.
  function toRecord(parsed, source, fileName) {
    const date = parsed.date;
    const dateLocal = parsed.dateLocal || (date ? isoDate(date) : null);
    return {
      id: 'w_' + dateLocal + '_' + Math.round((parsed.distanceKm || 0) * 100) + '_' + Math.round(parsed.durationSec || 0),
      date: date,
      dateLocal: dateLocal,
      type: guessType(parsed),
      distanceKm: parsed.distanceKm != null ? parsed.distanceKm : null,
      durationSec: parsed.durationSec != null ? parsed.durationSec : null,
      hrAvg: parsed.hrAvg != null ? parsed.hrAvg : null,
      hrMax: parsed.hrMax != null ? parsed.hrMax : null,
      cadence: parsed.cadence != null ? parsed.cadence : null,
      tempC: parsed.tempC != null ? parsed.tempC : null,
      ascentM: parsed.ascentM != null ? parsed.ascentM : null,
      gps: parsed.gps || [],
      hrSeries: parsed.hrSeries || [],
      source: source || 'manual',
      rawFileName: fileName || null,
      ingestedAt: new Date().toISOString()
    };
  }

  return {
    ZONES, MAX_GPS_POINTS, MAX_HR_SAMPLES,
    pad2, uid,
    fmtPaceSec, runPaceSec, fmtPacePerKm, fmtDuration, isoDate, mondayOf,
    numLike, toBpm, toSpm, parseDurationToken,
    downsample, extractFromSamples, deepFindNumberArray, extractTrack, parseHeaderDate,
    parseSuuntoJson, dateFromText, dateLocalFromHeader, dateLocalFromText, parseMarkdown,
    csvSplitLine, normKey, inbodyDate, numOrDash, INBODY_COLS, parseInBodyCsv,
    hrZoneIndex, zoneDistribution,
    guessType, mergeById, toRecord
  };
});

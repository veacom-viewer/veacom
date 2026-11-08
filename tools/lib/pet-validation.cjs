// What tools/pet-validation.cjs needs besides the desktop app: reading its two input files, reading a sphere's values
// as VEAcom shows them, the SUV factor's parts, comparing with the vendor's readings, and writing CSV. No patient data
// passes through here except the values themselves; docs/pet-validation.md is the protocol.
const path = require('node:path');

/** Acceptance limits in per cent (docs/pet-validation.md): SUVmax on the same voxel, SUVpeak across methods, and the SUV
 * factor and its parts. The same voxel is recognised by its activity concentration, read in both tools. */
const TOLERANCES = Object.freeze({ max: 1, peak: 5, factor: 0.2, sameVoxel: 0.5 });
const ROLES = Object.freeze(['lesion', 'liver', 'bloodPool']);
const QUANTITIES = Object.freeze(['SUVbw', 'SUL']);
/** What can be read for each sphere, as the vendor file names it, and how the CSV names it. */
const MEASURES = Object.freeze({ max: 'max', peak: 'peak', mean: 'mean', sd: 'sd', mtv: 'MTV 41%', tlg: 'TLG' });
/** VEAcom makes the liver reference 3 cm across, about its centre (docs/pet-quantification.md). */
const LIVER_RADIUS_MM = 15;
/** Lesion names in VEAcom: up to 24 characters, no control characters (src/domain/petStudies.ts). */
const NAME = /^[^\u0000-\u001f]{1,24}$/;

const isPoint = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const positive = value => Number.isFinite(value) && value > 0;

/** A study folder named relative to the studies folder, never outside it. */
function studyFolder(value, where) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${where}: "study" names the study's folder inside the studies folder.`);
  const normal = path.normalize(value);
  if (path.isAbsolute(normal) || normal === '..' || normal.startsWith(`..${path.sep}`)) throw new Error(`${where}: "study" must be a folder inside the studies folder, not ${value}.`);
  return value;
}

/** The spheres file: per study, its folder, which PET series (optional) and the spheres, centres in DICOM patient
 * coordinates (LPS, mm) and radii in mm. Throws with what to fix. */
function readSpheres(json) {
  if (!json || !Array.isArray(json.studies) || !json.studies.length) throw new Error('The spheres file needs a "studies" list.');
  const seen = new Set();
  const studies = json.studies.map((entry, index) => {
    const where = `Spheres file, study ${index + 1}`;
    const study = studyFolder(entry?.study, where);
    if (seen.has(study)) throw new Error(`${where}: ${study} is listed twice.`);
    seen.add(study);
    const series = entry.series ?? {};
    if (typeof series !== 'object' || (series.number !== undefined && !Number.isInteger(series.number))
      || (series.description !== undefined && (typeof series.description !== 'string' || !series.description))) {
      throw new Error(`${where}: "series" is { "number": <Series Number> } or { "description": "<part of Series Description>" }.`);
    }
    if (!Array.isArray(entry.spheres) || !entry.spheres.length) throw new Error(`${where}: "spheres" lists at least one sphere.`);
    const names = new Set(), roles = new Set();
    const spheres = entry.spheres.map((sphere, at) => {
      const place = `${where} (${study}), sphere ${at + 1}`;
      const role = sphere?.role ?? 'lesion';
      if (!ROLES.includes(role)) throw new Error(`${place}: "role" is one of ${ROLES.join(', ')}.`);
      if (typeof sphere.name !== 'string' || !NAME.test(sphere.name)) throw new Error(`${place}: "name" is 1 to 24 characters.`);
      if (names.has(sphere.name)) throw new Error(`${place}: the name ${sphere.name} is used twice.`);
      names.add(sphere.name);
      if (role !== 'lesion' && roles.has(role)) throw new Error(`${place}: a study has one ${role} reference.`);
      roles.add(role);
      if (!isPoint(sphere.center)) throw new Error(`${place}: "center" is [x, y, z] in mm, DICOM patient coordinates (LPS).`);
      if (role === 'liver' && sphere.radius !== undefined && sphere.radius !== LIVER_RADIUS_MM) {
        throw new Error(`${place}: the liver reference is 3 cm across; leave out "radius" or give ${LIVER_RADIUS_MM}.`);
      }
      const radius = role === 'liver' ? LIVER_RADIUS_MM : sphere.radius;
      if (!positive(radius) || radius > 200) throw new Error(`${place}: "radius" is in mm, above 0 and at most 200.`);
      return { name: sphere.name, role, center: [...sphere.center], radius };
    });
    return { study, series: { ...(series.number !== undefined ? { number: series.number } : {}), ...(series.description ? { description: series.description } : {}) }, spheres };
  });
  return { studies };
}

/** The vendor file: the workstation's readings per study and sphere, by quantity (SUVbw, SUL) and measure, with the
 * SUV parameters it used where it shows them. Throws with what to fix. */
function readVendor(json) {
  if (!json || !Array.isArray(json.studies)) throw new Error('The vendor file needs a "studies" list.');
  const tolerances = { ...TOLERANCES };
  for (const [key, value] of Object.entries(json.tolerances ?? {})) {
    if (!(key in TOLERANCES) || !(Number.isFinite(value) && value >= 0)) throw new Error(`Vendor file: tolerances are per cent for ${Object.keys(TOLERANCES).join(', ')}.`);
    tolerances[key] = value;
  }
  const number = (value, where) => {
    if (value === undefined) return undefined;
    if (!Number.isFinite(value)) throw new Error(`${where} is a number.`);
    return value;
  };
  const studies = new Map();
  json.studies.forEach((entry, index) => {
    const where = `Vendor file, study ${index + 1}`;
    const study = studyFolder(entry?.study, where);
    if (studies.has(study)) throw new Error(`${where}: ${study} is listed twice.`);
    const suv = entry.suv ?? {};
    const parameters = {
      factor: number(suv.factor, `${where}: suv.factor (SUVbw per Bq/ml)`),
      weightKg: number(suv.weightKg, `${where}: suv.weightKg`), heightM: number(suv.heightM, `${where}: suv.heightM`),
      doseMBq: number(suv.doseMBq, `${where}: suv.doseMBq`),
      sex: suv.sex === undefined ? undefined : String(suv.sex).toUpperCase(),
      injectionTime: suv.injectionTime === undefined ? undefined : String(suv.injectionTime),
    };
    if (parameters.injectionTime !== undefined) clockSeconds(parameters.injectionTime, `${where}: suv.injectionTime`);
    const spheres = new Map();
    for (const [name, sphere] of Object.entries(entry.spheres ?? {})) {
      const reading = {};
      for (const quantity of QUANTITIES) {
        if (sphere?.[quantity] === undefined) continue;
        reading[quantity] = {};
        for (const [measure, value] of Object.entries(sphere[quantity])) {
          if (!(measure in MEASURES)) throw new Error(`${where}, ${name}: ${quantity} measures are ${Object.keys(MEASURES).join(', ')}.`);
          reading[quantity][measure] = number(value, `${where}, ${name}, ${quantity}.${measure}`);
        }
      }
      reading.maxBqml = number(sphere?.maxBqml, `${where}, ${name}: maxBqml`);
      spheres.set(name, reading);
    }
    studies.set(study, { study, software: entry.software ?? json.software ?? '', suv: parameters, spheres });
  });
  return { software: json.software ?? '', tolerances, studies };
}

/** Seconds since midnight from "HH:MM", "HH:MM:SS" or DICOM TM ("HHMMSS.ffffff"). */
function clockSeconds(value, where = 'A time') {
  const text = String(value).trim(), match = /^(\d{2}):?(\d{2})(?::?(\d{2}(?:\.\d+)?))?$/.exec(text);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`${where} is HH:MM or HH:MM:SS.`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0);
}

const number = text => Number(text.replace(',', '.'));
/** A sphere's values as VEAcom's measurement list shows them in English (src/imaging/voi.ts, formatSphereStatistics):
 * "SUVbw max 7.00 · SUVpeak 7.00 · mean 6.12 · 33.5 mL · ⌀ 40.0 mm · MTV 41% 14.08 mL · TLG 98.6 SUVbw·mL · σ 2.41 ·
 * 523 voxels". The parts it does not know go to `notes`. */
function parseSphereValues(text) {
  const parts = String(text).split(' · ').map(part => part.trim()).filter(Boolean);
  const first = /^(\S+) max (-?[\d.,]+|—)$/.exec(parts[0] ?? '');
  if (!first) throw new Error(`Not a sphere's values: ${text}`);
  const values = { quantity: first[1], max: number(first[2]), notes: [] };
  for (const part of parts.slice(1)) {
    let match;
    if ((match = /^SU[VL]peak (-?[\d.,]+)$/.exec(part))) values.peak = number(match[1]);
    else if (/^SU[VL]peak unavailable/.test(part)) values.peakUnavailable = true;
    else if ((match = /^mean (-?[\d.,]+)$/.exec(part))) values.mean = number(match[1]);
    else if ((match = /^min (-?[\d.,]+)$/.exec(part))) values.min = number(match[1]);
    else if ((match = /^σ (-?[\d.,]+)$/.exec(part))) values.sd = number(match[1]);
    else if ((match = /^(\d+) voxels?$/.exec(part))) values.voxels = Number(match[1]);
    else if ((match = /^([\d.,]+) mL$/.exec(part))) values.volumeMl = number(match[1]);
    else if ((match = /^⌀ ([\d.,]+) mm$/.exec(part))) values.diameterMm = number(match[1]);
    else if ((match = /^MTV 41% ([\d.,]+) mL$/.exec(part))) values.mtv = number(match[1]);
    else if ((match = /^TLG ([\d.,]+) \S+·mL$/.exec(part))) values.tlg = number(match[1]);
    else if (!/^SULglu /.test(part)) values.notes.push(part);
  }
  for (const key of ['max', 'peak', 'mean', 'min', 'sd', 'volumeMl', 'diameterMm', 'mtv', 'tlg']) {
    if (key in values && !Number.isFinite(values[key])) delete values[key];
  }
  return values;
}

/** Lean body mass over weight by Janmahasatian et al. 2005, which VEAcom uses for SUL (native/src/ingest.rs), and by
 * James 1976, which some workstations use: to explain an SUL difference. Null without weight, height and sex. */
function leanBodyMassRatios({ weightKg, heightM, sex }) {
  if (!positive(weightKg) || !(heightM >= 0.3 && heightM <= 2.5) || !['M', 'F'].includes(sex)) return null;
  const bmi = weightKg / heightM ** 2, centimetres = heightM * 100;
  const janmahasatian = sex === 'M' ? 9270 * weightKg / (6680 + 216 * bmi) : 9270 * weightKg / (8780 + 244 * bmi);
  const james = sex === 'M' ? 1.1 * weightKg - 128 * (weightKg / centimetres) ** 2 : 1.07 * weightKg - 148 * (weightKg / centimetres) ** 2;
  return { janmahasatian: janmahasatian / weightKg, james: james > 0 ? james / weightKg : null };
}

/** The decay interval, in minutes, that an SUVbw factor implies: factor = weight (g) / (dose × 2^(−t / half-life)). */
function decayMinutes({ factorPerBqml, weightKg, doseBq, halfLifeSeconds }) {
  if (![factorPerBqml, weightKg, doseBq, halfLifeSeconds].every(positive)) return null;
  return halfLifeSeconds * Math.log2(factorPerBqml * doseBq / (weightKg * 1000)) / 60;
}

const percent = (value, reference) => Number.isFinite(value) && Number.isFinite(reference) && reference !== 0 ? (value - reference) / Math.abs(reference) * 100 : null;
const round = (value, digits = 6) => value === null || value === undefined || !Number.isFinite(value) ? value : Number(value.toPrecision(digits));
const signed = value => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(2)}%`;

/**
 * VEAcom's readings side by side with the vendor's, one row per value. SUVmax and SUVpeak are held to their limits,
 * and the SUV factor and its parameters (weight, height, activity, injection time, sex) to the factor's; means, MTV
 * and TLG are reported without a limit. A note suggests the cause of a difference: another voxel, another SUV factor,
 * another lean body mass formula, another SUVpeak method. Statuses: within, beyond, reported (no limit) and missing
 * (VEAcom gave no value).
 * @param studies VEAcom's readings, as tools/pet-validation.cjs collects them
 * @param vendor  readVendor's result
 */
function compare(studies, vendor) {
  const rows = [], { tolerances } = vendor;
  const add = ({ study, sphere = '', quantity = '', measure, veacom, theirs, tolerance, note = '', status }) => {
    const known = veacom !== undefined && veacom !== null && veacom !== '';
    const difference = known && typeof veacom === 'number' ? percent(veacom, theirs) : null;
    status ??= !known ? 'missing' : tolerance === undefined || difference === null ? 'reported' : Math.abs(difference) <= tolerance + 1e-9 ? 'within' : 'beyond';
    rows.push({ study, sphere, quantity, measure, veacom: typeof veacom === 'number' ? round(veacom) : veacom, vendor: typeof theirs === 'number' ? round(theirs) : theirs,
      difference_percent: difference === null ? '' : Number(difference.toFixed(3)), tolerance_percent: tolerance ?? '', status,
      note: status === 'missing' && !note ? 'VEAcom gave no value' : note });
  };
  for (const [name, expected] of vendor.studies) {
    const measured = studies.find(item => item.study === name);
    if (!measured || measured.error) { add({ study: name, measure: 'study', note: measured?.error ?? 'Not in the spheres file' }); continue; }
    const factor = measured.factor, ratios = leanBodyMassRatios(factor), parameters = expected.suv;
    const factorDifference = parameters.factor === undefined || !factor.suvbwPerBqml ? null : percent(factor.suvbwPerBqml, parameters.factor);
    const minutes = factorDifference === null || !factor.halfLifeSeconds ? null : factor.halfLifeSeconds * Math.log2(1 + factorDifference / 100) / 60;
    const factorNote = factorDifference === null || Math.abs(factorDifference) <= tolerances.factor ? ''
      : `The SUV factors differ by ${signed(factorDifference)}${minutes === null ? '' : `, as ${Math.abs(minutes).toFixed(1)} min of decay would`}.`;
    // The SUV factor and what it is made of, where the vendor shows them.
    if (parameters.factor !== undefined) add({ study: name, measure: 'SUVbw factor (per Bq/ml)', veacom: factor.suvbwPerBqml, theirs: parameters.factor, tolerance: tolerances.factor,
      note: factorNote && `${factorNote} Compare weight, activity and the decay interval.` });
    if (parameters.weightKg !== undefined) add({ study: name, measure: 'weight (kg)', veacom: factor.weightKg, theirs: parameters.weightKg, tolerance: tolerances.factor });
    if (parameters.heightM !== undefined) add({ study: name, measure: 'height (m)', veacom: factor.heightM, theirs: parameters.heightM, tolerance: tolerances.factor });
    if (parameters.doseMBq !== undefined) {
      const ours = factor.doseBq === undefined ? undefined : factor.doseBq / 1e6, difference = percent(ours, parameters.doseMBq);
      add({ study: name, measure: 'injected activity (MBq)', veacom: ours, theirs: parameters.doseMBq, tolerance: tolerances.factor,
        note: difference !== null && Math.abs(difference) > tolerances.factor ? 'A residual activity the vendor subtracts would show here.' : '' });
    }
    if (parameters.sex !== undefined) {
      const ours = factor.sex || undefined;
      add({ study: name, measure: 'sex', veacom: ours, theirs: parameters.sex, status: ours === undefined ? 'missing' : ours === parameters.sex ? 'within' : 'beyond' });
    }
    if (parameters.injectionTime !== undefined) {
      const given = clockSeconds(parameters.injectionTime), toSecond = /\d{2}:\d{2}:\d{2}|^\d{6}/.test(parameters.injectionTime);
      const ours = factor.injectionTime ? clockSeconds(factor.injectionTime) : undefined, apart = ours === undefined ? null : ours - given;
      add({ study: name, measure: 'injection time', veacom: formatClock(ours), theirs: parameters.injectionTime,
        status: apart === null ? 'missing' : Math.abs(apart) < (toSecond ? 1 : 60) ? 'within' : 'beyond', note: apart !== null && Math.abs(apart) >= (toSecond ? 1 : 60) ? `${Math.round(apart)} s apart` : '' });
    }
    for (const [sphereName, reading] of expected.spheres) {
      const sphere = measured.spheres.find(item => item.name === sphereName);
      if (!sphere || sphere.error) { add({ study: name, sphere: sphereName, measure: 'sphere', note: sphere?.error ?? 'Not in the spheres file for this study' }); continue; }
      let sameVoxel = null;
      if (reading.maxBqml !== undefined) {
        if (sphere.maxBqml === undefined) add({ study: name, sphere: sphereName, quantity: 'Bq/ml', measure: 'max', veacom: '', theirs: reading.maxBqml, status: 'reported',
          note: 'VEAcom cannot give this series in Bq/ml' });
        else {
          sameVoxel = Math.abs(percent(sphere.maxBqml, reading.maxBqml)) <= tolerances.sameVoxel;
          add({ study: name, sphere: sphereName, quantity: 'Bq/ml', measure: 'max', veacom: sphere.maxBqml, theirs: reading.maxBqml, tolerance: tolerances.sameVoxel,
            note: sameVoxel ? 'The same voxel' : 'Not the same voxel: check that both spheres hold the same hottest voxel' });
        }
      }
      for (const quantity of QUANTITIES) {
        const ours = sphere.values?.[quantity];
        for (const [measure, value] of Object.entries(reading[quantity] ?? {})) {
          if (value === undefined) continue;
          const veacom = ours?.[measure], limit = tolerances[measure];
          let note = '';
          if (!ours) note = quantity === 'SUL' && sphere.values?.SUVbw ? 'VEAcom gives no SUL: the file lacks height or sex' : 'VEAcom gives no SUV for this series';
          else if (veacom === undefined && measure === 'peak') note = ours.peakUnavailable ? 'No complete 1 cm³ sphere fits inside the VOI' : '';
          else if (veacom === undefined && (measure === 'mtv' || measure === 'tlg')) note = sphere.mtvNote || 'No MTV for this sphere';
          else if (veacom !== undefined && limit !== undefined && Math.abs(percent(veacom, value)) > limit) {
            const causes = [];
            if (measure === 'max' && sameVoxel === false) causes.push('Not the same voxel (see Bq/ml).');
            if (measure === 'max' && sameVoxel === true) causes.push('The same voxel, so the SUV factors differ.');
            if (measure === 'peak') causes.push('SUVpeak methods differ: VEAcom takes the highest 1 cm³ mean anywhere inside the VOI.');
            if (factorNote) causes.push(factorNote);
            if (quantity === 'SUL' && ratios?.james && Math.abs(percent(ratios.james / ratios.janmahasatian * veacom, value)) <= limit) {
              causes.push('SUL by the James lean body mass matches; VEAcom uses Janmahasatian.');
            }
            note = causes.join(' ');
          } else if (sphere.mtvNote && (measure === 'mtv' || measure === 'tlg')) note = sphere.mtvNote;
          add({ study: name, sphere: sphereName, quantity: measure === 'mtv' ? 'mL' : quantity, measure: MEASURES[measure], veacom, theirs: value, tolerance: limit, note });
        }
      }
    }
  }
  return rows;
}

const formatClock = seconds => seconds === undefined ? undefined
  : [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, Math.floor(seconds % 60)].map(part => String(part).padStart(2, '0')).join(':');

/** RFC 4180 CSV with a header row: numbers as written in JavaScript (a dot for decimals), text quoted when it needs it. */
function toCsv(rows, columns) {
  const cell = value => {
    if (value === undefined || value === null) return '';
    const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : Array.isArray(value) ? value.join(' ') : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `${[columns.join(','), ...rows.map(row => columns.map(column => cell(row[column])).join(','))].join('\r\n')}\r\n`;
}

/** Whether `file` lies inside the folder `root` (the repository): real studies and their readings stay out of it. */
function inside(file, root) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

module.exports = { TOLERANCES, ROLES, QUANTITIES, MEASURES, LIVER_RADIUS_MM, readSpheres, readVendor, parseSphereValues, leanBodyMassRatios,
  decayMinutes, clockSeconds, compare, toCsv, inside, percent };

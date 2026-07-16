// Prisahub NHS Jobs API - Production v9
// Single file, no imports, no dependencies

const CACHE = new Map();
const TTL   = 30 * 60 * 1000; // 30 minutes

// ── HTML PARSING ──────────────────────────────────────────────
function dec(s) {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&nbsp;/g,' ');
}
function clean(s) {
  return dec(s.replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();
}
function getBand(text) {
  const t = text.toLowerCase();
  const nm = t.match(/\bband\s*(\d+)\b/);
  if (nm) return parseInt(nm[1]);
  const words = {two:2,three:3,four:4,five:5,six:6,seven:7,eight:8};
  const wm = t.match(/\bband\s+(two|three|four|five|six|seven|eight)\b/);
  if (wm) return words[wm[1]];
  return undefined;
}
function pickField(block, ...attrs) {
  for (const attr of attrs) {
    const re = new RegExp('<li[^>]*data-test="' + attr + '"[^>]*>([\\s\\S]*?)<\\/li>', 'i');
    const m  = block.match(re);
    if (m) {
      const v = clean(m[1]).replace(/^[A-Za-z &\/]+:\s*/, '').trim();
      if (v) return v;
    }
  }
  return '';
}

function parseNhs(html) {
  const jobs = [];
  const re   = /<li[^>]*class="[^"]*\bsearch-result\b[^"]*"[^>]*>([\s\S]*?)(?=<li[^>]*class="[^"]*\bsearch-result\b|<\/ul)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const b  = m[1];
    const tm = b.match(/<a[^>]*href="(\/candidate\/jobadvert\/[^"]+)"[^>]*data-test="search-result-job-title"[^>]*>([\s\S]*?)<\/a>/i)
            || b.match(/<a[^>]*data-test="search-result-job-title"[^>]*href="(\/candidate\/jobadvert\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!tm) continue;

    const href  = dec(tm[1]);
    const title = clean(tm[2]);
    if (!title) continue;
    const url = 'https://www.jobs.nhs.uk' + href;

    let org = 'NHS', loc = 'United Kingdom';
    const lb = b.match(/<div[^>]*data-test="search-result-location"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="nhsuk-grid-row/i);
    if (lb) {
      const inn = lb[1];
      const om  = inn.match(/<h3[^>]*>([\s\S]*?)<div[^>]*class="location-font-size"/i);
      if (om) org = clean(om[1]);
      const lm  = inn.match(/<div[^>]*class="location-font-size"[^>]*>([\s\S]*?)<\/div>/i);
      if (lm) loc = clean(lm[1]).replace(/,\s*$/, '');
    }

    const salary   = pickField(b, 'search-result-salary');
    const contract = pickField(b, 'search-result-jobType', 'search-result-contract');
    const pattern  = pickField(b, 'search-result-workingPattern', 'search-result-working-pattern');
    const closing  = pickField(b, 'search-result-closingDate', 'search-result-closing-date');
    let   posted   = pickField(b, 'search-result-publicationDate', 'search-result-posted', 'search-result-datePosted');

    if (!posted) {
      const dm = b.match(/(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i);
      if (dm) posted = dm[1];
    }

    const idM  = href.match(/\/jobadvert\/([^?#]+)/);
    const id   = idM ? idM[1] : (jobs.length + '-' + title.slice(0, 15));

    // Extract band from ALL text in the block - catches explicit "Band 2" fields
    const allBlockText = b.replace(/<[^>]+>/g, ' ');
    const band = getBand(title + ' ' + salary + ' ' + allBlockText);

    jobs.push({
      id, title, organisation: org, location: loc,
      salary:       salary   || undefined,
      band,
      postedDate:   posted   || undefined,
      closingDate:  closing  || undefined,
      contractType: contract || undefined,
      workingPattern: pattern || undefined,
      url,
    });
  }
  return jobs;
}

// ── DATE SORTING ──────────────────────────────────────────────
const MO = {
  january:1,february:2,march:3,april:4,may:5,june:6,
  july:7,august:8,september:9,october:10,november:11,december:12,
  jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
};
function parseDate(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m) {
    const mo = MO[m[2].toLowerCase()];
    if (mo) return m[3] + '-' + String(mo).padStart(2,'0') + '-' + m[1].padStart(2,'0');
  }
  return null;
}
function newestFirst(a, b) {
  const da = parseDate(a.postedDate), db = parseDate(b.postedDate);
  if (!da && !db) return 0;
  if (!da) return 1;
  if (!db) return -1;
  return db < da ? -1 : db > da ? 1 : 0;
}

// ── FETCHER ───────────────────────────────────────────────────
const HDRS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
};

async function fetchPage(kw, loc, page, sal, ft, minBand) {
  const ck = 'pg:' + kw + ':' + loc + ':' + page + ':' + sal + ':' + (ft?1:0) + ':' + (minBand||0);
  const hit = CACHE.get(ck);
  if (hit && Date.now() - hit.at < TTL) return hit.v;

  const p = new URLSearchParams({
    keyword:      kw,
    language:     'en',
    contractType: 'Permanent',
    payScheme:    'AfC',        // NHS AfC only — blocks all private employers
  });
  if (loc)      p.set('location',       loc);
  if (page > 1) p.set('page',           String(page));
  if (sal > 0)  p.set('salaryFrom',     String(sal));
  if (ft)       p.set('workingPattern', 'fullTime');
  // Add band filter for support workers - blocks Band 2 at NHS Jobs source level
  if (minBand && minBand >= 3) {
    const bands = ['Band 3','Band 4','Band 5','Band 6','Band 7','Band 8a','Band 8b','Band 8c','Band 8d'];
    bands.slice(minBand - 3).forEach(b => p.append('payBand', b));
  }

  try {
    const r = await fetch('https://www.jobs.nhs.uk/candidate/search/results?' + p, {
      headers: HDRS,
      signal:  AbortSignal.timeout(10000),
    });
    if (!r.ok) return [];
    const jobs = parseNhs(await r.text());
    CACHE.set(ck, { at: Date.now(), v: jobs });
    return jobs;
  } catch { return []; }
}

// ── FILTER ────────────────────────────────────────────────────
function isNhs(org) {
  const o = (org || '').toLowerCase();
  return o.includes('nhs') || o.includes('trust') || o.includes('hospital') ||
         o.includes('health board') || o.includes('integrated care') ||
         o.includes('ambulance') || o.includes('foundation') ||
         o.includes('primary care') || o.includes('healthcare');
}

function reject(job) {
  const t   = (job.title        || '').toLowerCase();
  const ct  = (job.contractType || '').toLowerCase();
  const wp  = (job.workingPattern|| '').toLowerCase();
  const sal = (job.salary       || '').toLowerCase();
  const all = t + ' ' + ct + ' ' + sal;

  // Band 2 — reject if explicitly stated anywhere
  if (/\bband\s*2\b/.test(all))    return true;
  if (/\bband\s+two\b/.test(all))  return true;
  if (/\bafc\s*:?\s*band\s*2\b/.test(all)) return true;
  // Parsed band number is 2 or below
  if (job.band !== undefined && job.band <= 2) return true;

  // Not permanent
  if (ct && !ct.includes('permanent')) return true;

  // Bank shifts
  if (/\bbank\b/.test(t) && !t.includes('blood bank') && !t.includes('eye bank') && !t.includes('bank manager')) return true;

  // Fixed term / locum / temp
  if (/\b(fixed[\-\s]?term|locum|secondment|temporary|agency)\b/.test(all)) return true;

  // Part time
  if (wp.includes('part time') || wp.includes('part-time')) return true;
  if (t.includes('part time')  || t.includes('part-time'))  return true;

  return false;
}

function applyFilters(jobs, cat) {
  return jobs.filter(j => {
    if (!isNhs(j.organisation)) return false;
    if (reject(j))              return false;
    if (cat.exLoc && j.location.toLowerCase().includes(cat.exLoc)) return false;
    if (cat.minBand && j.band !== undefined && j.band < cat.minBand) return false;
    if (cat.maxBand && j.band !== undefined && j.band > cat.maxBand) return false;
    const t = (j.title || '').toLowerCase();
    if (cat.exc && cat.exc.some(x => t.includes(x))) return false;
    if (cat.inc && !cat.inc.some(x => t.includes(x))) return false;
    return true;
  });
}

// ── MAIN FETCH LOOP ───────────────────────────────────────────
async function getCategoryJobs(cat) {
  const ck = 'cat:' + cat.id + ':v12';
  const hit = CACHE.get(ck);
  if (hit && Date.now() - hit.at < TTL) return hit.v;

  const keywords = Array.isArray(cat.kw) ? cat.kw : [cat.kw];
  const seen = new Set(), all = [];

  for (const kw of keywords) {
    for (let pg = 1; pg <= 5; pg++) {          // max 5 pages per keyword
      const jobs = await fetchPage(kw, cat.loc || '', pg, cat.sal || 0, cat.ft || false, cat.minBand || 0);
      if (!jobs.length) break;
      let added = 0;
      for (const j of jobs) {
        const key = j.id || j.url;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(j);
        added++;
      }
      if (!added) break;                        // no new jobs on this page — stop
    }
  }

  const filtered = applyFilters(all, cat);
  filtered.sort(newestFirst);

  CACHE.set(ck, { at: Date.now(), v: filtered });
  return filtered;
}

// ── KEYWORD & FILTER LISTS ────────────────────────────────────

const SW_KW = [
  'healthcare assistant','healthcare support worker','clinical support worker',
  'nursing assistant','ward support worker','patient support worker',
  'patient care assistant','therapy support worker','mental health support worker',
  'learning disability support worker','maternity support worker',
  'theatre support worker','community support worker','rehabilitation support worker',
  'assistant practitioner','care navigator','peer support worker',
  'occupational therapy assistant','physiotherapy assistant',
  'operating department support worker','emergency department support worker',
  'critical care support worker','oncology support worker','cardiology support worker',
  'dialysis support worker','palliative care support worker',
  'neonatal support worker','paediatric support worker','radiology support worker',
];
const SW_INC = [
  'healthcare support worker','healthcare assistant','health care assistant','hcsw','hca',
  'clinical support worker','nursing assistant','senior healthcare support worker',
  'ward support worker','patient support worker','patient care assistant',
  'assistant practitioner','therapy support worker','occupational therapy assistant',
  'occupational therapy support worker','physiotherapy assistant','physiotherapy support worker',
  'speech and language therapy assistant','therapy assistant','rehabilitation assistant',
  'rehabilitation support worker','rehab therapy assistant',
  'mental health support worker','mental health healthcare assistant',
  'psychiatric support worker','psychiatric nursing assistant',
  'mental health clinical support worker','picu support worker','crisis support worker',
  'dementia support worker','forensic mental health support worker',
  'learning disability support worker','autism support worker',
  'positive behaviour support worker','behaviour support worker','intensive support worker',
  'community support worker','community healthcare support worker',
  'community rehabilitation support worker','community mental health support worker',
  'community falls support worker','community health and wellbeing worker',
  'maternity support worker','maternity care assistant',
  'neonatal support worker','neonatal healthcare assistant',
  'paediatric support worker','nursery assistant',
  'theatre support worker','operating department support worker',
  'perioperative support worker','endoscopy support worker','sterile services support worker',
  'emergency department support worker','a&e support worker',
  'critical care support worker','icu support worker','hdu support worker',
  'acute medical unit support worker','renal support worker','dialysis support worker',
  'oncology support worker','cancer support worker','chemotherapy support worker',
  'cardiology support worker','stroke support worker','respiratory support worker',
  'orthopaedic support worker','diabetes support worker','pain management support worker',
  'palliative care support worker','hospice support worker',
  'radiology support worker','imaging assistant','laboratory support worker',
  'outpatient support worker','clinic support worker',
  'gp healthcare assistant','primary care support worker',
  'care navigator','peer support worker','social prescribing link worker',
  'mortuary assistant','decontamination support worker',
];
const SW_EXC = [
  'registered nurse','staff nurse','charge nurse','ward sister',
  'nurse specialist','nurse consultant','nurse practitioner','advanced nurse',
  'community nurse','district nurse','school nurse','practice nurse',
  'nurse associate','nursing associate','student nurse',
  'midwife','midwifery','doctor','consultant','registrar','physician','surgeon',
  'scientist','technician','physiologist','pharmacist','radiographer',
  'psychologist','paramedic','sonographer','biomedical',
  'healthcare scientist','clinical scientist','pharmacy technician',
  'occupational therapist','physiotherapist','speech and language therapist',
  'dietitian','dietician','podiatrist','social worker',
  'ward manager','service manager','clinical manager','team manager',
  'general manager','deputy manager','head of','director',
];

const ADMIN_KW = [
  'administrator','administrative assistant','administration officer',
  'business support','business administrator','receptionist','medical secretary',
  'personal assistant','executive assistant','patient services administrator',
  'admissions coordinator','waiting list coordinator','referral coordinator',
  'booking coordinator','outpatient administrator','patient pathway coordinator',
  'patient access administrator','health records officer','medical records administrator',
  'hr administrator','workforce administrator','esr administrator',
  'project administrator','programme support officer','pmo administrator',
  'data administrator','information officer','service administrator',
  'corporate administrator','operations coordinator','business support officer',
  'project support officer','clinical systems administrator','epr administrator',
  'governance administrator','quality administrator','complaints administrator',
  'transformation administrator','service improvement administrator',
  'executive support officer','board administrator','committee administrator',
  'training administrator','education coordinator','research administrator',
  'clinical trials administrator','communications manager','office manager',
  'patient booking coordinator','cancer pathway coordinator','theatre booking coordinator',
];
const ADMIN_INC = [
  'administrative assistant','administrator','administration officer',
  'administrative officer','administrative coordinator','senior administrator',
  'administration team leader','office administrator','business administrator',
  'executive administrator','receptionist','medical receptionist','senior receptionist',
  'outpatient receptionist','ward receptionist','clinic receptionist',
  'health records receptionist','switchboard operator',
  'medical secretary','senior medical secretary','personal assistant',
  'executive assistant','team secretary','clinical secretary',
  'divisional secretary','directorate secretary','executive support officer',
  'patient services administrator','patient pathway coordinator',
  'patient pathway administrator','patient access administrator',
  'patient booking coordinator','appointments administrator',
  'admissions officer','admissions coordinator','waiting list coordinator',
  'referral coordinator','clinic coordinator','outpatient administrator',
  'theatre booking coordinator','cancer pathway coordinator',
  'health records clerk','health records officer','medical records officer',
  'medical records administrator','clinical coding administrator','records coordinator',
  'hr administrator','workforce administrator','recruitment administrator',
  'medical staffing administrator','esr administrator','people administrator',
  'workforce officer','learning and development administrator',
  'temporary staffing administrator','finance administrator','finance assistant',
  'accounts assistant','payroll administrator','procurement administrator',
  'purchasing officer','supplies administrator','accounts payable officer',
  'accounts receivable officer','information administrator','data administrator',
  'information officer','data quality officer','systems administrator',
  'digital administrator','epr administrator','clinical systems administrator',
  'governance administrator','quality administrator','risk administrator',
  'compliance administrator','audit administrator','complaints administrator',
  'patient safety administrator','project administrator','project support officer',
  'programme support officer','pmo administrator','project coordinator',
  'transformation administrator','service improvement administrator',
  'operational administrator','operations coordinator','service administrator',
  'directorate administrator','department administrator','divisional administrator',
  'business support officer','business support administrator','operational support officer',
  'community administrator','community services administrator','mental health administrator',
  'community team administrator','crisis team administrator','camhs administrator',
  'therapy administrator','maternity administrator','neonatal administrator',
  'paediatric administrator','research administrator','clinical trials administrator',
  'medical education administrator','training administrator','education coordinator',
  'corporate administrator','board administrator','committee administrator',
  'corporate governance administrator','executive office administrator',
  'senior administrative officer','administration manager','office manager',
  'business manager','operations manager','corporate services manager',
  'service manager','general manager',
  'communications manager','communications officer','communications adviser',
  'senior communications officer','head of communications','media officer',
  'press officer','social media manager','internal communications manager',
  'public affairs manager','stakeholder engagement manager','marketing manager',
  'content manager','patient engagement manager','patient experience manager',
  'community engagement manager','policy officer','policy manager','policy adviser',
  'information governance officer','data protection officer','foi officer',
  'facilities manager','facilities officer','facilities coordinator',
];
const ADMIN_EXC = [
  'nurse','nursing','doctor','consultant','registrar','physician','surgeon',
  'midwife','therapist','pharmacist','radiographer','psychologist','paramedic',
  'sonographer','support worker','healthcare assistant','hca',
  'biomedical','social worker','scientist','technician',
];

const HR_KW = [
  'human resources','hr adviser','hr officer','hr business partner',
  'hr administrator','workforce administrator','workforce adviser',
  'workforce information','workforce planning','recruitment adviser',
  'recruitment officer','resourcing adviser','talent acquisition adviser',
  'medical staffing officer','employee relations adviser',
  'organisational development','learning and development',
  'esr administrator','esr officer','hr systems analyst',
  'people analytics','staff experience','wellbeing adviser',
  'edi officer','inclusion manager','hr analyst','people analyst',
  'hr data analyst','hr project officer','workforce transformation',
  'head of people','head of workforce','director of workforce','director of people',
];
const HR_INC = [
  'hr assistant','hr administrator','hr officer','hr adviser','hr advisor',
  'senior hr adviser','hr business partner','senior hr business partner',
  'lead hr business partner','hr manager','head of human resources',
  'director of human resources','chief people officer',
  'workforce administrator','workforce officer','workforce adviser',
  'workforce information officer','workforce analyst','workforce planning analyst',
  'workforce planning manager','workforce development manager',
  'workforce transformation manager','workforce project manager',
  'recruitment administrator','recruitment officer','recruitment adviser',
  'recruitment business partner','recruitment manager',
  'resourcing officer','resourcing adviser','talent acquisition adviser',
  'talent acquisition partner','talent acquisition manager',
  'medical recruitment officer','medical staffing officer','medical staffing manager',
  'employee relations officer','employee relations adviser',
  'senior employee relations adviser','employee relations manager',
  'case manager hr','hr case adviser',
  'learning and development administrator','learning and development officer',
  'learning and development adviser','learning and development manager',
  'l&d administrator','l&d officer','l&d manager',
  'organisational development officer','organisational development adviser',
  'od business partner','od manager','leadership development manager',
  'training coordinator','education coordinator',
  'esr administrator','esr officer','esr systems analyst',
  'payroll officer','payroll manager','hr systems administrator','hr systems analyst',
  'hris analyst','reward adviser','reward manager','job evaluation adviser',
  'edi officer','edi adviser','inclusion manager','workforce equality officer',
  'staff experience officer','staff wellbeing officer','wellbeing adviser',
  'health and wellbeing manager','staff experience manager',
  'hr project officer','hr project manager','workforce transformation officer',
  'people transformation manager','hr change manager',
  'hr analyst','people analyst','workforce information analyst',
  'hr data analyst','people analytics manager','hr reporting analyst',
  'deputy head of hr','head of people','head of workforce',
  'associate director of hr','deputy director of hr',
  'director of workforce','director of people',
];
const HR_EXC = [
  'nurse','doctor','support worker','healthcare assistant',
  'project manager','programme manager','it engineer','software',
  'biomedical','radiographer','pharmacist',
];

const EST_KW = [
  'estates manager','estates officer','estates operations manager',
  'estates maintenance manager','estates project manager','head of estates',
  'facilities manager','building services manager','capital projects manager',
  'property manager','engineering manager','compliance manager',
  'hard fm manager','asset manager','estates assistant','estates administrator',
  'estates coordinator','fire safety manager','water safety manager',
  'energy manager','sustainability manager','estate surveyor','property surveyor',
  'electrical engineering manager','mechanical engineering manager',
  'building services engineer','estates engineer',
  'associate director of estates','director of estates',
  'capital project manager','construction project manager',
  'infrastructure manager','maintenance manager','maintenance coordinator',
];
const EST_INC = [
  'estates assistant','estates administrator','estates officer',
  'assistant estates officer','estates coordinator','estates support officer',
  'property assistant','maintenance coordinator','facilities officer',
  'facilities coordinator','estates manager','assistant estates manager',
  'estates operations manager','estates maintenance manager',
  'building services manager','property manager','facilities manager',
  'compliance manager','contracts manager','engineering manager',
  'hard fm manager','maintenance manager','senior estates manager',
  'head of estates','head of estates and facilities','head of property',
  'estates programme manager','capital projects manager','capital development manager',
  'estate development manager','operational estates manager','infrastructure manager',
  'engineering services manager','strategic estates manager','asset manager',
  'associate director of estates','deputy director of estates',
  'director of estates','chief estates officer','director of capital projects',
  'estates compliance manager','fire safety manager','water safety manager',
  'authorised person','responsible person','health and safety manager',
  'energy manager','sustainability manager','environmental manager',
  'capital projects officer','capital project manager','estates project manager',
  'capital delivery manager','construction project manager',
  'property surveyor','estate surveyor','commercial estates manager',
  'lease manager','accommodation manager',
  'electrical engineering manager','mechanical engineering manager',
  'building services engineer','estates engineer','senior estates engineer',
];

const PM_KW = [
  'project manager','programme manager','project support officer',
  'project administrator','project coordinator','pmo administrator',
  'pmo officer','portfolio manager','transformation manager','change manager',
  'improvement manager','digital project manager','programme delivery manager',
  'delivery manager','head of pmo','service transformation manager',
  'business change manager','epr implementation manager','workforce project manager',
];
const PM_INC = [
  'project support officer','project administrator','project coordinator',
  'pmo administrator','pmo support officer','programme support officer',
  'transformation support officer','change support officer','improvement support officer',
  'assistant project manager','junior project manager','project manager',
  'senior project manager','digital project manager','it project manager',
  'capital project manager','estates project manager','clinical project manager',
  'transformation project manager','workforce project manager','epr project manager',
  'service improvement project manager','operational project manager',
  'programme project manager','programme manager','senior programme manager',
  'transformation programme manager','digital programme manager',
  'clinical programme manager','workforce programme manager',
  'strategic programme manager','improvement programme manager',
  'programme delivery manager','pmo officer','pmo analyst','pmo coordinator',
  'pmo manager','senior pmo manager','portfolio office manager','head of pmo',
  'change manager','organisational change manager','transformation manager',
  'service transformation manager','improvement manager',
  'continuous improvement manager','quality improvement manager',
  'business change manager','transformation lead','digital transformation manager',
  'informatics project manager','it programme manager','systems implementation manager',
  'epr implementation manager','digital delivery manager','technical project manager',
  'data project manager','portfolio manager','head of programmes',
  'head of transformation','associate director of programmes',
  'deputy director of programmes','director of transformation','director of programmes',
];
const PM_EXC = [
  'nurse','doctor','support worker','healthcare assistant',
  'administrator','receptionist','secretary',
];

const BA_KW = [
  'business analyst','systems analyst','process analyst','transformation analyst',
  'change analyst','digital analyst','improvement analyst','service improvement analyst',
  'project analyst','programme analyst','clinical systems analyst','epr analyst',
  'application analyst','quality improvement analyst','process improvement analyst',
  'business process analyst','automation analyst','rpa analyst',
  'power platform analyst','power bi analyst','workforce information analyst',
  'lead business analyst',
];
const BA_INC = [
  'business analyst','senior business analyst','lead business analyst',
  'principal business analyst','junior business analyst','associate business analyst',
  'graduate business analyst','digital business analyst','clinical business analyst',
  'technical business analyst','it business analyst','systems business analyst',
  'data business analyst','information business analyst','healthcare business analyst',
  'transformation business analyst','change business analyst','change analyst',
  'transformation analyst','digital analyst','digital improvement analyst',
  'business change analyst','service transformation analyst','service improvement analyst',
  'transformation officer','project analyst','programme analyst','pmo analyst',
  'portfolio analyst','benefits realisation analyst','business improvement analyst',
  'clinical systems analyst','epr analyst','ehr analyst','clinical informatics analyst',
  'information systems analyst','application analyst','systems analyst',
  'digital systems analyst','configuration analyst','integration analyst',
  'quality improvement analyst','improvement analyst','continuous improvement analyst',
  'lean improvement analyst','service improvement officer','service improvement facilitator',
  'performance improvement analyst','process improvement analyst',
  'operational business analyst','business process analyst','process mapping analyst',
  'automation analyst','rpa analyst','power platform analyst','power bi analyst',
  'lead digital analyst','head of business analysis','head of informatics',
  'head of digital transformation','head of business intelligence',
];
const BA_EXC = [
  'nurse','doctor','support worker','healthcare assistant',
  'project manager','programme manager','financial analyst',
];

const DATA_KW = [
  'data analyst','data engineer','data scientist','information analyst',
  'reporting analyst','performance analyst','workforce analyst',
  'power bi developer','sql developer','database administrator',
  'analytics engineer','population health analyst','clinical informatics analyst',
  'workforce information analyst','people analytics analyst','commissioning analyst',
];
const DATA_INC = [
  'data analyst','senior data analyst','lead data analyst','principal data analyst',
  'data engineer','analytics engineer','data warehouse developer','data scientist',
  'information analyst','reporting analyst','performance analyst','workforce analyst',
  'operational analyst','service analyst','insight analyst','analytics officer',
  'power bi developer','sql developer','database administrator','dba',
  'workforce information analyst','workforce planning analyst','people analytics analyst',
  'hr data analyst','workforce intelligence analyst','commissioning analyst',
  'contract performance analyst','population health analyst','clinical informatics analyst',
];
const DATA_EXC = [
  'nurse','doctor','support worker','healthcare assistant',
  'business analyst','project manager','business intelligence analyst',
];

const BI_KW  = ['business intelligence analyst','bi analyst','bi developer','power bi analyst','tableau analyst'];
const BI_INC = [
  'business intelligence analyst','bi analyst','senior bi analyst',
  'bi developer','business intelligence developer','bi lead','bi manager',
  'bi engineer','power bi analyst','tableau analyst','analytics engineer',
  'head of business intelligence',
];

const IT_KW = [
  'it engineer','ict engineer','network engineer','software developer',
  'software engineer','infrastructure engineer','cyber security','cloud engineer',
  'devops engineer','it support officer','service desk analyst','helpdesk analyst',
  'desktop support engineer','systems administrator','network administrator',
  'azure administrator','digital product manager','product owner','scrum master',
  'agile delivery manager','solutions architect','enterprise architect',
  'technical architect','security engineer','soc analyst','penetration tester',
  'biomedical engineer','clinical engineer','medical equipment engineer',
  'epr systems analyst','clinical applications specialist',
  '1st line support','2nd line support',
];
const IT_INC = [
  'it support officer','it support technician','it service desk analyst',
  'it helpdesk analyst','desktop support engineer','field support engineer',
  'ict support officer','ict technician','infrastructure engineer',
  'infrastructure support engineer','infrastructure analyst',
  'technical support engineer','technical services engineer',
  'end user computing engineer','device deployment engineer','systems support engineer',
  'systems administrator','windows systems administrator','linux systems administrator',
  'network administrator','server administrator','cloud administrator',
  'active directory administrator','microsoft 365 administrator',
  'azure administrator','vmware administrator','network engineer',
  'senior network engineer','network analyst','network infrastructure engineer',
  'wireless network engineer','network operations engineer',
  'telecommunications engineer','unified communications engineer',
  'cloud engineer','azure cloud engineer','aws cloud engineer',
  'devops engineer','platform engineer','site reliability engineer',
  'kubernetes engineer','software developer','software engineer',
  'senior software engineer','full stack developer','backend developer',
  'frontend developer','.net developer','java developer','python developer',
  'mobile application developer','web developer','integration developer',
  'api developer','it engineer','ict engineer',
  'cyber security analyst','cyber security engineer','information security officer',
  'security operations analyst','security engineer','grc analyst',
  'penetration tester','soc analyst','digital product manager',
  'product owner','scrum master','agile delivery manager',
  'clinical systems analyst','epr systems analyst','ehr analyst',
  'clinical applications specialist','pacs administrator','ris administrator',
  'digital clinical support analyst','biomedical engineer','clinical engineer',
  'medical equipment engineer','medical electronics engineer',
  'biomedical engineering technician','clinical technologist','medical device specialist',
];
const IT_EXC = [
  'nurse','doctor','support worker','healthcare assistant',
  'project manager','programme manager','business analyst',
];

const FIN_KW = [
  'finance officer','finance manager','management accountant','financial accountant',
  'payroll officer','payroll manager','finance business partner','financial analyst',
  'financial planning analyst','cost improvement analyst','finance administrator',
  'accounts payable officer','head of finance',
];
const FIN_INC = [
  'finance officer','finance assistant','finance administrator','finance manager',
  'finance director','head of finance','management accountant','financial accountant',
  'senior accountant','accounts payable officer','accounts receivable officer',
  'payroll administrator','payroll manager','payroll officer','treasury officer',
  'finance business partner','deputy director of finance','financial analyst',
  'financial planning analyst','cost improvement analyst','financial reporting analyst',
];
const FIN_EXC = ['nurse','doctor','support worker','healthcare assistant','project manager','business analyst'];

const COORD_KW = [
  'pathway coordinator','patient coordinator','care coordinator',
  'referral coordinator','discharge coordinator','admissions coordinator',
  'outpatient coordinator','appointments coordinator',
  'waiting list coordinator','access coordinator',
  'cancer pathway coordinator','theatre booking coordinator',
];
const COORD_INC = [
  'pathway coordinator','patient coordinator','care coordinator',
  'referral coordinator','discharge coordinator','admissions coordinator',
  'outpatient coordinator','scheduling coordinator','appointments coordinator',
  'waiting list coordinator','access coordinator','service coordinator',
  'booking coordinator','clinical coordinator','patient flow coordinator',
  'elective care coordinator','cancer pathway coordinator',
  'theatre booking coordinator','clinic coordinator',
];

const LOG_KW  = ['logistics manager','logistics officer','logistics coordinator','supply chain manager','procurement officer','procurement manager','stores officer','supplies officer','transport manager','fleet manager','stock controller'];
const LOG_INC = ['logistics manager','logistics officer','logistics coordinator','supply chain manager','procurement officer','procurement manager','procurement specialist','stores officer','supplies officer','materials manager','inventory manager','transport manager','fleet manager','distribution manager','warehousing manager','stock controller','logistics'];

const NURSE_INC = ['staff nurse','registered nurse','rgn'];
const NURSE_EXC = ['assistant','support worker','student','trainee','apprentice','mental health','research','community','district','school','specialist','consultant','practitioner','advanced'];
const MH_INC    = ['mental health nurse','rmn','registered mental health','psychiatric nurse','mental health practitioner'];
const MH_EXC    = ['support worker','assistant','student','trainee'];
const RN_INC    = ['research nurse','clinical research nurse','senior research nurse','research sister'];
const FEL_INC   = ['clinical fellow','junior clinical fellow','senior clinical fellow','foundation year 1','foundation year 2','fy1','fy2','fy3','st1','st2','st3','st4','ct1','ct2','ct3','trust doctor','specialty doctor','specialty registrar','core trainee','associate specialist','sas doctor','foundation doctor'];
const COD_INC   = ['clinical coder','clinical coding','coding auditor','clinical coding manager','senior clinical coder','lead clinical coder','clinical coding officer','clinical coding analyst','chief clinical coder'];
const DIET_INC  = ['dietitian','dietician','community dietitian','specialist dietitian','paediatric dietitian','senior dietitian','lead dietitian','renal dietitian','oncology dietitian','clinical dietitian'];
const MICRO_INC = ['biomedical scientist microbiology','microbiologist','microbiology scientist','consultant microbiologist','clinical microbiologist','specialist biomedical scientist microbiology','senior biomedical scientist microbiology','microbiology'];
const PHLEB_INC = ['phlebotomist','phlebotomy','lead phlebotomist','senior phlebotomist','phlebotomy team leader','chief phlebotomist','community phlebotomist','phlebotomy supervisor','phlebotomy manager'];
const RES_INC   = ['research assistant','research associate','research practitioner','research officer','clinical research practitioner','trial coordinator','study coordinator','research coordinator','research fellow','research support officer','clinical research assistant'];
const RES_EXC   = ['research nurse','research midwife','research manager','research director'];
const SW2_INC   = ['social worker','senior social worker','amhp','approved mental health professional','children social worker','adult social worker','community social worker','statutory social worker','qualified social worker','practice educator','social work practitioner'];
const SW2_EXC   = ['support worker','healthcare assistant','admin','administrator'];

// ── CATEGORIES ────────────────────────────────────────────────
const CATS = [
  {id:'admin-out', label:'Admin Outside London',          kw:ADMIN_KW, loc:'',exLoc:'london',  minBand:5,sal:32000,group:'Admin',          inc:ADMIN_INC,exc:ADMIN_EXC},
  {id:'admin-lon', label:'Admin in London',               kw:ADMIN_KW, loc:'London',            minBand:5,sal:32000,group:'Admin',          inc:ADMIN_INC,exc:ADMIN_EXC},
  {id:'sw-out',    label:'Support Worker Outside London', kw:SW_KW,    loc:'',exLoc:'london',  minBand:3,sal:24071,ft:true,group:'Support Worker',inc:SW_INC,exc:SW_EXC},
  {id:'sw-lon',    label:'Support Worker in London',      kw:SW_KW,    loc:'London',           minBand:3,sal:24071,ft:true,group:'Support Worker',inc:SW_INC,exc:SW_EXC},
  {id:'sw-wm',     label:'Support Worker West Midlands',  kw:SW_KW,    loc:'West Midlands',    minBand:3,sal:24071,ft:true,group:'Support Worker',inc:SW_INC,exc:SW_EXC},
  {id:'sw-wales',  label:'Support Worker in Wales',       kw:SW_KW,    loc:'Wales',            minBand:3,sal:24071,ft:true,group:'Support Worker',inc:SW_INC,exc:SW_EXC},
  {id:'sw-manc',   label:'Support Worker Manchester',     kw:SW_KW,    loc:'Manchester',       minBand:3,sal:24071,ft:true,group:'Support Worker',inc:SW_INC,exc:SW_EXC},
  {id:'sw-wy',     label:'Support Worker W Yorkshire',    kw:SW_KW,    loc:'Leeds',            minBand:3,sal:24071,ft:true,group:'Support Worker',inc:SW_INC,exc:SW_EXC},
  {id:'sw-ey',     label:'Support Worker E Yorkshire',    kw:SW_KW,    loc:'Hull',             minBand:3,sal:24071,ft:true,group:'Support Worker',inc:SW_INC,exc:SW_EXC},
  {id:'nurse',     label:'Staff Nurse',                   kw:['staff nurse','registered nurse'],                             loc:'',minBand:5,maxBand:5,group:'Nursing',  inc:NURSE_INC,exc:NURSE_EXC},
  {id:'mh-nurse',  label:'Mental Health Nurse',           kw:['mental health nurse','psychiatric nurse','rmn'],              loc:'',group:'Nursing',  inc:MH_INC,  exc:MH_EXC},
  {id:'res-nurse', label:'Research Nurse',                kw:['research nurse','clinical research nurse'],                   loc:'',group:'Nursing',  inc:RN_INC},
  {id:'fellow',    label:'Clinical Fellow',               kw:['clinical fellow','foundation doctor','specialty registrar'],   loc:'',group:'Clinical', inc:FEL_INC},
  {id:'coder',     label:'Clinical Coder',                kw:['clinical coder','clinical coding'],                           loc:'',group:'Clinical', inc:COD_INC},
  {id:'diet',      label:'Dietician',                     kw:['dietitian','dietician'],                                      loc:'',group:'Clinical', inc:DIET_INC},
  {id:'micro',     label:'Microbiology',                   kw:['microbiology','microbiologist'],                              loc:'',group:'Clinical', inc:MICRO_INC},
  {id:'phleb',     label:'Phlebotomist Leader',           kw:['phlebotomist','phlebotomy'],                                  loc:'',group:'Clinical', inc:PHLEB_INC},
  {id:'res-asst',  label:'Research Assistant',            kw:['research assistant','research associate','trial coordinator'], loc:'',group:'Clinical', inc:RES_INC, exc:RES_EXC},
  {id:'sw3',       label:'Social Worker',                  kw:['social worker','amhp'],                                      loc:'',group:'Clinical', inc:SW2_INC, exc:SW2_EXC},
  {id:'data',      label:'Data Analyst',                  kw:DATA_KW,  loc:'',group:'Professional',inc:DATA_INC, exc:DATA_EXC},
  {id:'bi',        label:'BI Analyst',                    kw:BI_KW,    loc:'',group:'Professional',inc:BI_INC},
  {id:'fin',       label:'Finance',                       kw:FIN_KW,   loc:'',group:'Professional',inc:FIN_INC,  exc:FIN_EXC},
  {id:'hr',        label:'HR',                           kw:HR_KW,    loc:'',group:'Professional',inc:HR_INC,   exc:HR_EXC},
  {id:'it',        label:'IT / Engineering',             kw:IT_KW,    loc:'',group:'Professional',inc:IT_INC,   exc:IT_EXC},
  {id:'pm',        label:'Project Manager',              kw:PM_KW,    loc:'',group:'Professional',inc:PM_INC,   exc:PM_EXC},
  {id:'ba',        label:'Business Analyst',             kw:BA_KW,    loc:'',group:'Professional',inc:BA_INC,   exc:BA_EXC},
  {id:'log',       label:'Logistics',                    kw:LOG_KW,   loc:'',group:'Professional',inc:LOG_INC},
  {id:'coord',     label:'Coordinator',                  kw:COORD_KW, loc:'',group:'Professional',inc:COORD_INC},
  {id:'est',       label:'Estates',                      kw:EST_KW,   loc:'',group:'Professional',inc:EST_INC},
];

// ── HANDLER ───────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control',                'public, max-age=1800');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { category, page = '1' } = req.query;
  const pg  = Math.max(1, parseInt(page) || 1);
  const per = 20;

  if (!category) {
    return res.status(200).json({ fetchedAt: new Date().toISOString(), total:0, page:1, pages:0, jobs:[] });
  }

  const cat = CATS.find(c => c.label === category || c.id === category);
  if (!cat) return res.status(404).json({ error: 'Unknown category' });

  const all   = await getCategoryJobs(cat);
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / per));
  const start = (pg - 1) * per;

  return res.status(200).json({
    fetchedAt: new Date().toISOString(),
    total, page: pg, pages,
    jobs: all.slice(start, start + per).map(j => ({ ...j, category: cat.label, group: cat.group })),
  });
}

/**
 * Cloudflare Worker to fetch NYT Mini crossword and convert to IPUZ format
 */
import {convertSMHToIPUZ, fetchSMHCrosswords} from "./smhApi";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }
    
    // Manual trigger for scheduled task (for testing)
    if (url.pathname === '/cron/convert') {
      try {
        await handleConvert(request, env);
        return new Response('Successfully processed scheduled task', { status: 200 });
      } catch (error) {
        return new Response(`Error in scheduled task: ${error.message}`, { status: 500 });
      }
    }

    // Route: Home page - list all crosswords
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return handleHomePage(env);
    }

    // Route: API to list files as JSON
    if (url.pathname === '/api/list') {
      return handleListAPI(env);
    }

    // Route: Convert and store new crossword
    if (url.pathname === '/convert' || url.pathname === '/api/convert') {
      // Add CORS headers to the response
      const response = await handleConvert(request, env);
      const modifiedResponse = new Response(response.body, response);
      modifiedResponse.headers.set('Access-Control-Allow-Origin', '*');
      modifiedResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      modifiedResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type');
      return modifiedResponse;
    }

    // Default: show usage info
    return new Response('NYT Mini Crossword Converter\n\nRoutes:\n  / - Browse crosswords\n  /convert - Convert latest puzzle\n  /api/list - List files as JSON', {
      headers: { 'Content-Type': 'text/plain' },
    });
  },
  
  // Scheduled event handler
  async scheduled(event, env, ctx) {
    // Only run on production
    const request = new Request('https://crossword.stubbs.me/convert');
    await handleConvert(request, env);
    return new Response('Scheduled task completed');
  },
};

/**
 * Handle the home page with crossword browser
 */
async function handleHomePage(env) {
  const html = await generateHomePage(env);
  return new Response(html, {
    headers: { 'Content-Type': 'text/html' },
  });
}

/**
 * Handle the latest API endpoint
 */
async function handleLatest(request, env) {
  const url = new URL(request.url);
  const type = url.pathname.split('/').pop();
  const formattedDate = new Date().toISOString().split('T')[0];
  
  // Try to get the latest puzzle from each type
  const puzzleTypes = [
    { prefix: 'nyt-mini', name: 'NYT Mini' },
    { prefix: 'smh-crossword_mini', name: 'SMH Mini' },
    { prefix: 'smh-crossword_quick', name: 'SMH Quick' },
    { prefix: 'smh-crossword_cryptic', name: 'SMH Cryptic' }
  ];

  for (const puzzleType of puzzleTypes) {
    const latest = await env.CROSSWORD_BUCKET.get(`${puzzleType.prefix}-${formattedDate}.ipuz`);
    if (latest) {
      const latestData = await latest.json();
      return new Response(JSON.stringify({
        ...latestData,
        source: puzzleType.name
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  
  return new Response(JSON.stringify({ error: 'No puzzles found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Handle convert endpoint
 */
async function handleConvert(request, env) {
  const results = {
    nyt: null,
    smh: null,
    errors: []
  };

  // Fetch NYT Mini crossword data
  try {
    const nytResponse = await fetch('https://www.nytimes.com/svc/crosswords/v6/puzzle/mini.json', {
      headers: {
        'x-games-auth-bypass': 'true',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        'referer': 'https://www.nytimes.com/crosswords/game/mini'
      }
    });
    
    if (!nytResponse.ok) {
      throw new Error(`Failed to fetch NYT data: ${nytResponse.status}`);
    }

    const nytData = await nytResponse.json();
    const puzzleData = nytData.body[0];
    
    // Convert to IPUZ format (pass both puzzleData and root-level metadata)
    const ipuzData = convertToIPUZ(puzzleData, nytData);
    
    // Generate filename from publication date (at root level)
    const publicationDate = nytData.publicationDate;
    const filename = `nyt-mini-${publicationDate}.ipuz`;
    
    // Store in R2 bucket
    await env.CROSSWORD_BUCKET.put(filename, JSON.stringify(ipuzData, null, 2), {
      httpMetadata: {
        contentType: 'application/json',
      },
      customMetadata: {
        publicationDate: publicationDate,
        source: 'nyt-mini',
        uploadedAt: new Date().toISOString(),
      },
    });

    // Generate public URL (requires public bucket or custom domain)
    const bucketUrl = env.PUBLIC_BUCKET_URL || `https://pub-<your-id>.r2.dev`;
    const fileUrl = `${bucketUrl}/${filename}`;

    results.nyt = {
      filename: filename,
      publicationDate: publicationDate,
      url: fileUrl,
    };
  } catch (error) {
    results.errors.push(`NYT: ${error.message}`);
  }

  // Fetch, convert, and store the three SMH crosswords
  try {
    const smhCrosswords = await fetchSMHCrosswords();
    const smhPuzzles = smhCrosswords.puzzles.map(crossword => ({
      ...convertSMHToIPUZ(crossword),
      originalData: crossword // Keep original data for metadata
    }));
    
    const smhFilenames = smhPuzzles.map((puzzle, index) => {
      // Use difficulty from original data or fallback to index
      const puzzleType = puzzle.originalData?.difficulty?.toLowerCase() || `puzzle-${index + 1}`;
      const date = puzzle.originalData?.date || new Date().toISOString().split('T')[0];
      return `smh-${puzzleType}-${date}.ipuz`;
    });
    
    await Promise.all(smhPuzzles.map((puzzle, index) => {
        // Remove the originalData before saving
        const {originalData, ...puzzleData} = puzzle;
        return env.CROSSWORD_BUCKET.put(smhFilenames[index], JSON.stringify(puzzleData, null, 2), {
            httpMetadata: {
                contentType: 'application/json',
            },
            customMetadata: {
                publicationDate: new Date().toISOString(),
                source: 'smh',
                uploadedAt: new Date().toISOString(),
            },
        });
    }));

    results.smh = {
      filenames: smhFilenames,
    };
  } catch (error) {
    results.errors.push(`SMH: ${error.message}`);
  }

  // Clean up old entries (older than 1 month)
  try {
    await cleanupOldEntries(env);
  } catch (error) {
    // Log error but don't fail the request
    console.error('Error cleaning up old entries:', error);
  }

  // Determine response based on results
  if (results.nyt || results.smh) {
    // At least one source succeeded
    const responseData = {
      success: true,
    };

    if (results.nyt) {
      responseData.filename = results.nyt.filename;
      responseData.publicationDate = results.nyt.publicationDate;
      responseData.nytURL = results.nyt.url;
    }

    if (results.smh) {
      responseData.smhFilenames = results.smh.filenames;
    }

    if (results.errors.length > 0) {
      responseData.partialSuccess = true;
      responseData.errors = results.errors;
    }

    return new Response(JSON.stringify(responseData, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } else {
    // Both sources failed
    return new Response(JSON.stringify({
      success: false,
      errors: results.errors,
    }, null, 2), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}

/**
 * Clean up entries older than 1 month from the R2 bucket
 * @param {Object} env - Environment bindings
 */
async function cleanupOldEntries(env) {
  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
  
  const deletedFiles = [];
  let cursor = undefined;
  
  // List all objects in the bucket
  do {
    const listed = await env.CROSSWORD_BUCKET.list({
      cursor: cursor,
    });
    
    for (const object of listed.objects) {
      // Check if object has uploadedAt metadata
      if (object.customMetadata && object.customMetadata.uploadedAt) {
        const uploadedAt = new Date(object.customMetadata.uploadedAt);
        
        // Delete if older than 1 month
        if (uploadedAt < oneMonthAgo) {
          await env.CROSSWORD_BUCKET.delete(object.key);
          deletedFiles.push(object.key);
        }
      } else if (object.uploaded) {
        // Fallback to uploaded date if customMetadata is not available
        const uploadedAt = new Date(object.uploaded);
        
        if (uploadedAt < oneMonthAgo) {
          await env.CROSSWORD_BUCKET.delete(object.key);
          deletedFiles.push(object.key);
        }
      }
    }
    
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  
  if (deletedFiles.length > 0) {
    console.log(`Deleted ${deletedFiles.length} old files:`, deletedFiles);
  }
}

/**
 * Convert NYT crossword format to IPUZ format
 * @param {Object} puzzleData - NYT puzzle data from body[0]
 * @param {Object} rootData - Root level NYT data with metadata
 * @returns {Object} IPUZ formatted data
 */
function convertToIPUZ(puzzleData, rootData) {
  const { dimensions, cells, clues } = puzzleData;
  const { publicationDate, constructors, editor, copyright } = rootData;
  
  // Build the puzzle grid
  const puzzle = [];
  const solution = [];
  
  for (let row = 0; row < dimensions.height; row++) {
    const puzzleRow = [];
    const solutionRow = [];
    
    for (let col = 0; col < dimensions.width; col++) {
      const cellIndex = row * dimensions.width + col;
      const cell = cells[cellIndex];
      
      if (!cell || !cell.answer) {
        // Black square
        puzzleRow.push('#');
        solutionRow.push('#');
      } else {
        // White square with optional label
        if (cell.label) {
          puzzleRow.push(parseInt(cell.label));
        } else {
          puzzleRow.push(0);
        }
        solutionRow.push(cell.answer);
      }
    }
    
    puzzle.push(puzzleRow);
    solution.push(solutionRow);
  }
  
  // Build clues object
  const ipuzClues = {};
  
  clues.forEach(clue => {
    const direction = clue.direction;
    const clueText = clue.text[0].plain;
    const clueNumber = clue.label;
    
    if (!ipuzClues[direction]) {
      ipuzClues[direction] = [];
    }
    
    ipuzClues[direction].push([clueNumber, clueText]);
  });

  const dateParts = publicationDate.split('-');
  // Construct IPUZ object
  const ipuz = {
    version: 'http://ipuz.org/v2',
    kind: ['http://ipuz.org/crossword#1'],
    copyright: copyright,
    publisher: 'The New York Times',
    publication: 'The Mini Crossword',
    url: 'https://www.nytimes.com/crosswords/game/mini',
    uniqueid: `nyt-mini-${publicationDate}`,
    date: `${dateParts[1]}/${dateParts[2]}/${dateParts[0]}`,
    author: constructors ? constructors.join(', ') : undefined,
    title: "NYT Mini",
    editor: editor,
    dimensions: {
      width: dimensions.width,
      height: dimensions.height,
    },
    puzzle: puzzle,
    solution: solution,
    clues: ipuzClues,
  };
  
  return ipuz;
}

/**
 * List all files in the R2 bucket
 */
async function listAllFiles(env) {
  const files = [];
  let cursor;
  
  do {
    const listed = await env.CROSSWORD_BUCKET.list({ cursor });
    files.push(...listed.objects.map(obj => ({
      key: obj.key,
      size: obj.size,
      uploaded: obj.uploaded,
      customMetadata: obj.customMetadata,
    })));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  
  return files;
}

/**
 * Generate the home page HTML with a date picker and per-day puzzle links
 */
async function generateHomePage(env) {
  const files = await listAllFiles(env);
  const bucketUrl = env.PUBLIC_BUCKET_URL || 'https://pub-<your-id>.r2.dev';

  // Define puzzle types and their display names (order = display order)
  const puzzleTypes = [
    { id: 'nyt-mini', name: 'NYT Mini' },
    { id: 'smh-crossword_mini', name: 'SMH Mini' },
    { id: 'smh-crossword_quick', name: 'SMH Quick' },
    { id: 'smh-crossword_cryptic', name: 'SMH Cryptic' }
  ];

  // Build a map of date -> { typeId: url } for all known puzzles.
  // The key parser must match prefixes that themselves contain hyphens
  // (e.g. "smh-crossword_mini"), so we match each known prefix explicitly.
  const puzzlesByDate = {};
  for (const f of files) {
    for (const type of puzzleTypes) {
      const prefix = `${type.id}-`;
      if (!f.key.startsWith(prefix)) continue;
      const rest = f.key.slice(prefix.length);
      const m = rest.match(/^(\d{4}-\d{2}-\d{2})\.ipuz$/);
      if (!m) continue;
      const date = m[1];
      if (!puzzlesByDate[date]) puzzlesByDate[date] = {};
      puzzlesByDate[date][type.id] = `${bucketUrl}/${f.key}`;
      break;
    }
  }

  const availableDates = Object.keys(puzzlesByDate).sort();
  const minDate = availableDates[0] || '';
  const maxDate = availableDates[availableDates.length - 1] || '';

  // Server-side defaults for the initial render. Client-side JS will pick
  // today's local date if puzzles exist for it, otherwise the most recent.
  const todayUTC = new Date().toISOString().split('T')[0];
  const initialDate = puzzlesByDate[todayUTC] ? todayUTC : maxDate;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Crossword Archive</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      padding: 40px;
    }
    h1 {
      color: #2d3748;
      margin-bottom: 10px;
      font-size: 2.5em;
    }
    .subtitle {
      color: #718096;
      margin-bottom: 30px;
      font-size: 1.1em;
    }

    /* Calendar */
    .calendar {
      background: #f7fafc;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 16px 20px 20px;
      margin-bottom: 24px;
    }
    .calendar-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .calendar-title {
      color: #2d3748;
      font-weight: 600;
      font-size: 1.15em;
    }
    .calendar-nav {
      display: flex;
      gap: 8px;
    }
    .nav-btn {
      background: white;
      border: 1px solid #cbd5e0;
      border-radius: 6px;
      padding: 6px 12px;
      cursor: pointer;
      color: #4a5568;
      font-size: 1em;
      transition: all 0.15s;
    }
    .nav-btn:hover:not(:disabled) {
      background: #edf2f7;
      color: #2d3748;
    }
    .nav-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .calendar-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 4px;
    }
    .calendar-dow {
      text-align: center;
      color: #718096;
      font-size: 0.78em;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 6px 0;
    }
    .calendar-day {
      position: relative;
      aspect-ratio: 1 / 1;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid transparent;
      border-radius: 8px;
      background: white;
      color: #4a5568;
      cursor: pointer;
      font-size: 0.95em;
      transition: all 0.12s;
      user-select: none;
    }
    .calendar-day.empty {
      background: transparent;
      border-color: transparent;
      cursor: default;
      color: transparent;
    }
    .calendar-day.other-month {
      color: #cbd5e0;
      background: #fafbfc;
    }
    .calendar-day.has-puzzles {
      color: #2d3748;
      font-weight: 600;
    }
    .calendar-day.has-puzzles::after {
      content: '';
      position: absolute;
      bottom: 5px;
      left: 50%;
      transform: translateX(-50%);
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #667eea;
    }
    .calendar-day.no-puzzles {
      color: #a0aec0;
      cursor: not-allowed;
    }
    .calendar-day.today {
      border-color: #cbd5e0;
    }
    .calendar-day:hover.has-puzzles {
      background: #edf2f7;
      border-color: #667eea;
    }
    .calendar-day.selected,
    .calendar-day.selected.has-puzzles,
    .calendar-day.selected.no-puzzles {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border-color: transparent;
    }
    .calendar-day.selected.has-puzzles::after {
      background: white;
    }

    .selected-day {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 25px;
      border-radius: 12px;
      margin-bottom: 24px;
    }
    .selected-day .label {
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 0.8em;
      opacity: 0.85;
      margin-bottom: 6px;
    }
    .selected-day .day-text {
      font-size: 1.8em;
      font-weight: 600;
    }

    /* Crossword links */
    .puzzle-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 14px;
    }
    .puzzle-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 18px 20px;
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      color: #2d3748;
      text-decoration: none;
      font-weight: 500;
      transition: all 0.15s ease;
    }
    .puzzle-card:hover {
      border-color: #667eea;
      box-shadow: 0 4px 14px rgba(102, 126, 234, 0.18);
      transform: translateY(-1px);
    }
    .puzzle-card.disabled {
      opacity: 0.5;
      pointer-events: none;
      background: #f7fafc;
    }
    .puzzle-card .arrow {
      color: #667eea;
      font-size: 1.1em;
    }
    .empty {
      padding: 24px;
      text-align: center;
      color: #718096;
      background: #f7fafc;
      border: 1px dashed #cbd5e0;
      border-radius: 10px;
    }
    @media (max-width: 768px) {
      .container { padding: 20px; }
      .selected-day .day-text { font-size: 1.4em; }
      .calendar { padding: 12px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Crossword Archive</h1>
    <p class="subtitle">Pick a day to see the available puzzles</p>

    <div class="calendar">
      <div class="calendar-header">
        <button class="nav-btn" id="prevMonth" type="button" aria-label="Previous month">←</button>
        <div class="calendar-title" id="calendarTitle"></div>
        <div class="calendar-nav">
          <button class="nav-btn" id="todayBtn" type="button">Today</button>
          <button class="nav-btn" id="nextMonth" type="button" aria-label="Next month">→</button>
        </div>
      </div>
      <div class="calendar-grid" id="calendarGrid"></div>
    </div>

    <div class="selected-day">
      <div class="label">Selected day</div>
      <div class="day-text" id="selectedDayText">—</div>
    </div>

    <div id="puzzleList" class="puzzle-list"></div>
  </div>

  <script>
    const PUZZLE_TYPES = ${JSON.stringify(puzzleTypes)};
    const PUZZLES_BY_DATE = ${JSON.stringify(puzzlesByDate)};
    const AVAILABLE_DATES = ${JSON.stringify(availableDates)};
    const SERVER_INITIAL_DATE = ${JSON.stringify(initialDate)};

    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                         'July', 'August', 'September', 'October', 'November', 'December'];
    const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    const calendarTitle = document.getElementById('calendarTitle');
    const calendarGrid = document.getElementById('calendarGrid');
    const selectedDayText = document.getElementById('selectedDayText');
    const puzzleList = document.getElementById('puzzleList');
    const prevMonthBtn = document.getElementById('prevMonth');
    const nextMonthBtn = document.getElementById('nextMonth');
    const todayBtn = document.getElementById('todayBtn');

    function pad2(n) { return String(n).padStart(2, '0'); }
    function isoFromYMD(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }
    function localTodayISO() {
      const d = new Date();
      return isoFromYMD(d.getFullYear(), d.getMonth(), d.getDate());
    }
    function parseISO(iso) {
      const [y, m, d] = iso.split('-').map(Number);
      return { y: y, m: m - 1, d: d };
    }
    function formatLongDate(iso) {
      const p = parseISO(iso);
      return new Date(p.y, p.m, p.d).toLocaleDateString(undefined, {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });
    }

    let viewYear, viewMonth; // month is 0-indexed
    let selectedDate = null;
    const today = localTodayISO();

    function renderPuzzles(date) {
      if (!date) {
        selectedDayText.textContent = 'No date selected';
        puzzleList.innerHTML = '<div class="empty">No puzzles available.</div>';
        return;
      }
      selectedDayText.textContent = formatLongDate(date);
      const available = PUZZLES_BY_DATE[date] || {};
      const cards = PUZZLE_TYPES.map(t => {
        const url = available[t.id];
        if (url) {
          const href = '/viewer.html?puzzle=' + encodeURIComponent(url);
          return '<a class="puzzle-card" href="' + href + '">' +
                 '<span>' + t.name + '</span>' +
                 '<span class="arrow">Solve →</span>' +
                 '</a>';
        }
        return '<div class="puzzle-card disabled">' +
               '<span>' + t.name + '</span>' +
               '<span class="arrow">Not available</span>' +
               '</div>';
      }).join('');
      puzzleList.innerHTML = cards || '<div class="empty">No puzzles for this day.</div>';
    }

    function renderCalendar() {
      calendarTitle.textContent = MONTH_NAMES[viewMonth] + ' ' + viewYear;

      // Build day cells: leading days from previous month to align Sun as first column
      const firstOfMonth = new Date(viewYear, viewMonth, 1);
      const startDow = firstOfMonth.getDay();
      const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
      const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();

      let html = '';
      for (const dow of DOW_NAMES) {
        html += '<div class="calendar-dow">' + dow + '</div>';
      }

      // Previous month leading cells
      for (let i = startDow - 1; i >= 0; i--) {
        const day = daysInPrevMonth - i;
        const prev = new Date(viewYear, viewMonth - 1, day);
        const iso = isoFromYMD(prev.getFullYear(), prev.getMonth(), prev.getDate());
        html += renderDayCell(iso, day, true);
      }
      // Current month
      for (let day = 1; day <= daysInMonth; day++) {
        const iso = isoFromYMD(viewYear, viewMonth, day);
        html += renderDayCell(iso, day, false);
      }
      // Trailing cells to complete the final week (so the grid is rectangular)
      const totalShown = startDow + daysInMonth;
      const trailing = (7 - (totalShown % 7)) % 7;
      for (let day = 1; day <= trailing; day++) {
        const next = new Date(viewYear, viewMonth + 1, day);
        const iso = isoFromYMD(next.getFullYear(), next.getMonth(), next.getDate());
        html += renderDayCell(iso, day, true);
      }

      calendarGrid.innerHTML = html;

      // Wire up clicks
      calendarGrid.querySelectorAll('.calendar-day[data-date]').forEach(el => {
        el.addEventListener('click', () => {
          const iso = el.getAttribute('data-date');
          const isOtherMonth = el.classList.contains('other-month');
          if (isOtherMonth) {
            const p = parseISO(iso);
            viewYear = p.y;
            viewMonth = p.m;
          }
          selectDate(iso);
        });
      });
    }

    function renderDayCell(iso, day, otherMonth) {
      const has = !!PUZZLES_BY_DATE[iso];
      const classes = ['calendar-day'];
      if (otherMonth) classes.push('other-month');
      if (has) classes.push('has-puzzles'); else classes.push('no-puzzles');
      if (iso === today) classes.push('today');
      if (iso === selectedDate) classes.push('selected');
      return '<div class="' + classes.join(' ') + '" data-date="' + iso + '">' + day + '</div>';
    }

    function selectDate(iso) {
      selectedDate = iso;
      const p = parseISO(iso);
      // If user picked a date outside the visible month via keyboard etc, sync the view.
      if (p.y !== viewYear || p.m !== viewMonth) {
        viewYear = p.y;
        viewMonth = p.m;
      }
      renderCalendar();
      renderPuzzles(iso);
    }

    function shiftMonth(delta) {
      const d = new Date(viewYear, viewMonth + delta, 1);
      viewYear = d.getFullYear();
      viewMonth = d.getMonth();
      renderCalendar();
    }

    prevMonthBtn.addEventListener('click', () => shiftMonth(-1));
    nextMonthBtn.addEventListener('click', () => shiftMonth(1));
    todayBtn.addEventListener('click', () => selectDate(localTodayISO()));

    // Initial selection: today if available, else server-provided fallback (most recent puzzle date).
    const initialDate = PUZZLES_BY_DATE[today] ? today : (SERVER_INITIAL_DATE || today);
    const initParts = parseISO(initialDate);
    viewYear = initParts.y;
    viewMonth = initParts.m;
    selectDate(initialDate);
  </script>
</body>
</html>`;
}

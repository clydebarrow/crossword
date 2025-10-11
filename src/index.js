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
    if (env.ENVIRONMENT === 'production') {
      // Use the existing handleConvert function
      const request = new Request('https://crossword.stubbs.me/convert');
      await handleConvert(request, env);
    }
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
  try {
      // Fetch the NYT Mini crossword data
      const nytResponse = await fetch('https://www.nytimes.com/svc/crosswords/v6/puzzle/mini.json');
      
      if (!nytResponse.ok) {
        throw new Error(`Failed to fetch NYT data: ${nytResponse.status}`);
      }

      const nytData = await nytResponse.json();
      const puzzleData = nytData.body[0];
      
      // Convert to IPUZ format (pass both puzzleData and root-level metadata)
      const ipuzData = convertToIPUZ(puzzleData, nytData);
      
      // Fetch, convert, and store the three SMH crosswords
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

      return new Response(JSON.stringify({
        success: true,
        filename: filename,
        publicationDate: publicationDate,
        url: fileUrl,
        message: 'Crossword successfully converted and stored',
      }, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
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
 * Generate the home page HTML with tabbed interface for different puzzle types
 */
async function generateHomePage(env) {
  const files = await listAllFiles(env);
  const bucketUrl = env.PUBLIC_BUCKET_URL || 'https://pub-<your-id>.r2.dev';
  
  // Define puzzle types and their display names
  const puzzleTypes = [
    { id: 'nyt-mini', name: 'NYT Mini' },
    { id: 'smh-crossword_mini', name: 'SMH Mini' },
    { id: 'smh-crossword_quick', name: 'SMH Quick' },
    { id: 'smh-crossword_cryptic', name: 'SMH Cryptic' }
  ];

  // Process all puzzle types
  const puzzlesByType = {};
  
  for (const type of puzzleTypes) {
    const typePuzzles = files
      .filter(f => f.key.startsWith(`${type.id}-`))
      .map(f => {
        const match = f.key.match(/([^-]+)-(\d{4})-(\d{2})-(\d{2})\.ipuz/);
        if (match) {
          const [_, puzzleType, year, month, day] = match;
          return {
            key: f.key,
            type: type.id,
            typeName: type.name,
            date: `${year}-${month}-${day}`,
            year,
            month,
            day,
            url: `${bucketUrl}/${f.key}`,
            uploaded: f.uploaded,
          };
        }
        return null;
      })
      .filter(p => p !== null)
      .sort((a, b) => b.date.localeCompare(a.date));
    
    // Group by year and month for archive view
    const byYear = {};
    typePuzzles.forEach(p => {
      if (!byYear[p.year]) byYear[p.year] = {};
      if (!byYear[p.year][p.month]) byYear[p.year][p.month] = [];
      byYear[p.year][p.month].push(p);
    });
    
    puzzlesByType[type.id] = {
      name: type.name,
      latest: typePuzzles[0] || null,
      byYear,
      all: typePuzzles
    };
  }
  
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  // Generate HTML for each tab content
  const tabContents = puzzleTypes.map(type => {
    const typeData = puzzlesByType[type.id];
    if (!typeData || !typeData.latest) {
      return `
        <div id="${type.id}" class="tab-content">
          <div class="latest">
            <h2>Latest ${type.name} Puzzle</h2>
            <p>No puzzles available yet.</p>
          </div>
        </div>`;
    }
    
    return `
      <div id="${type.id}" class="tab-content ${type.id === 'nyt-mini' ? 'active' : ''}">
        <div class="latest">
          <h2>Latest ${type.name} Puzzle</h2>
          <div class="puzzle">
            <a href="/viewer.html?puzzle=${encodeURIComponent(typeData.latest.url)}" class="puzzle-link">
              <span class="date">${new Date(typeData.latest.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
              <span class="view">Solve &rarr;</span>
            </a>
          </div>
        </div>
        <div class="archive">
          <h2>Archive</h2>
          ${Object.entries(typeData.byYear).sort(([a], [b]) => b - a).map(([year, months]) => `
            <div class="year">
              <h3>${year}</h3>
              <div class="months">
                ${Object.entries(months).sort((a, b) => b[0] - a[0]).map(([month, puzzles]) => `
                  <div class="month">
                    <h4>${monthNames[parseInt(month) - 1]}</h4>
                    <div class="puzzles">
                      ${puzzles.map(puzzle => `
                        <a href="/viewer.html?puzzle=${encodeURIComponent(puzzle.url)}" class="puzzle-link">
                          <span class="date">${puzzle.day}</span>
                        </a>
                      `).join('')}
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
      </div>`;
  }).join('\n');
  
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
    
    /* Tabs */
    .tabs {
      display: flex;
      margin-bottom: 20px;
      border-bottom: 1px solid #e2e8f0;
    }
    .tab {
      padding: 10px 20px;
      cursor: pointer;
      border: 1px solid transparent;
      border-bottom: none;
      border-radius: 6px 6px 0 0;
      margin-right: 5px;
      background: #f7fafc;
      color: #4a5568;
      font-weight: 500;
      transition: all 0.2s;
    }
    .tab:hover {
      background: #edf2f7;
    }
    .tab.active {
      background: white;
      border-color: #e2e8f0;
      border-bottom-color: white;
      color: #2d3748;
      margin-bottom: -1px;
    }
    
    .tab-content {
      display: none;
      padding: 20px 0;
    }
    .tab-content.active {
      display: block;
    }
    
    .latest {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 25px;
      border-radius: 12px;
      margin-bottom: 30px;
    }
    .latest h2 {
      margin-bottom: 15px;
      font-size: 1.5em;
    }
    .puzzle-link {
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: white;
      text-decoration: none;
      padding: 15px 0;
      border-bottom: 1px solid rgba(255,255,255,0.2);
    }
    .puzzle-link:last-child {
      border-bottom: none;
    }
    .puzzle-link:hover {
      text-decoration: underline;
    }
    .puzzle-link .view {
      opacity: 0.8;
      font-size: 0.9em;
    }
    .puzzle-link:hover .view {
      opacity: 1;
    }
    .archive {
      margin-top: 40px;
    }
    .archive h2 {
      color: #2d3748;
      margin-bottom: 20px;
      font-size: 1.8em;
    }
    .year {
      margin-bottom: 30px;
    }
    .year h3 {
      color: #4a5568;
      margin-bottom: 15px;
      font-size: 1.4em;
    }
    .months {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 20px;
    }
    .month {
      background: #f8fafc;
      border-radius: 8px;
      padding: 15px;
    }
    .month h4 {
      color: #4a5568;
      margin-bottom: 10px;
      font-size: 1.1em;
    }
    .puzzles {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(40px, 1fr));
      gap: 8px;
    }
    .puzzles a {
      display: flex;
      align-items: center;
      justify-content: center;
      background: white;
      color: #4a5568;
      text-decoration: none;
      height: 36px;
      border-radius: 6px;
      transition: all 0.2s;
      border: 1px solid #e2e8f0;
    }
    .puzzles a:hover {
      background: #edf2f7;
      color: #2d3748;
    }
    @media (max-width: 768px) {
      .container {
        padding: 20px;
      }
      .tabs {
        flex-wrap: wrap;
      }
      .tab {
        margin-bottom: 5px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Crossword Archive</h1>
    <p class="subtitle">Browse and solve puzzles from different sources</p>
    
    <div class="tabs" id="puzzleTabs">
      ${puzzleTypes.map(type => `
        <div class="tab ${type.id === 'nyt-mini' ? 'active' : ''}" data-tab="${type.id}">
          ${type.name}
        </div>
      `).join('')}
    </div>
    
    ${tabContents}
  </div>
  
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      const tabs = document.querySelectorAll('.tab');
      const tabContents = document.querySelectorAll('.tab-content');
      
      // Function to set active tab
      const setActiveTab = (tabId) => {
        // Remove active class from all tabs and contents
        tabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        
        // Add active class to selected tab and corresponding content
        const selectedTab = document.querySelector('.tab[data-tab="' + tabId + '"]');
        if (selectedTab) {
          selectedTab.classList.add('active');
          document.getElementById(tabId).classList.add('active');
          // Save to localStorage
          localStorage.setItem('selectedTab', tabId);
        } else {
          // Default to first tab if saved tab not found
          const defaultTab = tabs[0];
          if (defaultTab) {
            const defaultTabId = defaultTab.getAttribute('data-tab');
            defaultTab.classList.add('active');
            document.getElementById(defaultTabId).classList.add('active');
            localStorage.setItem('selectedTab', defaultTabId);
          }
        }
      };
      
      // Set initial active tab from localStorage or default to first tab
      const savedTab = localStorage.getItem('selectedTab');
      setActiveTab(savedTab || 'nyt-mini');
      
      // Add click handlers to all tabs
      tabs.forEach(tab => {
        tab.addEventListener('click', () => {
          const tabId = tab.getAttribute('data-tab');
          setActiveTab(tabId);
        });
      });
    });
  </script>
</body>
</html>`;
}

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
 * Handle the list API endpoint
 */
async function handleListAPI(env) {
  const files = await listAllFiles(env);
  return new Response(JSON.stringify(files, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
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
 * Generate the home page HTML
 */
async function generateHomePage(env) {
  const files = await listAllFiles(env);
  const bucketUrl = env.PUBLIC_BUCKET_URL || 'https://pub-<your-id>.r2.dev';
  
  // Parse dates and organize by year/month
  const puzzles = files
    .filter(f => f.key.startsWith('nyt-mini-'))
    .map(f => {
      const match = f.key.match(/nyt-mini-(\d{4})-(\d{2})-(\d{2})\.ipuz/);
      if (match) {
        return {
          key: f.key,
          date: `${match[1]}-${match[2]}-${match[3]}`,
          year: match[1],
          month: match[2],
          day: match[3],
          url: `${bucketUrl}/${f.key}`,
          uploaded: f.uploaded,
        };
      }
      return null;
    })
    .filter(p => p !== null)
    .sort((a, b) => b.date.localeCompare(a.date));
  
  // Group by year and month
  const byYear = {};
  puzzles.forEach(p => {
    if (!byYear[p.year]) byYear[p.year] = {};
    if (!byYear[p.year][p.month]) byYear[p.year][p.month] = [];
    byYear[p.year][p.month].push(p);
  });
  
  const latest = puzzles[0];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NYT Mini Crossword Archive</title>
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
    .latest {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 25px;
      border-radius: 12px;
      margin-bottom: 30px;
    }
    .latest h2 {
      margin-bottom: 10px;
      font-size: 1.5em;
    }
    .latest a {
      color: white;
      text-decoration: none;
      font-size: 1.2em;
      font-weight: bold;
      border-bottom: 2px solid rgba(255,255,255,0.5);
      transition: border-color 0.3s;
    }
    .latest a:hover {
      border-bottom-color: white;
    }
    .archive {
      margin-top: 40px;
    }
    .archive h2 {
      color: #2d3748;
      margin-bottom: 20px;
      font-size: 1.8em;
    }
    .year-section {
      margin-bottom: 30px;
    }
    .year-header {
      background: #f7fafc;
      padding: 15px 20px;
      border-radius: 8px;
      font-size: 1.3em;
      font-weight: bold;
      color: #2d3748;
      margin-bottom: 15px;
    }
    .month-section {
      margin-bottom: 20px;
      padding-left: 20px;
    }
    .month-header {
      display: flex;
      align-items: center;
      gap: 15px;
      margin-bottom: 10px;
    }
    .month-name {
      font-weight: 600;
      color: #4a5568;
      font-size: 1.1em;
      min-width: 80px;
    }
    select {
      padding: 8px 12px;
      border: 2px solid #e2e8f0;
      border-radius: 6px;
      font-size: 1em;
      cursor: pointer;
      background: white;
      transition: border-color 0.3s;
    }
    select:hover {
      border-color: #667eea;
    }
    select:focus {
      outline: none;
      border-color: #667eea;
    }
    .day-link {
      display: inline-block;
      margin: 5px;
      padding: 8px 16px;
      background: #edf2f7;
      color: #2d3748;
      text-decoration: none;
      border-radius: 6px;
      transition: all 0.3s;
      font-weight: 500;
    }
    .day-link:hover {
      background: #667eea;
      color: white;
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }
    .puzzle-actions {
      display: flex;
      gap: 8px;
      margin: 5px 0;
    }
    .puzzle-action {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 6px 12px;
      border-radius: 6px;
      text-decoration: none;
      font-size: 0.9em;
      transition: all 0.2s;
    }
    .puzzle-action.view {
      background: #667eea;
      color: white;
    }
    .puzzle-action.download {
      background: #e2e8f0;
      color: #2d3748;
    }
    .puzzle-action:hover {
      transform: translateY(-1px);
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .stats {
      margin-top: 30px;
      padding: 20px;
      background: #f7fafc;
      border-radius: 8px;
      text-align: center;
      color: #4a5568;
    }
    .convert-btn {
      display: inline-block;
      margin-top: 20px;
      padding: 12px 24px;
      background: #48bb78;
      color: white;
      text-decoration: none;
      border-radius: 8px;
      font-weight: bold;
      transition: all 0.3s;
    }
    .convert-btn:hover {
      background: #38a169;
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(72, 187, 120, 0.4);
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🧩 Mini Crossword Archive</h1>
    <p class="subtitle">Browse and download converted IPUZ puzzles</p>
    
    ${latest ? `
    <div class="latest">
      <h2>📅 Latest Puzzle</h2>
      <div class="puzzle-actions" style="margin-top: 10px;">
        <a href="#" class="puzzle-action view" 
           onclick="event.preventDefault(); window.open('viewer.html?file=${encodeURIComponent('https://crossword.stubbs.me/nyt-mini-' + latest.date + '.ipuz')}', '_blank');">
          ${latest.date}
        </a>
        <a href="${latest.url}" class="puzzle-action download" download>
          ⬇️ Download
        </a>
      </div>
    </div>
    ` : '<p>No puzzles available yet.</p>'}
    
    <div class="archive">
      <h2>📚 Archive</h2>
      ${Object.keys(byYear).sort((a, b) => b - a).map(year => `
        <div class="year-section">
          <div class="year-header">${year}</div>
          ${Object.keys(byYear[year]).sort((a, b) => b - a).map(month => {
            const monthPuzzles = byYear[year][month];
            return `
            <div class="month-section">
              <div class="month-header">
                <span class="month-name">${monthNames[parseInt(month) - 1]}</span>
                <div style="flex: 1; display: flex; flex-wrap: wrap; gap: 8px;">
                  ${monthPuzzles.map(p => `
                    <div class="puzzle-actions">
                      <a href="#" class="puzzle-action view" 
                         data-date="${p.date}"
                         onclick="event.preventDefault(); window.open('viewer.html?file=${encodeURIComponent('https://crossword.stubbs.me/nyt-mini-' + p.date + '.ipuz')}', '_blank');">
                        ${p.day}
                      </a>
                      <a href="${p.url}" class="puzzle-action download" download>
                        ⬇️
                      </a>
                    </div>
                  `).join('')}
                </div>
              </div>
            </div>
            `;
          }).join('')}
        </div>
      `).join('')}
    </div>
    
    <div class="stats">
      <strong>${puzzles.length}</strong> puzzle${puzzles.length !== 1 ? 's' : ''} available
    </div>
  </div>
</body>
</html>`;
}

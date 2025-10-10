/**
 * Fetches crossword puzzles from SMH API
 * @param {string} date - Date in YYYY-MM-DD format
 * @returns {Promise<Object>} - Returns the puzzle data
 */
async function fetchSMHCrosswords(date) {
  // Format date to YYYY-MM-DD if not provided
  const puzzleDate = date || new Date().toISOString().split('T')[0];
  
  const query = `
    query PuzzleQuery($input: PuzzlesByDateAndTypesInput!) {
      puzzlesByDateAndTypes(input: $input) {
        error {
          message
          type {
            __typename
            class
          }
        }
        puzzles {
          author
          date
          difficulty
          game
          id
          type
        }
      }
    }
  `;

  const variables = {
    input: {
      date: puzzleDate,
      types: ["CROSSWORD"]
    }
  };

  try {
    const response = await fetch('https://api.smh.com.au/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    
    if (data.errors) {
      throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);
    }

    return data.data.puzzlesByDateAndTypes;
  } catch (error) {
    console.error('Error fetching crosswords:', error);
    throw error;
  }
}

/**
 * Converts SMH puzzle data to IPUZ format
 * @param {Object} smhPuzzle - Puzzle data from SMH API
 * @returns {Object} - IPUZ formatted puzzle
 */
function convertSMHToIPUZ(smhPuzzle) {
  const grid = smhPuzzle.game.grid;
  const height = grid.length;
  const width = height > 0 ? grid[0].length : 0;
  
  // Initialize IPUZ structure
  const ipuz = {
    version: "http://ipuz.org/v2",
    kind: ["http://ipuz.org/crossword#1"],
    dimensions: { width, height },
    puzzle: [],
    solution: [],
    clues: {
      across: [],
      down: []
    },
    title: (smhPuzzle.difficulty || 'SMH').replace(/^CROSSWORD_/, ''),
    author: smhPuzzle.author || '',
    copyright: 'SMH',
    publisher: 'Sydney Morning Herald',
    date: smhPuzzle.date || new Date().toISOString().split('T')[0]
  };

  // Process the grid and solution
  const cellMap = {};
  let cellNumber = 1;

  // First pass: number the cells and create empty puzzle/solution grids
  for (let y = 0; y < height; y++) {
    const puzzleRow = [];
    const solutionRow = [];
    
    for (let x = 0; x < width; x++) {
      const cell = grid[y][x];
      
      if (cell === '.') {
        // Block cell
        puzzleRow.push('#');
        solutionRow.push('#');
      } else {
        // Letter cell - check if it's the start of a word
        const isAcrossStart = (x === 0 || grid[y][x - 1] === '.') && 
                            (x < width - 1 && grid[y][x + 1] !== '.');
        const isDownStart = (y === 0 || grid[y - 1][x] === '.') && 
                          (y < height - 1 && grid[y + 1][x] !== '.');
        
        let cellObj = 0;
        if (isAcrossStart || isDownStart) {
          cellObj = cellNumber;
          cellMap[`${x},${y}`] = cellNumber++;
        }

        puzzleRow.push(cellObj);
        solutionRow.push(cell);
      }
    }
    
    ipuz.puzzle.push(puzzleRow);
    ipuz.solution.push(solutionRow);
  }

  // Second pass: process clues from SMH format
  const { clues: smhClues } = smhPuzzle.game;
  
  if (smhClues) {
    // Process across clues
    if (Array.isArray(smhClues.across)) {
      smhClues.across.forEach(clue => {
        // Find the cell with this position number
        for (const [coord, number] of Object.entries(cellMap)) {
          if (number === clue.position) {
            const [col, row] = coord.split(',').map(Number);
            ipuz.clues.across.push({
              number: number,
              clue: clue.question || '',
              answer: '', // Will be filled from the grid
              row: row,
              col: col
            });
            break;
          }
        }
      });
    }

    // Process down clues
    if (Array.isArray(smhClues.down)) {
      smhClues.down.forEach(clue => {
        // Find the cell with this position number
        for (const [coord, number] of Object.entries(cellMap)) {
          if (number === clue.position) {
            const [col, row] = coord.split(',').map(Number);
            ipuz.clues.down.push({
              number: number,
              clue: clue.question || '',
              answer: '', // Will be filled from the grid
              row: row,
              col: col
            });
            break;
          }
        }
      });
    }
  } else {
    // Fallback: Generate basic clues if not provided
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (grid[y][x] === '.') continue;

        // Check for across clues
        if (x === 0 || grid[y][x - 1] === '.') {
          let word = '';
          let wordX = x;
          while (wordX < width && grid[y][wordX] !== '.') {
            word += grid[y][wordX] || '';
            wordX++;
          }
          if (word.length > 1) {
            const cellNumber = cellMap[`${x},${y}`];
            if (cellNumber) {
              ipuz.clues.across.push({
                number: cellNumber,
                clue: '',
                answer: word,
                row: y,
                col: x
              });
            }
          }
        }

        // Check for down clues
        if (y === 0 || grid[y - 1][x] === '.') {
          let word = '';
          let wordY = y;
          while (wordY < height && grid[wordY][x] !== '.') {
            word += grid[wordY][x] || '';
            wordY++;
          }
          if (word.length > 1) {
            const cellNumber = cellMap[`${x},${y}`];
            if (cellNumber) {
              ipuz.clues.down.push({
                number: cellNumber,
                clue: '',
                answer: word,
                row: y,
                col: x
              });
            }
          }
        }
      }
    }
  }

  // Sort clues by number
  ipuz.clues.across.sort((a, b) => a.number - b.number);
  ipuz.clues.down.sort((a, b) => a.number - b.number);

  // Format clues as strings (number. clue)
  ipuz.clues.across = ipuz.clues.across.map(c => [`${c.number}`, `${c.clue || ''}`]);
  ipuz.clues.down = ipuz.clues.down.map(c => [`${c.number}`, `${c.clue || ''}`]);

  return ipuz;
}

export { fetchSMHCrosswords, convertSMHToIPUZ };

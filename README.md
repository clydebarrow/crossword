# NYT Mini Crossword to IPUZ Converter

A Cloudflare Worker that fetches the New York Times Mini Crossword puzzle and converts it to the IPUZ format, storing the result in a Cloudflare R2 bucket.

## Features

- Fetches NYT Mini crossword data from the official API
- Converts the puzzle to IPUZ format (standard crossword interchange format)
- Stores puzzles in Cloudflare R2 bucket with date-based filenames
- Includes metadata (publication date, author, editor, copyright)
- CORS-enabled for browser access

## Setup

### Prerequisites

- Node.js and npm installed
- Cloudflare account
- Wrangler CLI installed (`npm install -g wrangler`)

### Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Login to Cloudflare:
   ```bash
   wrangler login
   ```

3. Create an R2 bucket:
   ```bash
   wrangler r2 bucket create nyt-crosswords
   wrangler r2 bucket create nyt-crosswords-preview
   ```

4. Deploy the worker:
   ```bash
   npm run deploy
   ```

## Usage

### Manual Trigger

Simply make a GET request to your worker URL:

```bash
curl https://nyt-mini-crossword-converter.YOUR-SUBDOMAIN.workers.dev
```

### Response

```json
{
  "success": true,
  "filename": "nyt-mini-2025-10-08.ipuz",
  "publicationDate": "2025-10-08",
  "message": "Crossword successfully converted and stored"
}
```

### Automatic Daily Fetch (Optional)

Uncomment the cron trigger in `wrangler.toml` to automatically fetch the puzzle daily:

```toml
[triggers]
crons = ["0 6 * * *"]  # Run at 6 AM UTC daily
```

Then update your worker code to handle scheduled events:

```javascript
export default {
  async fetch(request, env, ctx) {
    // existing fetch handler
  },
  async scheduled(event, env, ctx) {
    // Call the same logic as fetch
    const response = await this.fetch(new Request('https://dummy.url'), env, ctx);
    console.log('Scheduled fetch completed:', await response.text());
  }
};
```

## IPUZ Format

The IPUZ format is a standard JSON-based format for crossword puzzles. The converted file includes:

- Puzzle grid with cell labels
- Solution grid
- Clues (Across and Down)
- Metadata (author, editor, publication date, copyright)

Example IPUZ structure:
```json
{
  "version": "http://ipuz.org/v2",
  "kind": ["http://ipuz.org/crossword#1"],
  "dimensions": { "width": 6, "height": 5 },
  "puzzle": [...],
  "solution": [...],
  "clues": {
    "Across": [...],
    "Down": [...]
  }
}
```

## File Storage

Files are stored in R2 with the naming convention:
- Format: `nyt-mini-YYYY-MM-DD.ipuz`
- Example: `nyt-mini-2025-10-08.ipuz`

Each file includes custom metadata:
- `publicationDate`: Original publication date
- `source`: "nyt-mini"
- `uploadedAt`: ISO timestamp of when it was uploaded

## Development

Run locally with:
```bash
npm run dev
```

View logs:
```bash
npm run tail
```

## License

MIT

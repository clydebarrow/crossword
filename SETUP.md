# Making Your R2 Bucket Publicly Accessible

## Option 1: Enable Public Access (Simplest)

1. **Go to Cloudflare Dashboard**
   - Navigate to [dash.cloudflare.com](https://dash.cloudflare.com)
   - Select your account
   - Click **R2** in the sidebar
   - Click on your bucket (`nyt-crosswords`)

2. **Enable Public Access**
   - Click the **Settings** tab
   - Scroll to **Public access**
   - Click **Allow Access**
   - You'll get a public URL like: `https://pub-abc123def456.r2.dev`

3. **Update wrangler.toml**
   - Copy your public URL
   - Update the `PUBLIC_BUCKET_URL` in `wrangler.toml`:
     ```toml
     [vars]
     PUBLIC_BUCKET_URL = "https://pub-abc123def456.r2.dev"
     ```

4. **Redeploy**
   ```bash
   npm run deploy
   ```

Now your files will be accessible at: `https://pub-abc123def456.r2.dev/nyt-mini-2025-10-08.ipuz`

## Option 2: Custom Domain (Recommended for Production)

1. **Connect a Custom Domain**
   - In your R2 bucket settings, click **Connect Domain**
   - Enter a domain you own (e.g., `crosswords.yourdomain.com`)
   - Add the required DNS records to your domain

2. **Update wrangler.toml**
   ```toml
   [vars]
   PUBLIC_BUCKET_URL = "https://crosswords.yourdomain.com"
   ```

3. **Benefits**
   - Cleaner URLs
   - Your own branding
   - Better control over caching and headers

## Option 3: Worker as Proxy (Most Control)

If you want to keep the bucket private but serve files through your worker:

1. Add a route to your worker to serve files:
   ```javascript
   // In src/index.js, add this to the fetch handler:
   if (url.pathname.startsWith('/files/')) {
     const filename = url.pathname.replace('/files/', '');
     const object = await env.CROSSWORD_BUCKET.get(filename);
     
     if (!object) {
       return new Response('File not found', { status: 404 });
     }
     
     return new Response(object.body, {
       headers: {
         'Content-Type': 'application/json',
         'Access-Control-Allow-Origin': '*',
       },
     });
   }
   ```

2. Files would be accessible at: `https://your-worker.workers.dev/files/nyt-mini-2025-10-08.ipuz`

## Security Considerations

- **Option 1 (Public Bucket)**: Anyone can access any file if they know the filename
- **Option 2 (Custom Domain)**: Same as Option 1, but with your domain
- **Option 3 (Worker Proxy)**: You can add authentication, rate limiting, or other logic

For a public crossword archive, **Option 1 or 2** is recommended for simplicity and performance.

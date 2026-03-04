// scrape-gybe.js
// Run with: node scrape-gybe.js
// Outputs: setlists.json

const https = require('https');

const BASE = 'https://gybecc.neocities.org/gybecc/';

const YEAR_PAGES = [
  '95','96','97','98','99',
  '00','01','02','03',
  '10','11','12','13','14','15','16','17','18','19','20',
  '22','23','24','25','26',
];

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Extract show page links from a year page HTML
function extractShowLinks(html) {
  const links = [];
  // Match hrefs like 2012-04-14.html or 95-01-01.html etc.
  const re = /href="((\d{2,4}-\d{2}-\d{2})\.html)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    links.push({ href: BASE + m[1], date: normalizeDate(m[2]) });
  }
  return links;
}

// Normalize dates: 95-01-01 → 1995-01-01, 2012-04-14 stays
function normalizeDate(d) {
  const parts = d.split('-');
  if (parts[0].length === 2) {
    const y = parseInt(parts[0]);
    parts[0] = (y >= 90 ? '19' : '20') + parts[0];
  }
  return parts.join('-');
}

// Parse setlist from a show page HTML
function parseShow(html, date) {
  // Strip tags helper
  const stripTags = s => s.replace(/<[^>]+>/g, '').trim();

  // Try to find venue / location from common patterns
  // The pages vary but usually have the venue in a <title> or early text
  let venue = '';
  const titleM = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleM) venue = titleM[1].trim();

  // Extract songs: look for list items, <li>, or lines that match known song names
  // The pages use varied markup; we'll extract all <li> text and filter
  const songs = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(html)) !== null) {
    const text = stripTags(m[1]).replace(/\s+/g, ' ').trim();
    if (text && text.length > 1 && text.length < 120) {
      songs.push(text);
    }
  }

  // Fallback: look for <p> or <br>-separated lines if no <li> found
  if (songs.length === 0) {
    // Try extracting from body text between known markers
    const bodyM = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bodyM) {
      const bodyText = bodyM[1];
      // Split by <br> tags
      const lines = bodyText.split(/<br\s*\/?>/i);
      for (const line of lines) {
        const text = stripTags(line).replace(/\s+/g, ' ').trim();
        if (text && text.length > 1 && text.length < 120 && !/^\[/.test(text)) {
          songs.push(text);
        }
      }
    }
  }

  return { date, venue, songs };
}

async function scrape() {
  const allShows = [];
  const seenDates = new Set();

  for (const yr of YEAR_PAGES) {
    const url = BASE + yr + '.html';
    process.stderr.write(`Fetching year page: ${url}\n`);
    let yearHtml;
    try {
      yearHtml = await get(url);
    } catch (e) {
      process.stderr.write(`  ERROR fetching ${url}: ${e.message}\n`);
      continue;
    }

    const showLinks = extractShowLinks(yearHtml);
    process.stderr.write(`  Found ${showLinks.length} show links\n`);

    for (const { href, date } of showLinks) {
      if (seenDates.has(date)) continue;
      seenDates.add(date);

      process.stderr.write(`  Fetching show: ${href}\n`);
      let showHtml;
      try {
        showHtml = await get(href);
      } catch (e) {
        process.stderr.write(`    ERROR: ${e.message}\n`);
        continue;
      }

      const show = parseShow(showHtml, date);
      if (show.songs.length > 0) {
        allShows.push(show);
      } else {
        process.stderr.write(`    No songs found for ${date}\n`);
        allShows.push(show); // include even if no setlist, so we know the show exists
      }

      // Be polite
      await new Promise(r => setTimeout(r, 150));
    }
  }

  // Sort by date
  allShows.sort((a, b) => a.date.localeCompare(b.date));

  process.stdout.write(JSON.stringify(allShows, null, 2));
  process.stderr.write(`\nDone. ${allShows.length} shows scraped.\n`);
}

scrape().catch(e => { process.stderr.write(e.stack + '\n'); process.exit(1); });

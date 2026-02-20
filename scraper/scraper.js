import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";
import pool from "../db/db.js";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = "https://www.avive.life";

// State name to abbreviation mapping
const STATE_ABBREVIATIONS = {
  "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR",
  "California": "CA", "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE",
  "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID",
  "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS",
  "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD",
  "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS",
  "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV",
  "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
  "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK",
  "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC",
  "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX", "Utah": "UT",
  "Vermont": "VT", "Virginia": "VA", "Washington": "WA", "West Virginia": "WV",
  "Wisconsin": "WI", "Wyoming": "WY", "District of Columbia": "DC"
};

// Clear all tables
async function clearTables() {
  try {
    console.log("🧹 Clearing existing data...");
    await pool.query("TRUNCATE TABLE laws RESTART IDENTITY CASCADE");
    await pool.query("TRUNCATE TABLE states RESTART IDENTITY CASCADE");
    console.log(" Tables cleared successfully");
  } catch (error) {
    throw new Error(`Failed to clear tables: ${error.message}`);
  }
}

// Extract state links from the main aed-laws page
async function extractStateLinks() {
  console.log("📖 Fetching main page from live website...");
  
  try {
    const response = await fetch(`${BASE_URL}/aed-laws`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const html = await response.text();
    const $ = cheerio.load(html);

    const stateLinks = [];
    const stateListContainer = $(".aed-state-law-cl");

    if (stateListContainer.length === 0) {
      console.log("⚠️  Could not find .aed-state-law-cl container, trying alternative selector...");
      // Try finding all links that match the pattern
      $("a[href^='/aed-laws/']").each((i, elem) => {
        const href = $(elem).attr("href");
        const stateName = $(elem).find(".aed-state-law-text").first().text().trim();
        if (href && stateName) {
          stateLinks.push({
            name: stateName,
            url: href,
            slug: href.replace("/aed-laws/", "").replace("/", "")
          });
        }
      });
    } else {
      stateListContainer.find("a[href^='/aed-laws/']").each((i, elem) => {
        const href = $(elem).attr("href");
        const stateName = $(elem).find(".aed-state-law-text").first().text().trim();
        if (href && stateName) {
          stateLinks.push({
            name: stateName,
            url: href,
            slug: href.replace("/aed-laws/", "").replace("/", "")
          });
        }
      });
    }

    // Remove duplicates
    const uniqueLinks = Array.from(
      new Map(stateLinks.map(item => [item.url, item])).values()
    );

    console.log(`✅ Found ${uniqueLinks.length} state links`);
    return uniqueLinks;
  } catch (error) {
    throw new Error(`Failed to fetch main page: ${error.message}`);
  }
}

// Insert state into database
async function insertState(stateName, slug, abbreviation, summary = null) {
  try {
    const result = await pool.query(
      "INSERT INTO states (name, abbreviation, slug, summary) VALUES ($1, $2, $3, $4) RETURNING id",
      [stateName, abbreviation, slug, summary]
    );
    return result.rows[0].id;
  } catch (error) {
    // If state already exists (unique constraint), get its ID
    if (error.code === '23505') { // Unique violation
      const result = await pool.query(
        "SELECT id FROM states WHERE slug = $1",
        [slug]
      );
      if (result.rows.length > 0) {
        return result.rows[0].id;
      }
    }
    throw error;
  }
}

// Scrape laws from a state page
async function scrapeStateLaws(stateName, stateUrl) {
  try {
    console.log(`\n🔍 Scraping ${stateName}...`);
    
    // Fetch from live website
    const response = await fetch(`${BASE_URL}${stateUrl}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const html = await response.text();
    console.log(`   ✅ Fetched from: ${BASE_URL}${stateUrl}`);

    const $ = cheerio.load(html);
    const laws = [];
    
    // Extract summary from the same page
    const summary = extractSummary($);

    // Find the law container - try multiple selectors based on user's description
    let lawContainer = $('div[target="_blank"].law-rtb');
    if (lawContainer.length === 0) {
      lawContainer = $('.law-rtb');
    }
    if (lawContainer.length === 0) {
      lawContainer = $('.w-richtext');
    }
    if (lawContainer.length === 0) {
      // Try to find any div containing h2 and p tags with law content
      lawContainer = $("div").filter((i, el) => {
        const $el = $(el);
        return $el.find("h2").length > 0 && $el.find("p").length > 0;
      }).first();
    }

    if (lawContainer.length === 0) {
      console.log(`   ⚠️  No laws found for ${stateName} - checking HTML structure...`);
      // Debug: show what we found
      const h2Count = $("h2").length;
      const pCount = $("p").length;
      console.log(`   Debug: Found ${h2Count} h2 tags and ${pCount} p tags in the page`);
      return laws;
    }

    // Extract laws - h2 is title, following p is description
    // The structure is: <h2><a>Law Title</a></h2><p>Description</p>
    const children = lawContainer.children();
    let currentLaw = null;

    children.each((i, elem) => {
      const $elem = $(elem);
      const tagName = $elem.prop("tagName")?.toLowerCase();
      
      if (tagName === "h2") {
        // Save previous law if exists
        if (currentLaw && currentLaw.title && currentLaw.description) {
          laws.push(currentLaw);
        }
        
        // Start new law
        const link = $elem.find("a");
        let title = "";
        if (link.length > 0) {
          title = link.text().trim() || link.attr("href") || "";
        } else {
          title = $elem.text().trim();
        }
        
        currentLaw = {
          title: title,
          description: ""
        };
      } else if (tagName === "p" && currentLaw) {
        // Get description text
        const pText = $elem.text().trim();
        if (pText && pText.length > 0) {
          if (currentLaw.description) {
            currentLaw.description += " " + pText;
          } else {
            currentLaw.description = pText;
          }
        }
      }
    });

    // Don't forget the last law
    if (currentLaw && currentLaw.title && currentLaw.description) {
      laws.push(currentLaw);
    }

    // Alternative approach: if the above didn't work, try finding all h2-p pairs
    if (laws.length === 0) {
      console.log(`   🔄 Trying alternative extraction method...`);
      $("h2").each((i, h2Elem) => {
        const $h2 = $(h2Elem);
        const link = $h2.find("a");
        const title = link.length > 0 ? link.text().trim() : $h2.text().trim();
        
        // Find the next p tag after this h2
        let $nextP = $h2.next("p");
        if ($nextP.length === 0) {
          // Try finding p within the same parent
          $nextP = $h2.parent().find("p").first();
        }
        
        if ($nextP.length > 0) {
          const description = $nextP.text().trim();
          if (title && description) {
            laws.push({
              title: title,
              description: description
            });
          }
        }
      });
    }

    console.log(`   ✅ Found ${laws.length} laws for ${stateName}`);
    return { laws, summary };
  } catch (error) {
    console.error(`   ❌ Error scraping ${stateName}:`, error.message);
    return [];
  }
}

// Insert laws into database
async function insertLaws(laws) {
  if (laws.length === 0) return;

  try {
    for (const law of laws) {
      await pool.query(
        "INSERT INTO laws (state_id, title, description) VALUES ($1, $2, $3)",
        [law.state_id, law.title, law.description]
      );
    }
    console.log(`   💾 Inserted ${laws.length} laws into database`);
  } catch (error) {
    console.error(`   ❌ Error inserting laws:`, error.message);
    throw error;
  }
}

// Extract summary from HTML (optional)
function extractSummary($) {
  try {
    // Try to find summary text from meta description or first paragraph
    const summary = $("meta[name='description']").attr("content") || 
                    $("meta[property='og:description']").attr("content") ||
                    $("p").first().text().trim().substring(0, 200) || 
                    null;
    
    return summary;
  } catch (error) {
    return null;
  }
}

// Main scraper function
async function runScraper() {
  console.log("🚀 Starting AED Laws Scraper...\n");

  try {
    // Step 1: Clear existing data
    await clearTables();

    // Step 2: Extract state links from main page
    const stateLinks = await extractStateLinks();
    
    if (stateLinks.length === 0) {
      throw new Error("No state links found!");
    }

    // Step 3: Process each state
    let totalLaws = 0;
    
    for (let i = 0; i < stateLinks.length; i++) {
      const stateLink = stateLinks[i];
      
      // Get state abbreviation
      const abbreviation = STATE_ABBREVIATIONS[stateLink.name] || null;
      if (!abbreviation) {
        console.log(`   ⚠️  No abbreviation found for ${stateLink.name}, skipping...`);
        continue;
      }

      // Scrape laws for this state (this also fetches the page)
      const result = await scrapeStateLaws(stateLink.name, stateLink.url);
      const { laws, summary } = result;

      // Insert state and get its ID
      const stateId = await insertState(
        stateLink.name,
        stateLink.slug,
        abbreviation,
        summary
      );
      
      console.log(`   ✅ State inserted: ${stateLink.name} (ID: ${stateId})`);

      // Update laws with the correct state_id
      const lawsWithStateId = laws.map(law => ({ ...law, state_id: stateId }));
      
      // Insert laws into database
      if (lawsWithStateId.length > 0) {
        await insertLaws(lawsWithStateId);
        totalLaws += lawsWithStateId.length;
      }
      
      // Add a small delay to be respectful to the server
      if (i < stateLinks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
      }
    }

    console.log(`\n✅ Scraping complete!`);
    console.log(`   📊 Total states processed: ${stateLinks.length}`);
    console.log(`   📊 Total laws inserted: ${totalLaws}`);

  } catch (error) {
    console.error("❌ Scraper error:", error.message);
    console.error(error);
    process.exit(1);
  } finally {
    // Close database connection
    await pool.end();
    console.log("\n🔌 Database connection closed");
  }
}

// Run the scraper
runScraper();

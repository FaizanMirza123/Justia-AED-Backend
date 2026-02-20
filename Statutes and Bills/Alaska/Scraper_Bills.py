import asyncio
import nodriver as uc
import json
import os
import urllib.parse

# Configuration
SEARCH_KEYWORDS = ['"AED"', '"Defibrillator"', '"Cardiac"', '"CPR"', '"Cardiopulmonary resuscitation"']
OUTPUT_FILE = 'bills.json'
BASE_URL = "https://www.akleg.gov/basis/Search"
SOURCES = ["All"]
YEAR_START = "1993"
YEAR_END = "2026"

async def scrape_bills():
    browser = None
    all_bills = {}

    # Load existing to deduplicate
    if os.path.exists(OUTPUT_FILE):
        try:
            with open(OUTPUT_FILE, 'r', encoding='utf-8') as f:
                existing = json.load(f)
                for b in existing:
                    if 'link' in b:
                        all_bills[b['link']] = b
        except:
            pass

    try:
        print("Starting browser (visible)...")
        browser = await uc.start(headless=False)
        
        for source in SOURCES:
            for kw in SEARCH_KEYWORDS:
                try:
                    # Construct URL
                    params = {
                        "search": kw.replace('"', ''), 
                        "source": source,
                        "yearStart": YEAR_START,
                        "yearEnd": YEAR_END
                    }
                    query_string = urllib.parse.urlencode(params)
                    url = f"{BASE_URL}?{query_string}"
                    
                    print(f"--------------------------------------------------")
                    print(f"Searching for keyword: {kw} in source: {source}")
                    print(f"Navigating to: {url}")
                    
                    page = await browser.get(url)
                    
                    # Wait for results or "no results" indicator
                    try:
                        await page.wait_for("#SearchResults", timeout=15)
                    except Exception:
                        print(f"Timeout waiting for results container for {kw}.")
                        continue

                    print("MANUAL SCROLL REQUIRED: Please scroll to the bottom of the page in the browser window.")
                    await asyncio.to_thread(input, "Press Enter in this terminal when you are finished scrolling...")

                    # Parse Results
                    result_spans = await page.select_all("span.ResultLink")
                    
                    count_found = 0
                    if result_spans:
                        print(f"Found {len(result_spans)} results (raw count). Processing...")
                        
                        for span in result_spans:
                            try:
                                # Link and Title
                                a_tag = await span.query_selector("a")
                                if not a_tag: continue
                                
                                link = a_tag.attrs.get("href", "")
                                if link.startswith("/"):
                                    link = f"https://www.akleg.gov{link}"
                                    
                                title = a_tag.text.strip()

                                # Validate title contains HB, SB, or AAC
                                # More permissive check (e.g. CSHB contains HB)
                                if not any(x in title for x in ["HB", "SB", "AAC"]):
                                    # print(f"  . Skipped (title filter): {title[:40]}...")
                                    continue
                                
                                # Snippet
                                snippet_span = await span.query_selector("span")
                                snippet = ""
                                if snippet_span:
                                    snippet = snippet_span.text.strip()
                                
                                # Verification disabled as requested
                                # clean_kw = kw.replace('"', '')
                                # if clean_kw.lower() not in " ".join(snippet.split()).lower():
                                #     print(f"  . Skipped (snippet filter): '{clean_kw}' not in snippet of {title[:20]}...")
                                #     continue

                                # Extract Bill ID from Title if possible
                                bill_id = title.split(" ")[0] if " " in title else title
                                
                                # Deduplicate by link
                                if link not in all_bills:
                                    item = {
                                        "bill_id": bill_id, 
                                        "title": title,
                                        "snippet": snippet,
                                        "link": link,
                                        "original_keyword": kw,
                                        "source": source
                                    }
                                    all_bills[link] = item
                                    count_found += 1
                                    print(f"  + Match: {title[:50]}...")
                                else:
                                    print(f"  . Duplicate skipped: {link}")
                                    
                            except Exception as inner_e:
                                print(f"Error extracting row: {inner_e}")
                                pass
                    else:
                        print("No results found.")
                    
                    print(f"Finished keyword '{kw}' source '{source}'. Added {count_found} new items.")

                except Exception as e:
                    print(f"Error processing keyword '{kw}': {e}")

        # Save to JSON
        print(f"\n--------------------------------------------------")
        print(f"Saving {len(all_bills)} total items to {OUTPUT_FILE}...")
        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            json.dump(list(all_bills.values()), f, indent=4, ensure_ascii=False)
        print("Done.")

    except Exception as e:
        print(f"Top-level error: {e}")

    finally:
        if browser:
            try:
                await browser.stop()
            except: pass

if __name__ == "__main__":
    asyncio.run(scrape_bills())


import asyncio
import nodriver as uc
import json
import urllib.parse
import os

# Configuration
SEARCH_KEYWORDS = ['"AED"', '"Defibrillator"', '"Cardiac"','"CPR"', '"Cardiopulmonary resuscitation"']
OUTPUT_FILE = 'bills.json'

async def scrape_bills():
    browser = None
    all_bills = {} 

    # Load existing to deduplicate
    if os.path.exists(OUTPUT_FILE):
        try:
            with open(OUTPUT_FILE, 'r', encoding='utf-8') as f:
                existing = json.load(f)
                for b in existing:
                    if 'bill_id' in b:
                        all_bills[b['bill_id']] = b
        except:
            pass

    try:
        print("Starting browser (visible)...")
        browser = await uc.start(headless=False)
        
        for kw in SEARCH_KEYWORDS:
            try:
                # 1. Navigate
                encoded_kw = urllib.parse.quote(kw)
                url = f"https://alison.legislature.state.al.us/bill-search?tab=2&query={encoded_kw}"
                
                print(f"\n--------------------------------------------------")
                print(f"Searching for keyword: {kw}")
                print(f"Navigating to: {url}")
                page = await browser.get(url)
                
                print("Waiting for results table (15s)...")
                await page.sleep(15)
                
                # 2. Set Pagination to 100
                try:
                    # Find the dropdown trigger. It usually displays "Show 10" or "Show 25" initially.
                    # We search for the button containing "Show "
                    # Note: Selectors can be tricky. We use a broad text selector first.
                    
                    # Check if 'Show 100' is already selected or we need to select it
                    # We look for the button that acts as the listbox trigger
                    pagination_buttons = await page.select_all("button")
                    trigger_btn = None
                    for btn in pagination_buttons:
                        txt = btn.text
                        if "Show " in txt and "span" in await btn.get_html(): # Heuristic for the dropdown
                            trigger_btn = btn
                            break
                    
                    if trigger_btn:
                        current_val = trigger_btn.text
                        if "Show 100" not in current_val:
                            print(f"Current pagination: '{current_val}'. Setting to 'Show 100'...")
                            await trigger_btn.click()
                            await page.sleep(1)
                            
                            # Find the 'Show 100' option in the listbox that appeared
                            # Often these are <li> or <div> or <button> inside a listbox
                            # Let's try searching text "Show 100" in the page
                            option100 = await page.find("Show 100", best_match=True)
                            if option100:
                                await option100.click()
                                print("Clicked 'Show 100'. Waiting 5s for reload...")
                                await page.sleep(5)
                        else:
                            print("Pagination already 'Show 100'.")
                    
                except Exception as e:
                    print(f"Pagination setup skipped/failed: {e}")

                # 3. Process Pages
                while True:
                    # Re-select rows each time to avoid stale references
                    rows = await page.query_selector_all("tr.cursor-pointer")
                    
                    if not rows:
                        print("No results on this page.")
                    else:
                        print(f"Processing {len(rows)} rows on current page...")
                        count_found = 0
                        for row in rows:
                            try:
                                cells = await row.query_selector_all("td")
                                if len(cells) < 8: continue
                                
                                # Access text helper
                                async def get_text_safe(idx):
                                    if idx < len(cells):
                                        try: return cells[idx].text 
                                        except: return ""
                                    return ""
                                
                                # Indices based on observation
                                bill_year = await get_text_safe(0)
                                bill_id = await get_text_safe(1)
                                sponsor = await get_text_safe(2)
                                session = await get_text_safe(3)
                                chamber = await get_text_safe(4)
                                # committee = index 5?
                                title = await get_text_safe(6)
                                snippet = await get_text_safe(7)
                                status = await get_text_safe(9)
                                
                                # Clean
                                title = title.strip()
                                snippet = snippet.strip().replace("\n", " ")
                                status = status.strip()
                                bill_id = bill_id.strip()

                                # --- FILTER 1: STATUS ---
                                if status != "Enacted":
                                    continue

                                # --- FILTER 2: EXACT KEYWORD ---
                                # Check if the keyword (without quotes) is actually in title or snippet
                                # This fixes the API returning loose match results
                                kw_clean = kw.replace('"', '').lower()
                                title_lower = title.lower()
                                snippet_lower = snippet.lower()
                                
                                if kw_clean not in title_lower and kw_clean not in snippet_lower:
                                    continue

                                # Deduplicate
                                if bill_id and bill_id not in all_bills:
                                    # Construct URL
                                    # Format based on bill_id and year. Need robust logic or scraping from somewhere.
                                    # Actually, let's scrape the 'View' button or similar if possible.
                                    # Or wait, the row itself is likely clickable or has an ID we can use?
                                    # URL pattern: https://alison.legislature.state.al.us/bill-search?tab=2&query={bill_id} usually works or direct link.
                                    # But let's check if we can get a direct link from the row.
                                    # The row is `cursor-pointer`, meaning it's likely JS-driven navigation on click.
                                    # Observation from dump: No <a> tag in the row cells easily visible for the bill link.
                                    # But let's construct a search link or details link if we can guess the pattern.
                                    # Typical pattern: https://alison.legislature.state.al.us/bill-search?tab=2&bill={bill_id}&session={session_id?}
                                    # Safest fallback: The search URL for that specifc bill ID.
                                    bill_url = f"https://alison.legislature.state.al.us/bill-search?tab=2&query={bill_id}"

                                    bill_item = {
                                        "bill_id": bill_id,
                                        "year": bill_year.strip(),
                                        "sponsor": sponsor.strip(),
                                        "session": session.strip(),
                                        "chamber": chamber.strip(),
                                        "title": title,
                                        "snippet": snippet,
                                        "status": status,
                                        "link": bill_url,
                                        "found_via_keyword": kw
                                    }
                                    all_bills[bill_id] = bill_item
                                    count_found += 1
                                    print(f"  + Enacted Match: {bill_id} - {title[:30]}...")

                            except Exception as e:
                                pass # inner row error
                                
                        print(f"Finished page. Added {count_found} new enacted bills.")

                    # 4. Next Page
                    try:
                        # Find "Next Page" button
                        next_btn = await page.query_selector("button[aria-label='Next Page']")
                        if not next_btn:
                            print("No 'Next Page' button found. Breaking loop.")
                            break
                        
                        # Check disabled state.
                        # nodriver attrs attribute is correct way
                        is_disabled = False
                        if "disabled" in next_btn.attrs:
                            is_disabled = True
                        
                        if is_disabled:
                            print("Next page disabled. End of results for this keyword.")
                            break
                        
                        print("Navigating to next page...")
                        await next_btn.click()
                        await page.sleep(5)
                        
                    except Exception as e:
                        print(f"Pagination error: {e}")
                        break

            except Exception as e:
                print(f"Error processing keyword '{kw}': {e}")
                continue

        # Save
        print(f"\n--------------------------------------------------")
        print(f"Saving {len(all_bills)} enacted bills to {OUTPUT_FILE}...")
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

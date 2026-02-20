import asyncio
import nodriver as uc
import json
import os
import re

# Configuration
STATE_NAME = "Pennsylvania"
STATE_NAME_L="pennsylvania"
SEARCH_KEYWORDS = ['"AED"', '"Automated External Defibrillator"', '"Defibrillator"', '"Cardiac Arrest"', '"Cardiopulmonary resuscitation"']
OUTPUT_FILE = f"{STATE_NAME}_statutes_final.jsonl"

async def append_to_file(data):
    """Writes results line-by-line to prevent data loss."""
    with open(OUTPUT_FILE, 'a', encoding='utf-8') as f:
        f.write(json.dumps(data, ensure_ascii=False) + '\n')

async def scrape_alabama():
    seen_urls = set()
    if os.path.exists(OUTPUT_FILE):
        with open(OUTPUT_FILE, 'r', encoding='utf-8') as f:
            for line in f:
                try:
                    seen_urls.add(json.loads(line).get('link'))
                except: continue
        print(f"Resuming: {len(seen_urls)} URLs already saved.")

    browser = await uc.start(headless=False)
    
    try:
        for kw in SEARCH_KEYWORDS:
            print(f"\n--- Searching Justia: {STATE_NAME} + {kw} ---")
            # Using the specific Alabama search URL
            url = f"https://law.justia.com/lawsearch?query={STATE_NAME}+{kw}&filter=codes/{STATE_NAME_L}"
            page = await browser.get(url)
            
            for page_num in range(1, 11):
                print(f"  Page {page_num}: Waiting 10s for GSC/Results to render...")
                await page.sleep(10) # Hard wait for Google search results
                
                # 1. Capture results: Try GSC containers first, then fallback to direct links
                results = await page.select_all(".gsc-webResult")
                is_direct_link = False
                
                print(f"    [DEBUG] Found {len(results)} .gsc-webResult elements")
                
                if not results:
                    print("  No .gsc-webResult found. Trying fallback to direct links...")
                    # Fallback: try selecting any link with 'codes' in it
                    results = await page.select_all(f"a[href*='codes/{STATE_NAME_L}']")
                    is_direct_link = True
                    print(f"    [DEBUG] Found {len(results)} direct links in fallback mode")
                    
                    if not results:
                        print("  No results found on this page. Check if blocked or empty.")
                        break

                new_on_page = 0
                for i, res in enumerate(results):
                    try:
                        target_link = None
                        title_text = ""
                        snippet_text = ""
                        
                        if is_direct_link:
                            # In fallback mode, 'res' is the <a> tag itself
                            href = res.attrs.get('href', '')
                            # Validate it's a code/regulation link
                            if STATE_NAME_L in href.lower() and ("/codes/" in href or "/regulations/" in href):
                                target_link = href
                                title_text = res.text.strip()
                        else:
                            # In container mode, 'res' is a div (e.g. .gsc-webResult)
                            
                            # Try specific selector for the title link first
                            try:
                                # USE query_selector instead of select for Elements
                                title_link = await res.query_selector(".gs-title a.gs-title") 
                                if title_link:
                                    all_links = [title_link]
                                else:
                                    all_links = await res.query_selector_all("a")
                            except:
                                all_links = [] 

                            if not all_links: 
                                # Try fallback: maybe links are just 'a' tags inside
                                try:
                                    all_links = await res.query_selector_all("a")
                                except: pass

                            if not all_links:
                                print(f"      [DEBUG] Item {i}: No 'a' tags found in result.")
                                continue
                            
                            for link_el in all_links:
                                href = link_el.attrs.get('href', '')
                                
                                # Handle Google redirect if necessary
                                if href and "google.com" in href and "url?q=" in href:
                                    try:
                                        href = href.split("url?q=")[1].split("&")[0]
                                        import urllib.parse
                                        href = urllib.parse.unquote(href)
                                    except: pass

                                # Filter: Must be Justia, Must be Alaska, Must be Code/Reg
                                if href and ("justia.com" in href or href.startswith("/")):
                                    href_lower = href.lower()
                                    if STATE_NAME_L in href_lower and ("/codes/" in href_lower or "/regulations/" in href_lower or "regulations.justia.com" in href_lower):
                                        target_link = href
                                        title_text = link_el.text.strip()
                                        break

                            if not target_link:
                                # Parsing failed for this item, check blindly for the title link class
                                try:
                                    title_el = await res.query_selector(".gs-title")
                                    if title_el:
                                         # Sometimes the 'a' is inside .gs-title
                                         a_tag = await title_el.query_selector("a")
                                         if a_tag:
                                             href = a_tag.attrs.get('href', '')
                                             # Apply same filter to fallback
                                             href_lower = href.lower()
                                             if href and ("justia.com" in href or href.startswith("/")):
                                                 if "arizona" in href_lower and ("/codes/" in href_lower or "/regulations/" in href_lower or "regulations.justia.com" in href_lower):
                                                     target_link = href
                                                     title_text = a_tag.text.strip()
                                except: pass
                                
                            # Extract Snippet (only available in container mode)
                            try:
                                snippet_el = await res.query_selector(".gs-snippet")
                                if snippet_el:
                                    snippet_text = snippet_el.text.strip()
                            except:
                                pass
                        
                        # Normalize relative links
                        if target_link and target_link.startswith('/'):
                            target_link = "https://law.justia.com" + target_link
                        
                        if not target_link:
                            print(f"      [DEBUG] Item {i}: No valid target link extracted. Skipped.")
                            continue

                        if target_link in seen_urls:
                            print(f"      [DEBUG] Item {i}: Duplicate URL {target_link}")
                            continue

                        # Section Number Extraction (e.g., 6-5-332.3)
                        section_match = re.search(r"section-([\d\.-]+x?[\d\.-]*)", target_link)
                        section_num = section_match.group(1) if section_match else "N/A"

                        data = {
                            "state": STATE_NAME,
                            "section": section_num,
                            "title": title_text,
                            "link": target_link,
                            "description": snippet_text
                        }
                        
                        await append_to_file(data)
                        seen_urls.add(target_link)
                        new_on_page += 1
                        print(f"    [SAVED] {section_num}")
                        
                    except Exception as e:
                        print(f"      [ERROR] Item {i}: {e}")
                        continue

                print(f"  Summary: Saved {new_on_page} new statutes from Page {page_num}.")

                # 2. Pagination (Clicking the next number)
                try:
                    next_page = page_num + 1
                    pagination_selector = f'div.gsc-cursor-page[aria-label="Page {next_page}"]'
                    btn = await page.select(pagination_selector)
                    if btn:
                        await btn.click()
                        await page.sleep(2) # Wait for click to register
                    else:
                        print("  No more pages.")
                        break
                except:
                    break

    finally:
        print(f"\nScrape complete. Check '{OUTPUT_FILE}'.")
        try:
            browser.stop()
        except: pass

if __name__ == '__main__':
    asyncio.run(scrape_alabama())
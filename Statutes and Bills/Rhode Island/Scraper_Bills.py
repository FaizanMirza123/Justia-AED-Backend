import asyncio
import nodriver as uc
import json
import os
import re

# Configuration
STATE_NAME = "Rhode Island"
STATE_CODE = "RI"  # LegiScan uses 2-letter state codes
SEARCH_KEYWORDS = ['"Automated External Defibrillator"', '"Defibrillator"', '"Cardiac Arrest"', '"Cardiopulmonary resuscitation"']
OUTPUT_FILE = 'bills.json'
MIN_COMPLETION = 90  # Minimum % completion to include

# Cookies for LegiScan
COOKIES = {
    'cf_clearance': 'RgVySHN8AClfeRrZdvbZCHPsjjWykHb.fs00gWPxiUA-1771513937-1.2.1.1-XR3HHvq6_8Xo3JLAlRut_7LRE3sLD7GxP7gvRgWPxuB8T881UekAlk_9Va8GI9SkJs.0U1REWapqRilZQ9cvOuVOe0DMzivj87zRU2O88qxJcOb0BygC.ZsMoEseRVgnHYqUq18riDt9DpsmupQO.H6hjEW7fWzYRBdCOKhF34K86pIrU9Cox8XWmQmTeCDWN1uHY17yw7pJCZnS.UyRgBJMRS1OZZJP4Wrs1cjxMx8',
    'has_js': '1',
    'SESS578caa163ede3b428d4fb3082193c4c4': 'ksj2lln0i4erp368q5t7kndug4'
}


async def load_existing_bills():
    """Load already scraped bills to avoid duplicates."""
    seen_bills = set()
    all_bills = []
    
    if os.path.exists(OUTPUT_FILE):
        try:
            with open(OUTPUT_FILE, 'r', encoding='utf-8') as f:
                all_bills = json.load(f)
                for bill in all_bills:
                    seen_bills.add(bill.get('bill_id', ''))
            print(f"Resuming: {len(seen_bills)} bills already saved.")
        except:
            pass
    
    return seen_bills, all_bills

async def save_bills(bills):
    """Save all bills to the output file."""
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(bills, f, ensure_ascii=False, indent=4)

async def set_cookies(page):
    """Set required cookies for the page."""
    for name, value in COOKIES.items():
        await page.send(uc.cdp.network.set_cookie(
            name=name,
            value=value,
            domain='.legiscan.com',
            path='/'
        ))

async def scrape_legiscan():
    seen_bills, all_bills = await load_existing_bills()
    new_bills_count = 0
    
    browser = await uc.start(headless=False)
    
    try:
        for kw in SEARCH_KEYWORDS:
            print(f"\n--- Searching LegiScan: {STATE_NAME} + {kw} ---")
            
            # Navigate to search page
            url = f"https://legiscan.com/gaits/search?state={STATE_CODE}&keyword={kw}"
            page = await browser.get(url)
            
            # Set cookies
            await set_cookies(page)
            await page.sleep(2)
            
            # Reload page with cookies
            await page.reload()
            await page.sleep(3)
            
            # Select "All" from session dropdown
            try:
                session_dropdown = await page.select('#edit-year')
                if session_dropdown:
                    # Find and select the "All" option (value="1")
                    await page.evaluate('''
                        document.querySelector('#edit-year').value = '1';
                        document.querySelector('#edit-year').dispatchEvent(new Event('change', { bubbles: true }));
                    ''')
                    await page.sleep(2)
                    print("  Selected 'All' sessions")
            except Exception as e:
                print(f"  Warning: Could not select session dropdown: {e}")
            
            # Submit the search form if needed
            try:
                submit_btn = await page.select('input[type="submit"], button[type="submit"]')
                if submit_btn:
                    await submit_btn.click()
                    await page.sleep(5)
                    print("  Submitted search form")
            except:
                pass
            
            # Wait for results table to load
            print("  Waiting for results to load...")
            await page.sleep(5)
            
            # Find all result rows in the table
            try:
                # LegiScan typically uses tables with class 'views-table' or similar
                rows = await page.select_all('table tbody tr, .view-content tbody tr, table.views-table tbody tr')
                print(f"  Found {len(rows)} rows")
                
                if not rows:
                    print("  No results found. Trying alternative selectors...")
                    # Try alternative table structures
                    rows = await page.select_all('tr.views-row, div.search-result')
                    print(f"  Found {len(rows)} rows with alternative selector")
                
                for i, row in enumerate(rows):
                    try:
                        # Extract bill information from row
                        bill_data = await extract_bill_data(row, kw, page)
                        
                        if not bill_data:
                            print(f"    Row {i}: No bill data extracted")
                            continue
                        
                        # Check completion percentage
                        completion = bill_data.get('completion_percent', 0)
                        if completion < MIN_COMPLETION:
                            print(f"    Skipped {bill_data.get('bill_id', 'Unknown')}: {completion}% complete (below {MIN_COMPLETION}%)")
                            continue
                        
                        # Check status - only include bills with "Pass" status
                        status = bill_data.get('status', '')
                        if 'Pass' not in status:
                            print(f"    Skipped {bill_data.get('bill_id', 'Unknown')}: Status '{status}' (not Pass)")
                            continue
                        
                        # Check for duplicates
                        bill_id = bill_data.get('bill_id', '')
                        if bill_id in seen_bills:
                            print(f"    Duplicate: {bill_id}")
                            continue
                        
                        # Add to collection
                        all_bills.append(bill_data)
                        seen_bills.add(bill_id)
                        new_bills_count += 1
                        
                        print(f"    [SAVED] {bill_id} ({completion}% complete)")
                        
                    except Exception as e:
                        print(f"    [ERROR] Row {i}: {e}")
                        continue
                
                # Handle pagination if exists
                page_num = 1
                while page_num < 10:  # Limit to 10 pages
                    try:
                        # Look for next page button
                        next_btn = await page.select('.pager-next a, a.next, li.next a, .pagination .next a')
                        if not next_btn:
                            print("  No more pages")
                            break
                        
                        print(f"  Moving to page {page_num + 1}...")
                        await next_btn.click()
                        await page.sleep(5)
                        page_num += 1
                        
                        # Process next page rows
                        rows = await page.select_all('table tbody tr, .view-content tbody tr, table.views-table tbody tr')
                        
                        for i, row in enumerate(rows):
                            try:
                                bill_data = await extract_bill_data(row, kw, page)
                                
                                if not bill_data:
                                    continue
                                
                                completion = bill_data.get('completion_percent', 0)
                                if completion < MIN_COMPLETION:
                                    continue
                                
                                # Check status - only include bills with "Pass" status
                                status = bill_data.get('status', '')
                                if 'Pass' not in status:
                                    continue
                                
                                bill_id = bill_data.get('bill_id', '')
                                if bill_id in seen_bills:
                                    continue
                                
                                all_bills.append(bill_data)
                                seen_bills.add(bill_id)
                                new_bills_count += 1
                                
                                print(f"    [SAVED] {bill_id} ({completion}% complete)")
                                
                            except Exception as e:
                                print(f"    [ERROR] Row {i}: {e}")
                                continue
                        
                    except:
                        break
                
            except Exception as e:
                print(f"  [ERROR] Processing results: {e}")
                continue
            
            # Save progress after each keyword
            await save_bills(all_bills)
            print(f"  Progress saved: {len(all_bills)} total bills")
        
        # Save all bills
        await save_bills(all_bills)
        print(f"\n✓ Scrape complete! Added {new_bills_count} new bills. Total: {len(all_bills)}")
        
    finally:
        print(f"\nCheck '{OUTPUT_FILE}' for results.")
        try:
            browser.stop()
        except:
            pass

async def extract_bill_data(row, keyword, page):
    """Extract bill information from a table row."""
    try:
        # Get all cells in the row
        cells = await row.query_selector_all('td')
        
        if len(cells) < 6:
            return None
        
        bill_data = {
            'state': STATE_NAME,
            'found_via_keyword': keyword
        }
        
        # LegiScan table structure (typical):
        # [0] Checkbox, [1] Icon, [2] Percentage, [3] State, [4] Bill ID, [5] Status, [6] Description, [7] Date
        
        # Extract completion percentage from cell [2]
        completion = 0
        try:
            percent_text = cells[2].text.strip()
            percent_match = re.search(r'(\d+)%', percent_text)
            if percent_match:
                completion = int(percent_match.group(1))
                bill_data['completion_percent'] = completion
        except:
            pass
        
        # Extract Bill ID and Link from cell [4]
        try:
            bill_link = await cells[4].query_selector('a')
            if bill_link:
                bill_id = bill_link.text.strip()
                bill_data['bill_id'] = bill_id
                
                # Get link
                href = bill_link.attrs.get('href', '')
                if href:
                    if href.startswith('/'):
                        href = 'https://legiscan.com' + href
                    bill_data['link'] = href
                
                # Determine chamber from bill ID
                if bill_id.startswith('H'):
                    bill_data['chamber'] = 'House'
                elif bill_id.startswith('S'):
                    bill_data['chamber'] = 'Senate'
        except:
            pass
        
        # Extract status from cell [5]
        try:
            status_text = cells[5].text.strip()
            bill_data['status'] = status_text
        except:
            pass
        
        # Extract title/description from cell [6]
        try:
            desc_cell = cells[6]
            desc_html = desc_cell.text.strip()
            
            # Split by <br> or [Detail] to isolate the main description
            lines = desc_html.split('\n')
            title = lines[0].strip() if lines else desc_html
            
            # Clean up common patterns
            title = re.sub(r'\[Detail\].*$', '', title).strip()
            title = re.sub(r'\[Text\].*$', '', title).strip()
            title = re.sub(r'\[Discuss\].*$', '', title).strip()
            
            bill_data['title'] = title
            bill_data['description'] = title
        except:
            pass
        
        # Extract date and action from cell [7]
        try:
            date_cell = cells[7]
            date_text = date_cell.text.strip()
            
            # Look for date in format YYYY-MM-DD
            date_match = re.search(r'(20\d{2}-\d{2}-\d{2})', date_text)
            if date_match:
                date_str = date_match.group(1)
                bill_data['last_action_date'] = date_str
                
                # Extract year
                year = date_str.split('-')[0]
                bill_data['year'] = year
            
            # Extract action text
            lines = date_text.split('\n')
            if len(lines) > 1:
                action = lines[1].strip()
                bill_data['last_action'] = action
        except:
            pass
        
        # If we have a bill_id, return the data
        return bill_data if bill_data.get('bill_id') else None
        
    except Exception as e:
        print(f"      Extract error: {e}")
        return None

if __name__ == '__main__':
    asyncio.run(scrape_legiscan())

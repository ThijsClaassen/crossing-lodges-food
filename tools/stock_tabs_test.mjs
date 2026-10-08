// stock_tabs_test.mjs — Purchases, Issues and Count, readability round
// (2026-09-29). Checks the shape each tab promised: a page head that says
// what the month holds, filters, a slim table, hand-typed entries in a
// one-screen drawer with "Save & add another", and deletes that ask first.
//
//   node tools/stock_tabs_test.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const app = readFileSync(join(here, '..', 'src', 'App.jsx'), 'utf8')
const css = readFileSync(join(here, '..', 'src', 'app.css'), 'utf8')
let passed = 0
const failures = []
const check = (name, ok, detail) => (ok ? passed++ : failures.push(`${name}${detail ? ` — ${detail}` : ''}`))
const fn = (name) => {
  const a = app.indexOf(`function ${name}(`)
  if (a < 0) return ''
  const b = app.indexOf('\nfunction ', a + 10)
  return app.slice(a, b < 0 ? undefined : b)
}

const purchases = fn('PurchasesTab')
const list = fn('PurchaseList')
check('purchases: scanning stays first on the page', purchases.indexOf('<SlipScanCard') > -1 && purchases.indexOf('<SlipScanCard') < purchases.indexOf('<PurchaseList'))
check('purchases: list head says lines, spend, suppliers and slips missing', /Purchases in \{period\}/.test(list) && /excl\. VAT/.test(list) && /without a slip/.test(list))
check('purchases: search, supplier filter, "without a slip only"', /Search item or supplier/.test(list) && /setSupFilter/.test(list) && /Without a slip only/.test(list))
check('purchases: hand-typed purchase is a one-screen drawer (no tabs)', /<Drawer\s+title="Log a purchase"/.test(purchases) && !/title="Log a purchase"[\s\S]{0,200}tabs=/.test(purchases))
check('purchases: Save & add another keeps date and supplier', /addPurchase\(\{ again: true \}\)/.test(purchases) && /supplier: again \? form\.supplier : ''/.test(purchases))
check('purchases: the zero-rated warning is still at the point of entry', /Zero-rated — enter the price exactly as printed/.test(purchases))
check('purchases: delete asks first', /window\.confirm\(`Delete this purchase/.test(purchases))
check('purchases: the old always-open manual form and collapsible list are gone', !/Log a purchase manually/.test(purchases) && !/<CollapsibleCard title=\{`Purchases in/.test(purchases))

const credits = fn('CreditNotesTab')
check('credit notes: "+ Credit note" opens a one-screen drawer (no always-open card, no toggle)', /<Drawer\s+title="Log a credit note"/.test(credits) && !/cardTitle\}>Log a credit note/.test(credits) && !/showCredits/.test(purchases) && /onLogCredit/.test(list))
check('credit notes: Save & add another keeps the supplier; delete asks first', /addCreditNote\(\{ again: true \}\)/.test(credits) && /supplier: again \? form\.supplier : ''/.test(credits) && /window\.confirm\(`Delete this credit note/.test(credits))
check('credit notes: the month list sits under the purchases list, only when there are any', /creditNotes\.length > 0 && \(/.test(credits) && purchases.indexOf('<CreditNotesTab') > purchases.indexOf('<PurchaseList'))

const issues = fn('IssuesTab')
check('issues: head with service / write-off counts, explainer behind ?', /Issues in \{period\}/.test(issues) && /write-off/.test(issues) && /className="why"/.test(issues))
check('issues: search and reason filter incl. write-offs only', /Search item or note/.test(issues) && /__writeoff__/.test(issues))
check('issues: one-screen log drawer, Save & add another keeps the category', /<Drawer\s+title="Log an issue"/.test(issues) && /addIssue\(\{ again: true \}\)/.test(issues) && /if \(!again\) setCategory\(''\)/.test(issues))
check('issues: category picker kept, but optional (2026-10-08): no category = search all items', /<option value="">All categories<\/option>/.test(issues) && /placeholder=\{category \? 'Select item…' : 'Search all items…'\}/.test(issues) && !/disabled=\{!category\}/.test(issues))
check('issues: no category → every item in the list; a category narrows it', /const itemsInCat = category \? items\.filter\(\(it\) => inCat\(it, category\)\) : items/.test(issues))
check('issues: changing the category keeps the chosen item when it is in that category', /if \(c && it && !inCat\(it, c\)\) setForm\(\{ \.\.\.form, item_id: '' \}\)/.test(issues))
check('issues: delete asks first', /window\.confirm\(`Delete this issue/.test(issues))

const count = fn('CountTab')
check('count: head with Submit at the top as well as the bottom', /Stock count — \{period\}/.test(count) && (count.match(/onClick=\{submitCounts\}/g) || []).length === 2)
check('count: rows grouped by category', /countGroups\.map/.test(count) && /className="group-row"/.test(count))
check('count: filters HIDE rows (typed counts survive), never remove them', /rowVisible\(it\) \? null : \{ display: 'none' \}/.test(count) && !/items\.filter\(rowVisible\)\.map/.test(count))
check('count: a scan clears the filters so its row is visible', /setSearch\(''\)\s*\n\s*setCatFilter\(''\)/.test(count))

check('css: "?" explainer style', /\.why\{/.test(css))

console.log(`stock_tabs_test: ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)

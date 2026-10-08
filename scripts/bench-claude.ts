// Real-model benchmark for tier routing. Every task has a hidden objective check (node script, exit 0 = pass).
// Each (task, model) pair is run once through headless Claude Code with all plugins/hooks off, recording
// the real total_cost_usd, wall time and pass/fail. "routed" is then derived: for each task, the cost and
// result of the model Jev's tier decision selects. No assumed prices. Uses real quota.
//   bun scripts/bench-claude.ts run  [models=haiku,sonnet,opus] [out=.superpowers/bench.jsonl]
//   bun scripts/bench-claude.ts report [out]
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { createJev } from "../src/jev"
import { pickTier } from "../src/models"
import { policy, type Tier } from "../src/policy"

interface Task { id: string; tier: Tier; files: Record<string, string>; prompt: string; check: string }

const tasks: Task[] = [
  { id: "rename", tier: "light", files: { "main.js": "const x = 5\nfunction double(v){ return v * 2 }\nconsole.log(double(x))\n" },
    prompt: "Rename the variable x to count in main.js", check: `const s=require('fs').readFileSync('main.js','utf8');if(/\\bx\\b/.test(s)||!/count/.test(s))process.exit(1);if(require('child_process').execSync('node main.js').toString().trim()!=='10')process.exit(1)` },
  { id: "bump", tier: "light", files: { "package.json": '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n', "version.js": "module.exports = '1.0.0'\n" },
    prompt: "Bump the version to 1.2.0 in package.json and version.js", check: `if(require('./package.json').version!=='1.2.0'||require('./version.js')!=='1.2.0')process.exit(1)` },
  { id: "typo", tier: "light", files: { "README.md": "# Instalation guide\n\nSee the Instalation section. Instalation is easy.\n" },
    prompt: "Fix the spelling mistake in README.md everywhere it appears", check: `const s=require('fs').readFileSync('README.md','utf8');if(/Instalation/.test(s)||(s.match(/Installation/g)||[]).length!==3)process.exit(1)` },
  { id: "port", tier: "light", files: { "config.js": "module.exports = { port: 3000, host: 'localhost' }\n" },
    prompt: "Change the default port in config.js from 3000 to 8080", check: `const c=require('./config.js');if(c.port!==8080||c.host!=='localhost')process.exit(1)` },
  { id: "slugify", tier: "standard", files: { "slug.js": "// TODO\n" },
    prompt: "Implement and export (module.exports) slugify(str) in slug.js: lowercase, trim, replace runs of non-alphanumeric characters with a single dash, no leading/trailing dashes. 'Hello,  World!' -> 'hello-world'.",
    check: `const s=(m=>typeof m==='function'?m:m.slugify)(require('./slug.js'));const t=[['Hello,  World!','hello-world'],['  --Foo__bar  ','foo-bar'],['A1 b2','a1-b2'],['',''],['---','']];for(const[i,o]of t)if(s(i)!==o)process.exit(1)` },
  { id: "stats-bug", tier: "standard", files: { "stats.js": "exports.average = (a) => a.reduce((s,v)=>s+v,0)/a.length\nexports.median = (a) => { const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)] }\n" },
    prompt: "average([]) returns NaN and median is wrong for even-length arrays. Fix both in stats.js (empty input -> 0 for both; even-length median is the mean of the two middle values).",
    check: `const s=require('./stats.js');const eq=(a,b)=>{if(a!==b)process.exit(1)};eq(s.average([]),0);eq(s.median([]),0);eq(s.median([3,1,2]),2);eq(s.median([4,1,3,2]),2.5);eq(s.average([1,2,3]),2)` },
  { id: "paginate", tier: "standard", files: { "page.js": "// TODO\n" },
    prompt: "In page.js export paginate(items, page, perPage) returning { items, total, pages }. Pages are 1-based; out-of-range pages return an empty items array; pages is ceil(total/perPage).",
    check: `const pick=(m,n)=>typeof m==='function'?m:m[n];const eq=require('util').isDeepStrictEqual;const p=pick(require('./page.js'),'paginate');const r=p([1,2,3,4,5],2,2);if(!eq(r,{items:[3,4],total:5,pages:3}))process.exit(1);if(p([1,2],5,2).items.length!==0)process.exit(1);if(p([],1,10).pages!==0)process.exit(1)` },
  { id: "async-io", tier: "standard", files: { "io.js": "const fs = require('fs')\nexports.readJson = (path, cb) => fs.readFile(path, 'utf8', (err, txt) => { if (err) return cb(err); try { cb(null, JSON.parse(txt)) } catch (e) { cb(e) } })\n", "data.json": '{"a":1}' },
    prompt: "Add an exported promise-based readJsonAsync(path) to io.js that resolves to the parsed JSON and rejects on read or parse errors. Keep readJson working.",
    check: `(async()=>{const io=require('./io.js');const d=await io.readJsonAsync('data.json');if(d.a!==1)process.exit(1);let rej=false;try{await io.readJsonAsync('nope.json')}catch{rej=true}if(!rej)process.exit(1);io.readJson('data.json',(e,v)=>{if(e||v.a!==1)process.exit(1)})})()` },
  { id: "csv", tier: "standard", files: { "csv.js": "// TODO\n" },
    prompt: "Implement and export parseCsv(text) in csv.js returning an array of rows (arrays of strings). Support quoted fields containing commas, escaped quotes (\"\"), and newlines inside quotes. No header handling.",
    check: `const pick=(m,n)=>typeof m==='function'?m:m[n];const eq=require('util').isDeepStrictEqual;const c=pick(require('./csv.js'),'parseCsv');const j=JSON.stringify;if(j(c('a,b\\n1,2'))!==j([['a','b'],['1','2']]))process.exit(1);if(j(c('"a,b",c'))!==j([['a,b','c']]))process.exit(1);if(j(c('"say ""hi""",x'))!==j([['say "hi"','x']]))process.exit(1);if(j(c('"l1\\nl2",z'))!==j([['l1\\nl2','z']]))process.exit(1)` },
  { id: "lru-ttl", tier: "heavy", files: { "cache.js": "// TODO\n" },
    prompt: "Implement and export class TtlLru in cache.js. Constructor (maxSize, ttlMs, now = Date.now). Methods get(k), set(k,v), has(k), size. Entries expire ttlMs after they were last SET (get does not extend ttl). get() marks an entry most-recently-used. When size exceeds maxSize evict the least recently used non-expired entry; expired entries are purged first. size counts only live entries. Time comes only from the injected now() function.",
    check: `const TtlLru=(m=>typeof m==='function'?m:m.TtlLru)(require('./cache.js'));let t=0;const c=new TtlLru(2,100,()=>t);c.set('a',1);c.set('b',2);c.get('a');c.set('c',3);if(c.has('b')||!c.has('a')||!c.has('c'))process.exit(1);t=99;c.get('a');t=101;if(c.has('a')||c.has('c')||c.size!==0)process.exit(1);c.set('d',4);t=150;c.set('d',5);t=240;if(c.get('d')!==5)process.exit(1);t=251;if(c.get('d')!==undefined)process.exit(1)` },
  { id: "emitter-bug", tier: "heavy", files: {
      "emitter.js": "class Emitter {\n  constructor(){ this.h = {} }\n  on(e, f){ (this.h[e] ||= []).push(f); return () => this.off(e, f) }\n  off(e, f){ this.h[e] = (this.h[e]||[]).filter(x => x !== f) }\n  once(e, f){ const w = (...a) => { this.off(e, w); f(...a) }; this.on(e, w) }\n  emit(e, ...a){ const l = this.h[e] || []; for (let i = 0; i < l.length; i++) l[i](...a) }\n}\nmodule.exports = Emitter\n",
      "app.js": "const Emitter = require('./emitter')\nconst bus = new Emitter()\nconst log = []\nbus.once('x', () => log.push('once1'))\nbus.on('x', () => log.push('on'))\nbus.once('x', () => log.push('once2'))\nbus.emit('x'); bus.emit('x')\nconsole.log(JSON.stringify(log))\n" },
    prompt: "Running `node app.js` prints the wrong order/counts. Expected output is [\"once1\",\"on\",\"once2\",\"on\"]. Find the root cause and fix it in the right place without changing app.js.",
    check: `if(require('child_process').execSync('node app.js').toString().trim()!==JSON.stringify(['once1','on','once2','on']))process.exit(1);const E=require('./emitter.js');const e=new E();const r=[];const off=e.on('y',()=>r.push(1));e.on('y',()=>{off();r.push(2)});e.emit('y');e.emit('y');if(JSON.stringify(r)!=='[1,2,2]')process.exit(1)` },
  { id: "token-bucket", tier: "heavy", files: { "limiter.js": "// TODO\n" },
    prompt: "Implement and export class TokenBucket in limiter.js. Constructor (capacity, refillPerSec, now = Date.now) with now() returning ms. take(n = 1) returns true and consumes n tokens if available, else false and consumes nothing. Tokens refill continuously (fractions allowed), never exceeding capacity; the bucket starts full. take(n) with n > capacity always returns false. Time only from now(); must tolerate now() going backwards (no negative refill).",
    check: `const pick=(m,n)=>typeof m==='function'?m:m[n];const eq=require('util').isDeepStrictEqual;const T=pick(require('./limiter.js'),'TokenBucket');let t=1000;const b=new T(5,2,()=>t);for(let i=0;i<5;i++)if(!b.take())process.exit(1);if(b.take())process.exit(1);t+=250;if(b.take())process.exit(1);t+=250;if(!b.take())process.exit(1);if(b.take())process.exit(1);t+=60000;if(b.take(6))process.exit(1);if(!b.take(5))process.exit(1);t-=5000;if(b.take())process.exit(1);t+=5500;if(!b.take())process.exit(1)` },
]

const cmd = process.argv[2] ?? "report"
const models = (process.argv[3] ?? "haiku,sonnet,opus").split(",")
const out = process.argv[4] ?? ".superpowers/bench.jsonl"
const rows = (): any[] => (existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])

function runOne(task: Task, spec: string) {
  // "haiku+lean" = haiku with skills and MCP servers disabled (what the launcher does for light, no-external tasks).
  const [model, lean] = spec.split("+")
  const leanArgs = lean ? policy.models.leanArgs.claude! : []
  const dir = mkdtempSync(join(tmpdir(), `bench-${task.id}-`))
  for (const [f, c] of Object.entries(task.files)) writeFileSync(join(dir, f), c)
  const started = Date.now()
  const r = spawnSync("claude", ["-p", task.prompt, "--output-format", "json", "--model", model, "--max-budget-usd", "1.5", ...leanArgs, "--permission-mode", "bypassPermissions", "--settings", JSON.stringify({ enabledPlugins: { "system-one@jev-local": false } })], { cwd: dir, encoding: "utf8", timeout: 280000, input: "" })
  let cost = 0, outTok = 0, turns = 0, inTok = 0
  try { const d = JSON.parse(r.stdout.trim().split("\n").pop()!); cost = d.total_cost_usd; outTok = d.usage.output_tokens; inTok = d.usage.input_tokens + d.usage.cache_creation_input_tokens + d.usage.cache_read_input_tokens; turns = d.num_turns } catch {}
  writeFileSync(join(dir, ".check.js"), task.check)
  const pass = spawnSync("node", [".check.js"], { cwd: dir, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } }).status === 0
  rmSync(dir, { recursive: true, force: true })
  return { task: task.id, model: spec, pass, inTok, cost, outTok, turns, ms: Date.now() - started }
}

if (cmd === "run") {
  mkdirSync(join(out, ".."), { recursive: true })
  const done = new Set(rows().map((r) => `${r.task}|${r.model}`))
  for (const task of tasks) for (const model of models) {
    if (done.has(`${task.id}|${model}`)) continue
    const row = runOne(task, model)
    appendFileSync(out, JSON.stringify(row) + "\n")
    console.log(row)
  }
} else {
  const ask = createJev({ apiKey: process.env.OPENROUTER_API_KEY!, timeoutMs: 5000 })
  const data = rows()
  const cell = (task: string, model: string) => data.find((r) => r.task === task && r.model === model)
  const tierModel: Record<Tier, string> = policy.models.catalog.claude
  const total = { sonnet: { cost: 0, pass: 0, ms: 0 }, routed: { cost: 0, pass: 0, ms: 0 }, haiku: { cost: 0, pass: 0, ms: 0 } }
  console.log("task            labelled  jev-tier  routed→   sonnet(pass,$)     routed(pass,$)")
  for (const task of tasks) {
    const a = (await ask({ state: { request: task.prompt }, questions: { tier: { type: "choice", instructions: policy.models.questions.tier, criteria: policy.models.criteria } } })) as any
    const tier = pickTier(a.tier.probabilities)
    const m = tierModel[tier]
    const s = cell(task.id, "sonnet"), r = cell(task.id, m), h = cell(task.id, "haiku")
    if (!s || !r) { console.log(task.id, "missing runs", m); continue }
    total.sonnet.cost += s.cost; total.sonnet.pass += +s.pass; total.sonnet.ms += s.ms
    total.routed.cost += r.cost; total.routed.pass += +r.pass; total.routed.ms += r.ms
    if (h) { total.haiku.cost += h.cost; total.haiku.pass += +h.pass; total.haiku.ms += h.ms }
    console.log(task.id.padEnd(15), task.tier.padEnd(9), tier.padEnd(9), m.padEnd(8), `${s.pass ? "PASS" : "FAIL"} $${s.cost.toFixed(3)}`.padEnd(18), `${r.pass ? "PASS" : "FAIL"} $${r.cost.toFixed(3)}`)
  }
  console.log("\nalways-sonnet:", total.sonnet, "\nalways-haiku :", total.haiku, "\njev-routed   :", total.routed)
}

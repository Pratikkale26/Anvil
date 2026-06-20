/**
 * Decisive test: does the DEPLOYED API's byte-equal actually work end-to-end?
 * Mirrors the workbench flow against the live host: demo -> emit ->
 * auto-scenario -> /build/differential. Prints status at each step + final
 * verdict (or the exact failure).
 */
const BASE = process.env.ANVIL_API ?? "https://anvil-app-nrjdl.ondigitalocean.app";
const demo = process.argv[2] ?? "counter";

async function j(method: string, path: string, body?: unknown, timeoutMs = 360_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: body ? { "Content-Type": "application/json", Origin: "https://anvilsol.xyz" } : { Origin: "https://anvilsol.xyz" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await r.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { data = text.slice(0, 500); }
    return { status: r.status, ok: r.ok, data, ms: Date.now() - started };
  } catch (e) {
    return { status: 0, ok: false, data: String(e instanceof Error ? e.message : e), ms: Date.now() - started };
  } finally { clearTimeout(t); }
}

(async () => {
  console.log(`# deployed differential probe: ${BASE} demo=${demo}`);

  const d = await j("GET", `/demo/${demo}`, undefined, 20_000);
  console.log(`1. GET /demo/${demo} -> ${d.status} (${d.ms}ms)`);
  if (!d.ok) { console.log("   FAIL:", JSON.stringify(d.data).slice(0, 300)); return; }
  const ir = d.data.ir;
  const source = d.data.source;
  if (!ir || !source) { console.log("   no ir/source in demo response"); return; }
  const programId = ir.programId;
  console.log(`   ir ok (programId=${programId}), source ${source.length}b`);

  const e = await j("POST", `/emit`, { ir, target: "pinocchio", multiFile: true }, 30_000);
  console.log(`2. POST /emit -> ${e.status} (${e.ms}ms)`);
  if (!e.ok) { console.log("   FAIL:", JSON.stringify(e.data).slice(0, 300)); return; }
  let files = e.data.files;
  if ((!Array.isArray(files) || files.length === 0) && typeof e.data.code === "string") {
    files = [{ path: "lib.rs", content: e.data.code }];
  }
  if (!Array.isArray(files) || files.length === 0) { console.log("   no files; keys=", Object.keys(e.data)); return; }
  console.log(`   emitted ${files.length} files`);

  const a = await j("POST", `/build/differential/auto-scenario`, { ir }, 30_000);
  console.log(`3. POST /build/differential/auto-scenario -> ${a.status} (${a.ms}ms)`);
  if (!a.ok || !a.data?.ok) { console.log("   blocked/fail:", JSON.stringify(a.data).slice(0, 400)); return; }
  const scenario = a.data.scenario;
  console.log(`   scenario ok (${scenario.steps?.length} steps, compare ${scenario.compare?.accounts?.length})`);

  console.log(`4. POST /build/differential?stream=1 ... (cold build may take 1-5 min)`);
  const b = await j("POST", `/build/differential?stream=1`, {
    anchorSource: source,
    anvilEmittedFiles: files,
    ir,
    scenario,
    programName: demo.replace(/[^a-zA-Z0-9_-]/g, "_"),
    ...(programId ? { programIdBase58: programId } : {}),
    target: "pinocchio",
  }, 360_000);
  console.log(`   -> ${b.status} (${b.ms}ms)`);
  if (!b.ok) {
    console.log("   *** DEPLOYED DIFFERENTIAL FAILED ***");
    console.log("   ", JSON.stringify(b.data).slice(0, 800));
    return;
  }
  console.log("   *** DEPLOYED DIFFERENTIAL SUCCEEDED ***");
  console.log("   verdict:", b.data.verdict);
  console.log("   sanityWarnings:", JSON.stringify((b.data.sanityWarnings ?? []).map((w: any) => w.kind)));
  console.log("   cacheState:", JSON.stringify(b.data.cacheState));
})();

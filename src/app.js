const $ = id => document.getElementById(id);

const sheet = $("sheet");
const template = $("template");
const art = $("art");
const loadBtn = $("load");
const generateBtn = $("generate");
const generatePngOnlyBtn = $("generatePngOnly");
const status = $("status");
const cardsEl = $("cards");
const pp = $("pp");
const ppStatus = $("ppstatus");
const progressWrap = $("progressWrap");
const progressBar = $("progressBar");

let cards = [];
let artFiles = new Map();
let templateBuffer = null;
let photopeaReady = false;
let running = false;
let commandQueue = Promise.resolve();

// Only one card's PSD document is kept open in Photopea at a time.
// previewIndex tracks which card (if any) currently owns that live document,
// so "Edit in Photopea" / "Export" know whether it's safe to act on it.
let previewIndex = null;
// index -> { blob, url } for the most recently rendered PNG of that card
// (from a preview or from an export after manual edits).
let cardPreviews = new Map();

function revokePreview(index) {
  const p = cardPreviews.get(index);
  if (p) URL.revokeObjectURL(p.url);
  cardPreviews.delete(index);
}

function resetPreviews() {
  for (const index of cardPreviews.keys()) revokePreview(index);
  previewIndex = null;
}

function setStatus(message, cls = "") {
  status.className = "status " + cls;
  status.textContent = message;
}

function norm(v) {
  return String(v ?? "").trim();
}

function normalizeRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[norm(key).replace(/^,+|,+$/g, "")] = value ?? "";
  }
  return out;
}

function normalizeCard(row) {
  const x = normalizeRow(row);
  return {
    Name: norm(x.Name),
    Power: norm(x.Power),
    Bulk: norm(x.Bulk),
    Color1: norm(x.Color1).toUpperCase(),
    Color2: norm(x.Color2).toUpperCase(),
    Color3: norm(x.Color3).toUpperCase(),
    Color4: norm(x.Color4).toUpperCase(),
    Trait: norm(x.Trait),
    Effect1: norm(x.Effect1),
    Effect2: norm(x.Effect2),
    Clarify1: norm(x.Clarify1),
    Clarify2: norm(x.Clarify2),
    Clarify3: norm(x.Clarify3),
    CardNumber: norm(x.CardNumber),
    SetName: norm(x.SetName),
    Artist: norm(x.Artist),
    Art: norm(x.Art),
    Flavor: norm(x.Flavor),
    Inspiration: norm(x.Inspiration),
  };
}

function readCsv(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
      complete: result => {
        if (result.errors?.length) {
          reject(new Error(result.errors[0].message));
          return;
        }
        resolve(result.data.map(normalizeCard));
      },
      error: err => reject(err),
    });
  });
}

function artFor(filename) {
  const wanted = norm(filename).replace(/\\/g, "/").split("/").pop().toLowerCase();
  return artFiles.get(wanted) || null;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function renderCards() {
  cardsEl.innerHTML = cards.map((card, i) => {
    const file = artFor(card.Art);
    const preview = cardPreviews.get(i);
    const isLive = previewIndex === i;
    return `
      <div class="card" id="card-${i}">
        <strong>${esc(card.CardNumber)} — ${esc(card.Name)}</strong>
        <small>POW ${esc(card.Power)} / BLK ${esc(card.Bulk)}
          · ${esc([card.Color1,card.Color2,card.Color3,card.Color4].filter(Boolean).join(""))}</small>
        <div class="cardStatus ${file ? "ok" : "warn"}">
          ${file ? "Art found: " + esc(file.name) : "Art not found: " + esc(card.Art || "(blank)")}
        </div>
        ${preview ? `<div class="preview"><img src="${preview.url}" alt="Preview of ${esc(card.Name)}"></div>` : ""}
        <div class="cardActions">
          <button class="gen" data-index="${i}" ${photopeaReady && file ? "" : "disabled"}>
            ${preview ? "Regenerate" : "Generate"}
          </button>
          <button class="dl" data-index="${i}" ${preview ? "" : "disabled"}>
            Download PNG
          </button>
          <button class="edit" data-index="${i}" ${isLive ? "" : "disabled"}>
            Edit in Photopea
          </button>
          <button class="export" data-index="${i}" ${isLive ? "" : "disabled"}>
            Export PSD + PNG
          </button>
        </div>
      </div>`;
  }).join("");

  cardsEl.querySelectorAll(".gen").forEach(button => {
    button.addEventListener("click", async () => {
      const index = Number(button.dataset.index);
      try {
        await previewCard(index);
      } catch (err) {
        markCard(index, "failed", err.message || String(err));
      } finally {
        setButtonsEnabled();
      }
    });
  });

  cardsEl.querySelectorAll(".dl").forEach(button => {
    button.addEventListener("click", () => {
      downloadPreviewPng(Number(button.dataset.index));
    });
  });

  cardsEl.querySelectorAll(".edit").forEach(button => {
    button.addEventListener("click", () => {
      editInPhotopea(Number(button.dataset.index));
    });
  });

  cardsEl.querySelectorAll(".export").forEach(button => {
    button.addEventListener("click", async () => {
      const index = Number(button.dataset.index);
      try {
        await exportCard(index);
      } catch (err) {
        markCard(index, "failed", err.message || String(err));
      } finally {
        setButtonsEnabled();
      }
    });
  });

  setButtonsEnabled();
}

function markCard(index, state, message) {
  const el = document.getElementById(`card-${index}`);
  if (!el) return;
  el.classList.remove("done", "failed");
  if (state) el.classList.add(state);
  const s = el.querySelector(".cardStatus");
  if (s) {
    s.className = "cardStatus " + (state === "done" ? "ok" : state === "failed" ? "error" : "");
    s.textContent = message;
  }
}

function setButtonsEnabled() {
  const canGenerate = photopeaReady && !!templateBuffer && cards.length > 0;
  generateBtn.disabled = !canGenerate || running;
  if (generatePngOnlyBtn) generatePngOnlyBtn.disabled = !canGenerate || running;
  $("inspect").disabled = !photopeaReady || !templateBuffer || running;

  cardsEl.querySelectorAll(".gen").forEach((button, i) => {
    button.disabled = !canGenerate || !artFor(cards[i].Art) || running;
  });
  cardsEl.querySelectorAll(".dl").forEach((button, i) => {
    button.disabled = running || !cardPreviews.has(i);
  });
  cardsEl.querySelectorAll(".edit").forEach((button, i) => {
    button.disabled = running || previewIndex !== i;
  });
  cardsEl.querySelectorAll(".export").forEach((button, i) => {
    button.disabled = running || previewIndex !== i;
  });
}

art.addEventListener("change", () => {
  artFiles.clear();
  for (const file of art.files) {
    artFiles.set(file.name.toLowerCase(), file);
  }
  if (cards.length) renderCards();
});

loadBtn.addEventListener("click", async () => {
  try {
    if (!sheet.files[0] || !template.files[0]) {
      throw new Error("Select a CSV and a PSD template.");
    }

    if (!photopeaReady) {
      throw new Error("Photopea is still loading. Wait until it says Ready.");
    }

    cards = await readCsv(sheet.files[0]);
    templateBuffer = await template.files[0].arrayBuffer();

    if (!cards.length) throw new Error("The CSV contains no card rows.");

    resetPreviews();
    renderCards();
    setButtonsEnabled();
    setStatus(`Loaded ${cards.length} card(s). ${artFiles.size} art file(s) indexed.`, "ok");
  } catch (err) {
    setStatus(err.message || String(err), "error");
  }
});

async function runBulkGenerate(includePsd) {
  if (running) return;
  running = true;
  progressWrap.classList.remove("hidden");
  progressBar.style.width = "0%";
  setButtonsEnabled();

  let completed = 0;

  try {
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      setStatus(`Generating ${i + 1}/${cards.length}: ${card.Name}…`);
      try {
        // Bulk mode builds each card and immediately exports + downloads —
        // no review pause, and no confirmation prompt for discarding the
        // previous card's (already-exported) document.
        await previewCard(i, { silent: true });
        await exportCard(i, { includePsd });
      } catch (err) {
        markCard(i, "failed", err.message || String(err));
      }
      completed++;
      progressBar.style.width = `${Math.round((completed / cards.length) * 100)}%`;
    }

    const failures = document.querySelectorAll(".card.failed").length;
    setStatus(
      failures
        ? `Finished with ${failures} failure(s). Check the red cards.`
        : `Finished all ${cards.length} card(s).`,
      failures ? "warn" : "ok"
    );
  } finally {
    running = false;
    setButtonsEnabled();
  }
}

generateBtn.addEventListener("click", () => runBulkGenerate(true));
if (generatePngOnlyBtn) {
  generatePngOnlyBtn.addEventListener("click", () => runBulkGenerate(false));
}

$("inspect").addEventListener("click", async () => {
  if (!photopeaReady || !templateBuffer) return;
  try {
    setStatus("Inspecting template layers…");
    await sendScript(`
      var out=[];
      function walk(layers,depth,path){
        for(var i=0;i<layers.length;i++){
          var l=layers[i];
          out.push(Array(depth+1).join("  ")+path+l.name+" ["+l.kind+"]");
          if(l.layers)walk(l.layers,depth+1,path+"");
        }
      }
      if(app.documents.length){
        app.activeDocument.source="release-tcg-inspect";
      }
      walk(app.activeDocument.layers,0,"");
      app.echoToOE("LAYERS:\\n"+out.join("\\n"));
    `);
    setStatus("Template inspected. Check the Photopea message output if needed.", "ok");
  } catch (err) {
    setStatus(err.message || String(err), "error");
  }
});

pp.addEventListener("load", () => {
  ppStatus.textContent = "Loading Photopea…";
});

window.addEventListener("message", event => {
  if (event.source !== pp.contentWindow) return;

  if (typeof event.data === "string" && event.data.startsWith("LAYERS:\n")) {
    console.log(event.data);
    setStatus("Template layer tree printed to the browser console (F12).", "ok");
    return;
  }

  if (typeof event.data === "string" && event.data.startsWith("NAMEDEBUG:")) {
    console.log(event.data);
    return;
  }

  if (typeof event.data === "string" && event.data.startsWith("ARTDEBUG:")) {
    console.log("Art/template document match:", JSON.parse(event.data.slice("ARTDEBUG:".length)));
    return;
  }

  if (typeof event.data === "string" && event.data.startsWith("ARTDEBUG2:")) {
    console.log(event.data);
    return;
  }

  if (typeof event.data === "string" && event.data.startsWith("ARTDEBUG3:")) {
    console.log(event.data);
    return;
  }

  if (typeof event.data === "string" && event.data.startsWith("ARTPROBE:")) {
    try {
      lastArtProbe = JSON.parse(event.data.slice("ARTPROBE:".length));
    } catch {
      lastArtProbe = null;
    }
    return;
  }

  if (event.data === "done") {
    photopeaReady = true;
    ppStatus.textContent = "Ready";
    setButtonsEnabled();
    if (!running && cards.length) {
      setStatus("Photopea is ready. Individual Generate buttons are enabled.", "ok");
    }
    return;
  }

  // Cross-window ArrayBuffers can be represented by an object from another realm.
  // Do not rely on instanceof ArrayBuffer.
  if (event.data && typeof event.data === "object" && typeof event.data.byteLength === "number") {
    resolveBinary(event.data);
  }
});

let binaryResolver = null;
let binaryRejecter = null;
let binaryTimer = null;
let lastArtProbe = null;

function resolveBinary(data) {
  if (!binaryResolver) return;
  const resolve = binaryResolver;
  clearTimeout(binaryTimer);
  binaryResolver = null;
  binaryRejecter = null;
  binaryTimer = null;
  resolve(data);
}

function waitForBinary(timeout = 180000) {
  return new Promise((resolve, reject) => {
    binaryResolver = resolve;
    binaryRejecter = reject;
    binaryTimer = setTimeout(() => {
      binaryResolver = null;
      binaryRejecter = null;
      binaryTimer = null;
      reject(new Error("Timed out waiting for Photopea export."));
    }, timeout);
  });
}

// Every Photopea operation is serialized.
// This prevents one card's close/open/export commands from racing the next card.
function sendCommand(payload, timeout = 180000) {
  const task = commandQueue.then(() => new Promise((resolve, reject) => {
    let finished = false;
    let timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Photopea."));
    }, timeout);

    function cleanup() {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("message", handler);
    }

    function handler(event) {
      if (event.source !== pp.contentWindow) return;

      // Photopea scripts in this generator use ERROR:... for exceptions.
      if (typeof event.data === "string" && event.data.startsWith("ERROR:")) {
        cleanup();
        reject(new Error(event.data.slice(6)));
        return;
      }

      if (event.data === "done") {
        cleanup();
        resolve();
      }
    }

    window.addEventListener("message", handler);
    pp.contentWindow.postMessage(payload, "*");
  }));

  commandQueue = task.catch(() => {});
  return task;
}

function sendFile(buffer) {
  return sendCommand(buffer);
}

function wrapScript(script) {
  return `(function(){
try {
${script}
} catch(e) {
  app.echoToOE("ERROR:" + (e && e.message ? e.message : String(e)));
}
})()`;
}

function sendScript(script) {
  return sendCommand(wrapScript(script));
}

function downloadBuffer(buffer, filename, mime) {
  const blob = new Blob([buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function q(value) {
  return JSON.stringify(String(value ?? ""));
}

// Polls the artwork document's dimensions and first layer's bounds,
// logging each attempt, until two consecutive reads come back identical
// (a sign the async pixel load has settled) — or gives up and just warns,
// since blocking generation entirely on an unconfirmed theory isn't worth
// it. Sets activeDocument to the art doc before reading .bounds, since
// Photopea's bounds reads have proven unreliable off the active document
// elsewhere in this script (see the CardName bounds comments below).
async function waitForArtReady(maxAttempts = 15, delayMs = 200) {
  let lastKey = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastArtProbe = null;
    await sendScript(`
      var d=null;
      for(var i=0;i<app.documents.length;i++){
        if(app.documents[i].source==="release-tcg-art"){d=app.documents[i];break;}
      }
      if(!d)throw Error("Artwork document not found while probing readiness.");
      app.activeDocument=d;
      function num(v){
        if (v == null) return NaN;
        if (typeof v === "number") return v;
        try {
          var p = JSON.parse(JSON.stringify(v));
          if (p && typeof p.n === "number") return p.n;
        } catch (e) {}
        return Number(v);
      }
      var l=d.layers.length?d.layers[0]:null;
      var b=l?l.bounds:null;
      app.echoToOE("ARTPROBE:"+JSON.stringify({
        width:Number(d.width),
        height:Number(d.height),
        layers:d.layers.length,
        layerKind:l?l.kind:null,
        rawBounds:b,
        boundsW:b?(num(b[2])-num(b[0])):0,
        boundsH:b?(num(b[3])-num(b[1])):0
      }));
    `);

    const info = lastArtProbe;
    console.log(`waitForArtReady attempt ${attempt + 1}:`, info);

    const ready = info && info.width > 0 && info.height > 0 &&
      info.layers > 0 && info.boundsW > 0 && info.boundsH > 0;
    const key = ready ? `${info.width}x${info.height}x${info.boundsW}x${info.boundsH}` : null;

    if (ready && key === lastKey) return;
    lastKey = key;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  console.warn("waitForArtReady never stabilized after", maxAttempts, "attempts — proceeding anyway.");
}

function buildScript(card) {
  const colors = [card.Color1, card.Color2, card.Color3, card.Color4];

  return `(function(){
function find(root,name){
  if(!root||!root.layers)return null;
  for(var i=0;i<root.layers.length;i++){
    var l=root.layers[i];
    if(l.name===name)return l;
    if(l.layers){var z=find(l,name);if(z)return z;}
  }
  return null;
}
function findAny(root,names){
  for(var i=0;i<names.length;i++){
    var x=find(root,names[i]);
    if(x)return x;
  }
  return null;
}
// UnitValue bounds fix: extract .n via JSON round-trip (direct .n / in
// access doesn't work in this Photopea build's script interpreter).
function num(v){
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  try {
    var p = JSON.parse(JSON.stringify(v));
    if (p && typeof p.n === "number") return p.n;
  } catch (e) {}
  return Number(v);
}
function boundsPx(b){
  return [num(b[0]),num(b[1]),num(b[2]),num(b[3])];
}
// Centers a text layer: duplicate it, rasterize the duplicate to get real
// measurable bounds, translate to targetCenterX, hide the original.
function centerTextLayerHorizontally(layer,targetCenterX){
  var dup=layer.duplicate();
  dup.rasterize(RasterizeType.ENTIRELAYER);
  var bb=boundsPx(dup.bounds);
  var currentCenterX=(bb[0]+bb[2])/2;
  dup.translate(targetCenterX-currentCenterX,0);
  layer.visible=false;
  return dup;
}
var template=null, artDoc=null;
for(var i=0;i<app.documents.length;i++){
  var d=app.documents[i];
  if(d.source==="release-tcg-template") template=d;
  if(d.source==="release-tcg-art") artDoc=d;
}
if(!template)throw Error("Could not find the template document.");
if(!artDoc)throw Error("Could not find the artwork document.");

app.activeDocument=template;

// Must be set before any .bounds reads or .translate() calls below —
// otherwise Number(bounds[...]) comes back in whatever the default ruler
// unit is (not necessarily pixels), which silently corrupts the name's
// shrink-to-fit math and its translate() offset.
app.preferences.rulerUnits=Units.PIXELS;

// The rasterized gray filler layer used as an art placeholder — used
// later to size/position the real artwork.
var artPlaceholder=find(template,"ArtLayer");
if(!artPlaceholder)throw Error("ArtLayer placeholder not found.");

// Card name lives on a layer named "CardName", nested inside a top-level
// "Template" group — it is NOT a direct top-level layer of the document.
var nameLayer=find(template,"CardName");
if(!nameLayer)throw Error("Card-name text layer (\\"CardName\\") not found.");
if(nameLayer.kind!==LayerKind.TEXT)throw Error("CardName layer is not a text layer (kind="+nameLayer.kind+") — check the template.");

var cardCenterX=Number(template.width)/2;
var trimmedName=String(${q(card.Name)}||"").trim();
nameLayer.visible=trimmedName.length>0;
if(trimmedName.length>0){
  nameLayer.textItem.contents=trimmedName;
  var nameCentered=centerTextLayerHorizontally(nameLayer,cardCenterX);
  app.echoToOE("NAMEDEBUG: contents="+trimmedName+" centeredBounds="+JSON.stringify(boundsPx(nameCentered.bounds))+" cardCenterX="+cardCenterX);
}

// Tunable box for Clarify lines' word-wrap — margin from each card edge,
// and a generous box height so long text won't get clipped. Adjust these
// if wrapped text still touches the card border or looks clipped.
var CLARIFY_MARGIN=60;
var CLARIFY_BOX_WIDTH=Number(template.width)-(CLARIFY_MARGIN*2);
var CLARIFY_BOX_HEIGHT=300;
// Shifts the clarify text box up/down after centering — negative moves up.
// Currently -10px so the 3 allotted clarify lines fit without crowding
// the layer below. Adjust if you add/remove lines later.
var CLARIFY_VERTICAL_OFFSET=-10;


var bottom=findAny(template,["BottomLine","BottomLin"]);
if(!bottom)throw Error("Bottom Line group not found.");

// The three text layers inside Bottom Line are named CardNumberLine,
// SetName, and ArtistLine.
var numberLayer=find(bottom,"CardNumberLine");
var setLayer=find(bottom,"SetName");
var artistLayer=find(bottom,"ArtistLine");
if(!setLayer)throw Error("SetName layer not found inside Bottom Line.");
if(!numberLayer)throw Error("CardNumberLine layer not found inside Bottom Line.");
if(!artistLayer)throw Error("ArtistLine layer not found inside Bottom Line.");

setLayer.textItem.contents=${q(card.SetName)};
numberLayer.textItem.contents=${q(card.CardNumber)};
artistLayer.textItem.contents="Artist: "+${q(card.Artist)};

var effects=find(template,"Effects");
if(!effects)throw Error("Effects group not found.");

// The template now has 6 dedicated text layers instead of 3 combined boxes.
// Match each one by name explicitly — do NOT rely on tree order, since
// find-first-N-text-layers no longer maps to [Trait, Effect1, Effect2].
var traitLine=find(effects,"TraitLine");
var clarify1Line=find(effects,"Clarify1");
var effect1Line=find(effects,"Effect1Line");
var clarify2Line=find(effects,"Clarify2");
var effect2Line=find(effects,"Effect2Line");
var clarify3Line=find(effects,"Clarify3");
if(!traitLine)throw Error("TraitLine layer not found.");
if(!clarify1Line)throw Error("Clarify1 layer not found.");
if(!effect1Line)throw Error("Effect1Line layer not found.");
if(!clarify2Line)throw Error("Clarify2 layer not found.");
if(!effect2Line)throw Error("Effect2Line layer not found.");
if(!clarify3Line)throw Error("Clarify3 layer not found.");

var headerSize=40;
var headerLeading=40;

function setEffectLine(layer,text,center){
  var trimmed=String(text||"").trim();
  layer.visible=trimmed.length>0;
  if(trimmed.length>0){
    // Clarify text can run several sentences long — use a paragraph text
    // box (fixed width) so Photopea wraps it automatically instead of
    // letting it run off the card. Set kind/width/height BEFORE contents
    // so the wrap applies immediately.
    layer.textItem.kind=TextType.PARAGRAPHTEXT;
    layer.textItem.width=CLARIFY_BOX_WIDTH;
    layer.textItem.height=CLARIFY_BOX_HEIGHT;
    layer.textItem.justification=Justification.CENTER;
    layer.textItem.contents=trimmed;
    var target=layer;
    if(center)target=centerTextLayerHorizontally(layer,cardCenterX);
    target.translate(0,CLARIFY_VERTICAL_OFFSET);
  }
}
// Trait/Effect1/Effect2 are the bold all-caps header lines.
function setHeaderLine(layer,text,center){
  var trimmed=String(text||"").trim();
  layer.visible=trimmed.length>0;
  if(trimmed.length>0){
    layer.textItem.contents=trimmed.toUpperCase();
    layer.textItem.size=headerSize;
    layer.textItem.leading=headerLeading;
    layer.textItem.fauxBold=true;
    if(center)centerTextLayerHorizontally(layer,cardCenterX);
  }
}
// Pass true as the last arg to center that line horizontally on the card —
// toggle these independently while experimenting with the layout.
setHeaderLine(traitLine,${q(card.Trait)},true);
setEffectLine(clarify1Line,${q(card.Clarify1)},true);
setHeaderLine(effect1Line,${q(card.Effect1)},true);
setEffectLine(clarify2Line,${q(card.Clarify2)},true);
setHeaderLine(effect2Line,${q(card.Effect2)},true);
setEffectLine(clarify3Line,${q(card.Clarify3)},true);

// The supplied PSD calls this group "Color" internally, while the
// conceptual layer tree calls it "Colors". Support both.
var cg=findAny(template,["Colors","Color"]);
if(!cg)throw Error("Colors group not found.");

var codes=["R","O","Y","G","C","B","V","M","P"];
var colorMap={
  RED:"R",ORANGE:"O",YELLOW:"Y",GREEN:"G",CYAN:"C",
  BLUE:"B",VIOLET:"V",MAGENTA:"M",PINK:"P"
};
var wanted=[${colors.map(q).join(",")}];

for(var pos=1;pos<=4;pos++){
  var posGroup=find(cg,"Color"+pos);
  if(!posGroup)throw Error("Color position group Color"+pos+" not found.");
  var wantedCode=colorMap[String(wanted[pos-1]||"").trim().toUpperCase()];
  for(var cc=0;cc<codes.length;cc++){
    var cl=find(posGroup,codes[cc]);
    if(cl)cl.visible=!!wantedCode&&wantedCode===codes[cc];
  }
}

var stats=find(template,"Stats");
if(!stats)throw Error("Stats group not found.");
var powGroup=find(stats,"Power");
var bulkGroup=find(stats,"Bulk");
if(!powGroup)throw Error("Power group not found inside Stats.");
if(!bulkGroup)throw Error("Bulk group not found inside Stats.");

for(var pi=0;pi<powGroup.layers.length;pi++){
  if(/^\\d+$/.test(powGroup.layers[pi].name))
    powGroup.layers[pi].visible=powGroup.layers[pi].name===${q(card.Power)};
}
for(var bi=0;bi<bulkGroup.layers.length;bi++){
  if(/^\\d+$/.test(bulkGroup.layers[bi].name))
    bulkGroup.layers[bi].visible=bulkGroup.layers[bi].name===${q(card.Bulk)};
}

// --- Artwork placement: cover-fit and center on the card, above ArtLayer ---

// Work in artDoc first to get a single clean source layer
app.activeDocument = artDoc;
if (artDoc.layers.length > 1) artDoc.flatten();
var artSourceLayer = artDoc.activeLayer || artDoc.layers[0];
if (!artSourceLayer) throw Error("Artwork document has no layers.");

// Match resolution to template so scaling behaves predictably
if (Number(artDoc.resolution) !== Number(template.resolution)) {
  artDoc.resizeImage(undefined, undefined, template.resolution, ResampleMethod.NONE);
}

var cardW = Number(template.width);
var cardH = Number(template.height);
var artW0 = Number(artDoc.width);
var artH0 = Number(artDoc.height);
if (!(artW0 > 0 && artH0 > 0)) throw Error("Artwork document has invalid dimensions.");

// Copy the art into the template via the clipboard instead of duplicate()
// across documents. duplicate(doc) proved unreliable in this Photopea
// build ("ADDLAYERS different projs" / getName errors). selection-based
// copy (selectAll + selection.copy()) also proved unreliable here (logged
// "doCopy false" internally, producing an empty pasted layer). Use the
// layer's own .copy() method instead — it copies the layer directly to
// the clipboard without needing a selection object.
app.activeDocument = artDoc;
artSourceLayer.copy();

app.activeDocument = template;
template.paste();
var newArt = template.activeLayer;
if (!newArt) throw Error("paste() did not produce a new layer.");
newArt.name = "Card Art";
newArt.visible = true;

var pasteBB = newArt.bounds;
app.echoToOE("ARTDEBUG3: post-paste kind=" + newArt.kind +
             " bounds=" + JSON.stringify(pasteBB) +
             " opacity=" + newArt.opacity +
             " isBackgroundLayer=" + newArt.isBackgroundLayer);

// Uniform scale by whichever ratio is larger, so both dimensions end up
// >= the card's size (aspect ratio preserved, no distortion), then center
// — any overflow beyond the card gets cropped by ArtLayer's clip mask.
var bb = boundsPx(newArt.bounds);
var w = bb[2] - bb[0];
var h = bb[3] - bb[1];
if (!(w > 0 && h > 0)) throw Error("Artwork layer has invalid bounds.");

var scale = Math.max(cardW / w, cardH / h) * 100;
newArt.resize(scale, scale, AnchorPosition.MIDDLECENTER);

// Re-read bounds after scaling and center on the card
bb = boundsPx(newArt.bounds);
var artCenterX = (bb[0] + bb[2]) / 2;
var artCenterY = (bb[1] + bb[3]) / 2;
var cardCenterY = cardH / 2;

newArt.translate(cardCenterX - artCenterX, cardCenterY - artCenterY);

app.echoToOE("ARTDEBUG2: placed art, cover-fit scale=" + scale +
             " cardW=" + cardW + " cardH=" + cardH);

// Reorder newArt to sit just ABOVE ArtLayer, then clip it to ArtLayer's
// shape (rounded-rect corners etc.) instead of hiding ArtLayer outright.
// ArtLayer must stay VISIBLE — a clip base layer's own alpha defines the
// mask shape, so hiding it would hide everything clipped to it too. Its
// fill color doesn't matter since Card Art fully covers it once clipped.
// Done LAST, after all bounds reads/resizes, so nothing touches this
// layer's content after the reorder/clip jobs fire.
newArt.move(artPlaceholder, ElementPlacement.PLACEBEFORE);
artPlaceholder.visible = true;
newArt.grouped = true;

template.name=${q(String(card.CardNumber).padStart(3,"0")+" - "+card.Name)};
app.activeDocument=artDoc;
artDoc.close(SaveOptions.DONOTSAVECHANGES);
app.activeDocument=template;
})()`;
}

async function exportCurrent(format) {
  const binaryPromise = waitForBinary();
  await sendScript(`app.activeDocument.saveToOE(${q(format)});`);
  return binaryPromise;
}

async function tagActiveDocument(source) {
  await sendScript(`app.activeDocument.source=${q(source)};`);
}

function cardStem(card) {
  return (
    String(card.CardNumber).padStart(3, "0") + " - " + card.SetName
  ).replace(/[<>:"/\\|?*]/g, "_");
}

// Builds the card in Photopea and leaves the PSD document open there for
// review/editing, plus stores a PNG preview. Only one card's document is
// kept live at a time — if a different card currently owns it, this asks
// for confirmation before discarding whatever is unexported in it.
async function previewCard(index, { silent = false } = {}) {
  if (!photopeaReady) throw new Error("Photopea is not ready.");
  const card = cards[index];
  const artFile = artFor(card.Art);
  if (!artFile) throw new Error(`Artwork not found: ${card.Art}`);

  if (!silent && previewIndex !== null && previewIndex !== index) {
    const otherName = cards[previewIndex] ? cards[previewIndex].Name : "the other card";
    const ok = window.confirm(
      `"${otherName}" is still open for editing in Photopea. Generating "${card.Name}" now ` +
      `will close it and discard any changes you haven't exported. Continue?`
    );
    if (!ok) throw new Error("Cancelled — export or finish editing the other card first.");
  }

  markCard(index, null, `Generating ${card.Name}…`);

  // Close only documents created by this generator. This prevents the
  // user's other Photopea documents from being touched.
  await sendScript(`
    for(var i=app.documents.length-1;i>=0;i--){
      var d=app.documents[i];
      if(d.source==="release-tcg-template" || d.source==="release-tcg-art"){
        d.close(SaveOptions.DONOTSAVECHANGES);
      }
    }
  `);
  if (previewIndex !== null && previewIndex !== index) previewIndex = null;

  await sendFile(templateBuffer);
  await tagActiveDocument("release-tcg-template");

  await sendFile(await artFile.arrayBuffer());
  await tagActiveDocument("release-tcg-art");
  await waitForArtReady();

  await sendScript(buildScript(card));

  const png = await exportCurrent("png");
  revokePreview(index);
  const pngBlob = new Blob([png], { type: "image/png" });
  cardPreviews.set(index, { blob: pngBlob, url: URL.createObjectURL(pngBlob) });
  previewIndex = index;

  markCard(index, "done", "Preview ready — download the PNG, edit it in Photopea, or export.");
  renderCards();
}

// Re-selects this card's PSD document (picking up any manual edits made
// directly in the Photopea panel) and exports + downloads PNG, and PSD
// unless includePsd is false.
async function exportCard(index, { includePsd = true } = {}) {
  if (previewIndex !== index) {
    throw new Error("This card's document isn't open in Photopea. Click Generate first.");
  }
  const card = cards[index];

  await sendScript(`
    for(var i=0;i<app.documents.length;i++){
      if(app.documents[i].source==="release-tcg-template"){
        app.activeDocument=app.documents[i];
        break;
      }
    }
  `);

  const psd = includePsd ? await exportCurrent("psd") : null;
  const png = await exportCurrent("png");

  revokePreview(index);
  const pngBlob = new Blob([png], { type: "image/png" });
  cardPreviews.set(index, { blob: pngBlob, url: URL.createObjectURL(pngBlob) });

  const stem = cardStem(card);
  if (includePsd) downloadBuffer(psd, `${stem}.psd`, "application/octet-stream");
  downloadBuffer(png, `${stem}.png`, "image/png");

  markCard(index, "done", includePsd
    ? "Exported PSD + PNG (including any manual edits)."
    : "Exported PNG (including any manual edits).");
  renderCards();
}

function downloadPreviewPng(index) {
  const preview = cardPreviews.get(index);
  if (!preview) return;
  const card = cards[index];
  const url = URL.createObjectURL(preview.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${cardStem(card)}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// The card's PSD is already the active, visible document in the Photopea
// panel once previewCard() runs — there's no extra API call needed to
// "open" it. This just brings the panel into view and orients the user.
function editInPhotopea(index) {
  if (previewIndex !== index) return;
  document.querySelector(".editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
  setStatus(
    `Editing "${cards[index].Name}" — make your changes directly in the Photopea panel, then click "Export PSD + PNG".`,
    "ok"
  );
}

setStatus("Waiting for Photopea…");

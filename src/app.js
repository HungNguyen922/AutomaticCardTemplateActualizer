// app.js — single-file, cleaned up, with 4 art scaling modes: cover / contain / stretch / none

const $ = id => document.getElementById(id);

const sheet = $("sheet");
const template = $("template");
const art = $("art");
const artScaleMode = $("artScaleMode");
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

let previewIndex = null;
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
  if (!filename) return null;

  const wantedBase = norm(filename)
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .replace(/\.[^.]+$/, "")
    .toLowerCase();

  for (const [key, file] of artFiles.entries()) {
    const fileBase = key.replace(/\.[^.]+$/, "").toLowerCase();
    if (fileBase === wantedBase) return file;
  }

  return null;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
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

  const scaleMode = artScaleMode.value || "cover";
  let completed = 0;

  try {
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      setStatus(`Generating ${i + 1}/${cards.length}: ${card.Name}…`);
      try {
        await previewCard(i, { silent: true, scaleMode });
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

let binaryResolver = null;
let binaryRejecter = null;
let binaryTimer = null;
let lastArtProbe = null;
let lastPasteProbe = null;

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

  if (typeof event.data === "string" && event.data.startsWith("PASTEPROBE:")) {
    try {
      lastPasteProbe = JSON.parse(event.data.slice("PASTEPROBE:".length));
    } catch {
      lastPasteProbe = null;
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

  if (event.data && typeof event.data === "object" && typeof event.data.byteLength === "number") {
    resolveBinary(event.data);
  }
});

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

// Photopea's internal copy()/paste() can return control to the script before
// the pasted layer's GPU texture/bounds have actually settled — locally this
// is masked by near-zero network latency, but over a real connection (e.g.
// GitHub Pages) the very next command can race Photopea's own rendering and
// crash its engine. Poll the pasted layer the same way waitForArtReady polls
// the source artwork, so we only proceed once its bounds are stable.
async function waitForPastedArtReady(maxAttempts = 15, delayMs = 200) {
  let lastKey = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastPasteProbe = null;
    await sendScript(`
      var t=null;
      for(var i=0;i<app.documents.length;i++){
        if(app.documents[i].source==="release-tcg-template"){t=app.documents[i];break;}
      }
      if(!t)throw Error("Template document not found while probing pasted art.");
      app.activeDocument=t;
      function find(root,name){
        if(!root||!root.layers)return null;
        for(var i=0;i<root.layers.length;i++){
          var l=root.layers[i];
          if(l.name===name)return l;
          if(l.layers){var z=find(l,name);if(z)return z;}
        }
        return null;
      }
      function num(v){
        if (v == null) return NaN;
        if (typeof v === "number") return v;
        try {
          var p = JSON.parse(JSON.stringify(v));
          if (p && typeof p.n === "number") return p.n;
        } catch (e) {}
        return Number(v);
      }
      var l=find(t,"Card Art Pending");
      var b=l?l.bounds:null;
      app.echoToOE("PASTEPROBE:"+JSON.stringify({
        found: !!l,
        kind: l?l.kind:null,
        rawBounds: b,
        boundsW: b?(num(b[2])-num(b[0])):0,
        boundsH: b?(num(b[3])-num(b[1])):0
      }));
    `);

    const info = lastPasteProbe;
    console.log(`waitForPastedArtReady attempt ${attempt + 1}:`, info);

    const ready = info && info.found && info.boundsW > 0 && info.boundsH > 0;
    const key = ready ? `${info.boundsW}x${info.boundsH}` : null;

    if (ready && key === lastKey) return;
    lastKey = key;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  console.warn("waitForPastedArtReady never stabilized after", maxAttempts, "attempts — proceeding anyway.");
}

// Sets every text/color/stat layer and performs the copy()/paste() of the
// artwork, tagging the pasted layer "Card Art Pending". It deliberately does
// NOT scale/position the art or touch ArtLayer — that happens in
// buildPlaceScript, as its own round trip, once waitForPastedArtReady()
// confirms the pasted layer's bounds have actually settled. Doing placement
// math in the same script as the paste is what let Photopea's internal
// clipboard/render pipeline race the script on real-world network latency
// (fine on localhost, flaky on GitHub Pages).
function buildPasteScript(card) {
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
app.preferences.rulerUnits=Units.PIXELS;

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

var CLARIFY_MARGIN=60;
var CLARIFY_BOX_WIDTH=Number(template.width)-(CLARIFY_MARGIN*2);
var CLARIFY_BOX_HEIGHT=300;
var CLARIFY_VERTICAL_OFFSET=-10;

var bottom=findAny(template,["BottomLine","BottomLin"]);
if(!bottom)throw Error("Bottom Line group not found.");

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
setHeaderLine(traitLine,${q(card.Trait)},true);
setEffectLine(clarify1Line,${q(card.Clarify1)},true);
setHeaderLine(effect1Line,${q(card.Effect1)},true);
setEffectLine(clarify2Line,${q(card.Clarify2)},true);
setHeaderLine(effect2Line,${q(card.Effect2)},true);
setEffectLine(clarify3Line,${q(card.Clarify3)},true);

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

// --- Copy/paste the artwork (placement happens in buildPlaceScript) ---

app.activeDocument = artDoc;
if (artDoc.layers.length > 1) artDoc.flatten();
var artSourceLayer = artDoc.activeLayer || artDoc.layers[0];
if (!artSourceLayer) throw Error("Artwork document has no layers.");

if (Number(artDoc.resolution) !== Number(template.resolution)) {
  artDoc.resizeImage(undefined, undefined, template.resolution, ResampleMethod.NONE);
}

if (!(Number(artDoc.width) > 0 && Number(artDoc.height) > 0)) {
  throw Error("Artwork document has invalid dimensions.");
}

artSourceLayer.copy();
artDoc.close(SaveOptions.DONOTSAVECHANGES);

app.activeDocument = template;
template.paste();
var newArt = template.activeLayer;
if (!newArt) throw Error("paste() did not produce a new layer.");
newArt.name = "Card Art Pending";
newArt.visible = true;

var pasteBB = newArt.bounds;
app.echoToOE("ARTDEBUG3: post-paste kind=" + newArt.kind +
             " bounds=" + JSON.stringify(pasteBB) +
             " opacity=" + newArt.opacity +
             " isBackgroundLayer=" + newArt.isBackgroundLayer);
})()`;
}

// Scales/positions the already-pasted "Card Art Pending" layer and drops it
// into place. Sent as its own message, only after waitForPastedArtReady()
// confirms the layer's bounds are non-zero and stable, so we never read
// newArt.bounds before Photopea has actually finished realizing the paste.
function buildPlaceScript(card, scaleMode) {
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

var template=null;
for(var i=0;i<app.documents.length;i++){
  if(app.documents[i].source==="release-tcg-template"){template=app.documents[i];break;}
}
if(!template)throw Error("Could not find the template document.");
app.activeDocument=template;

var artPlaceholder=find(template,"ArtLayer");
if(!artPlaceholder)throw Error("ArtLayer placeholder not found.");

var newArt=find(template,"Card Art Pending");
if(!newArt)throw Error("Pasted art layer not found — the paste step may have failed.");

var cardW = Number(template.width);
var cardH = Number(template.height);
var cardCenterX = cardW / 2;

var bb = boundsPx(newArt.bounds);
var w = bb[2] - bb[0];
var h = bb[3] - bb[1];
if (!(w > 0 && h > 0)) throw Error("Artwork layer has invalid bounds.");

var mode = ${q(scaleMode || "cover")};
var scaleX = 100;
var scaleY = 100;

if (mode === "cover") {
  var s = Math.max(cardW / w, cardH / h) * 100;
  scaleX = s;
  scaleY = s;
} else if (mode === "contain") {
  var s2 = Math.min(cardW / w, cardH / h) * 100;
  scaleX = s2;
  scaleY = s2;
} else if (mode === "stretch") {
  scaleX = (cardW / w) * 100;
  scaleY = (cardH / h) * 100;
} else if (mode === "none") {
  scaleX = 100;
  scaleY = 100;
}

newArt.resize(scaleX, scaleY, AnchorPosition.MIDDLECENTER);

bb = boundsPx(newArt.bounds);
var artCenterX = (bb[0] + bb[2]) / 2;
var artCenterY = (bb[1] + bb[3]) / 2;
var cardCenterY = cardH / 2;

newArt.translate(cardCenterX - artCenterX, cardCenterY - artCenterY);

app.echoToOE("ARTDEBUG2: placed art, mode=" + mode +
             " scaleX=" + scaleX + " scaleY=" + scaleY +
             " cardW=" + cardW + " cardH=" + cardH);

newArt.move(artPlaceholder, ElementPlacement.PLACEBEFORE);
artPlaceholder.visible = false;
newArt.name = "Card Art";
newArt.grouped = true;

template.name=${q(String(card.CardNumber).padStart(3,"0")+" - "+card.Name)};
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

async function previewCard(index, { silent = false, scaleMode } = {}) {
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

  if (!templateBuffer) throw new Error("No template PSD loaded.");

  // Close any leftover template document from a previous preview before
  // opening a fresh one — otherwise the script below can't find a document
  // tagged "release-tcg-template" and every generation fails immediately.
  await sendScript(`
    for (var i = 0; i < app.documents.length; i++) {
      if (app.documents[i].source === "release-tcg-template") {
        app.activeDocument = app.documents[i];
        app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);
        break;
      }
    }
  `);

  await sendFile(templateBuffer);
  await tagActiveDocument("release-tcg-template");

  const buffer = await artFile.arrayBuffer();
  await sendFile(buffer);
  await tagActiveDocument("release-tcg-art");
  await waitForArtReady();

  await sendScript(buildPasteScript(card));
  await waitForPastedArtReady();

  const mode = scaleMode || artScaleMode.value || "cover";
  await sendScript(buildPlaceScript(card, mode));
  await tagActiveDocument("release-tcg-template");

  const pngData = await exportCurrent("png");
  const blob = new Blob([pngData], { type: "image/png" });
  const url = URL.createObjectURL(blob);

  revokePreview(index);
  cardPreviews.set(index, { blob, url });
  previewIndex = index;

  markCard(index, "done", `Preview ready for ${card.Name}.`);
  renderCards();
}

async function exportCard(index, { includePsd = true } = {}) {
  if (!photopeaReady) throw new Error("Photopea is not ready.");
  if (previewIndex !== index) throw new Error("This card is not the active Photopea document.");

  const card = cards[index];
  const stem = cardStem(card);

  const pngData = await exportCurrent("png");
  downloadBuffer(pngData, `${stem}.png`, "image/png");

  if (includePsd) {
    const psdData = await exportCurrent("psd");
    downloadBuffer(psdData, `${stem}.psd`, "application/octet-stream");
  }

  markCard(index, "done", `Exported ${card.Name}.`);
}

function downloadPreviewPng(index) {
  const preview = cardPreviews.get(index);
  if (!preview) return;
  const card = cards[index];
  const stem = cardStem(card);
  downloadBuffer(preview.blob, `${stem}-preview.png`, "image/png");
}

function editInPhotopea(index) {
  if (previewIndex !== index) {
    setStatus("This card is not the active Photopea document.", "error");
    return;
  }
  setStatus("Card is already open in Photopea. Edit there, then Export when ready.", "ok");
}

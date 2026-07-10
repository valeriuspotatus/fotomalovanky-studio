// Patches the Fotomalovanky Shopify Chrome extension, in place, by replacing whole functions.
//
//   npm run patch-extension
//
// The extension is not part of this repository — it lives on the Desktop, it is built by the shop,
// and it ships as a bundle with no source beside it. Two things had to change:
//
//   1. It saved photographs only through window.showDirectoryPicker(). Brave ships the File System
//      Access API switched off (brave://flags/#file-system-access-api), so on Brave the button did
//      nothing at all — silently, because that failure path sets no error. It now falls back to
//      the browser's own downloader, which needs no picker and no flag.
//
//   2. It threw away the dedication. Shopify has what the customer typed — "Pro Jiříčka", accents
//      and all — and injected.js already reads it. The file names fold it to ASCII, and this tool
//      then has to guess. It now writes objednavka.json beside the photographs, and src/orderInfo.js
//      reads it. That is the only place the accents survive.
//
// It also opens the folder picker *before* fetching the photographs. Chromium expires the click
// that authorises a picker after five seconds, and four slow photos are enough to lose it.
//
// Re-run this after the shop ships a new build of the extension, then `npm run extension-smoke`.
// Idempotent: running it twice changes nothing.
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = 'C:/Users/David/Desktop/shopify-fotomalovanky-chrome';
const CONTENT = `${ROOT}/src/orders/index.js`;
const BACKGROUND = `${ROOT}/src/background/index.js`;
const MARK = 'FOTOMALOVANKY_SAVE';

/** The source text of `function name(...){...}`, brace-matched. */
function fnText(src, sig) {
  const start = src.indexOf(sig);
  if (start < 0) throw new Error(`could not find ${sig}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${sig}`);
}

const replaceFn = (src, sig, replacement) => src.replace(fnText(src, sig), replacement);

// ---------------------------------------------------------------- content script

let cs = readFileSync(CONTENT, 'utf8');
if (cs.includes(MARK)) {
  console.log('content script: already patched, leaving alone');
} else {
  // `$e` used to open the picker itself. It now writes into a handle the caller already holds,
  // and drops objednavka.json in beside the photographs.
  cs = replaceFn(
    cs,
    'async function $e(',
    `async function $e(dir,images,sidecarText){for(const g of images){if(!g.blob)continue;const c=await(await dir.getFileHandle(g.filename,{create:!0})).createWritable();await c.write(g.blob),await c.close()}const j=await(await dir.getFileHandle("objednavka.json",{create:!0})).createWritable();await j.write(new Blob([sidecarText],{type:"application/json"})),await j.close();console.info(\`[Fotomalovanky] Saved \${images.length} file(s) and objednavka.json\`)}`,
  );

  // The dedication exactly as the customer typed it. The photo file names fold it to ASCII
  // ("Pro Jiříčka" -> "pro jiricka"), and nothing downstream can put the accents back.
  const helpers = `function fmaDedication(variants){for(const v of variants||[])if(v&&typeof v.label=="string"&&v.label.trim())return v.label.trim();return""}
function fmaSidecar(orderId,variants,files){return JSON.stringify({order:String(orderId),dedication:fmaDedication(variants),photos:files.map(f=>f.filename),source:"shopify-fotomalovanky-chrome",downloadedAt:new Date().toISOString()},null,2)}
function fmaFailed(failed){const c=\`Failed to download \${failed.length} image(s): \${failed.join(", ")}\`;return console.error(\`[Fotomalovanky] \${c}\`),{success:!1,error:c,failedCount:failed.length}}
`;

  cs = replaceFn(
    cs,
    'async function Be(',
    `${helpers}async function Be(e,r){try{const folder=Z(\`Fotomalovanky.cz - Objednávka #\${r}\`),files=Ee(e,r),sidecar=fmaSidecar(r,e,files);
console.info(\`[Fotomalovanky] Downloading \${files.length} image(s) from \${e.length} variant(s) for order #\${r}\`);
let dir=null;
if(Se()){try{dir=await(await window.showDirectoryPicker({mode:"readwrite",id:"fotomalovanky-downloads"})).getDirectoryHandle(folder,{create:!0})}catch(err){if(err&&err.name==="AbortError")return console.info("[Fotomalovanky] User cancelled folder selection"),{success:!1,error:"Cancelled"};console.warn("[Fotomalovanky] File System Access failed:",err&&err.name?\`\${err.name}: \${err.message}\`:String(err))}}
if(dir){const{images:g,failed:A}=await Fe(files);if(A.length>0)return fmaFailed(A);return await $e(dir,g,sidecar),{success:!0,usedFSA:!0}}
console.info("[Fotomalovanky] No folder picker (Brave switches it off) — using the browser's downloader");
const res=await ge.runtime.sendMessage({type:"${MARK}",folder,sidecar,files:files.map(f=>({url:f.url,filename:f.filename}))});
if(!res||!res.success)return{success:!1,error:res&&res.error||"No download method available",failedCount:res&&res.failedCount};
return{success:!0,usedFSA:!1,folder}}catch(n){const t=n instanceof Error?n.message:String(n);return console.error("[Fotomalovanky] Download failed:",t),{success:!1,error:t}}}`,
  );

  // The success toast only fired on the File System Access path. Now both paths finish.
  const before = cs;
  cs = cs.replace('t.usedFSA&&(J("', 't.success&&(J("');
  if (cs === before) throw new Error('could not find the success-toast guard');

  writeFileSync(CONTENT, cs);
  console.log('content script: patched');
}

// ---------------------------------------------------------------- service worker

let bg = readFileSync(BACKGROUND, 'utf8');
if (bg.includes(MARK)) {
  console.log('service worker: already patched, leaving alone');
} else {
  bg += `

// ---------------------------------------------------------------------------------------------
// Saving without a folder picker.
//
// Brave ships the File System Access API disabled (brave://flags/#file-system-access-api), so
// window.showDirectoryPicker() does not exist and the content script has nowhere to write. The
// browser's own downloader needs no picker, no user gesture and no CORS: it fetches the photo
// itself. Files land in <Downloads>/Fotomalovanky.cz - Objednávka NNNN/.
//
// The photographs are fetched here, not passed in as blobs: extension messages are JSON, and a
// blob does not survive the trip.

const FMA_MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/tiff': 'tiff' };

/** A service worker has no URL.createObjectURL, so the downloader is handed a data: URL.
 *  btoa() over a multi-megabyte string blows the argument limit; go a chunk at a time. */
async function fmaDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return \`data:\${blob.type || 'application/octet-stream'};base64,\${btoa(binary)}\`;
}

/** Resolve once the file is really on disk, so a failure is reported rather than assumed. */
function fmaDownload(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false }, (id) => {
      if (chrome.runtime.lastError || id === undefined) return reject(new Error(chrome.runtime.lastError?.message ?? 'download refused'));
      const done = (delta) => {
        if (delta.id !== id || !delta.state) return;
        if (delta.state.current === 'complete') { chrome.downloads.onChanged.removeListener(done); resolve(id); }
        else if (delta.state.current === 'interrupted') { chrome.downloads.onChanged.removeListener(done); reject(new Error('download interrupted')); }
      };
      chrome.downloads.onChanged.addListener(done);
    });
  });
}

async function fmaSave({ folder, files, sidecar }) {
  const failed = [];
  for (const file of files) {
    try {
      const res = await fetch(file.url);
      if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
      const blob = await res.blob();

      // Ee() leaves ".__unknown__" when the URL carries no extension; the response knows better.
      let filename = file.filename;
      if (filename.includes('__unknown__')) filename = filename.replace('.__unknown__', \`.\${FMA_MIME_EXT[(blob.type || '').toLowerCase()] ?? 'jpg'}\`);

      await fmaDownload(await fmaDataUrl(blob), \`\${folder}/\${filename}\`);
      console.info('[Fotomalovanky] Saved:', filename);
    } catch (err) {
      console.error(\`[Fotomalovanky] Failed to save \${file.filename}:\`, err);
      failed.push(file.filename);
    }
  }
  if (failed.length) return { success: false, error: \`Failed to download \${failed.length} image(s): \${failed.join(', ')}\`, failedCount: failed.length };

  // The title-page text, spelled the way the customer spelled it.
  await fmaDownload(\`data:application/json;base64,\${btoa(unescape(encodeURIComponent(sidecar)))}\`, \`\${folder}/objednavka.json\`);
  console.info('[Fotomalovanky] Saved objednavka.json');
  return { success: true, folder };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== '${MARK}') return;
  fmaSave(message).then(sendResponse, (err) => sendResponse({ success: false, error: String(err?.message ?? err) }));
  return true; // the reply is asynchronous
});
`;
  writeFileSync(BACKGROUND, bg);
  console.log('service worker: patched');
}

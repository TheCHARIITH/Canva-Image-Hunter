const listEl = document.getElementById("list");
const btnRefresh = document.getElementById("refresh");
const btnDownloadAll = document.getElementById("downloadAll");
const toastHost = document.getElementById("toastHost");

let state = { items: [], tabId: null };

// Canva-only guard
async function ensureCanvaTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  try {
    const u = new URL(tab.url);
    if (u.hostname.endsWith(".canva.com") || u.hostname === "canva.com") return tab;
  } catch {}
  listEl.innerHTML = "<div style='padding:10px;color:#b00;'>Open a Canva page to use this extension.</div>";
  return null;
}

// Allow only media-public.canva.com
const ALLOW_PREFIX = "https://media-public.canva.com/";

function toast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  toastHost.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 200); }, 1400);
  try { chrome.runtime.sendMessage({ type: "notify", title: "Canva Images Helper", message: text }); } catch {}
}

// Runs inside each frame to collect candidates (filtered in popup)
function frameCollector() {
  const LAZY_URL = ["data-src","data-lazy-src","data-original","data-hires","data-full","data-image","data-url"];
  const LAZY_SET = ["data-srcset","data-lazy-srcset"];

  const parseSet = s => !s ? [] : s.split(",").map(x=>x.trim()).map(p=>{
    const m=p.match(/^(\S+)\s+(\d+\.?\d*)(w|x)$/i);
    return m?{url:m[1],value:+m[2],kind:m[3].toLowerCase()}:{url:p,value:1,kind:"x"};
  });
  const pick = c => {
    const w=c.filter(x=>x.kind==="w").sort((a,b)=>b.value-a.value);
    if(w.length) return w[0].url;
    const x=c.filter(x=>x.kind==="x").sort((a,b)=>b.value-a.value);
    if(x.length) return x[0].url;
    return c[0]?.url||null;
  };

  function bestFromImg(img){
    let c = [];
    c = c.concat(parseSet(img.getAttribute("srcset")));
    const pc = img.closest("picture");
    if (pc) pc.querySelectorAll("source[srcset]").forEach(s=>c=c.concat(parseSet(s.getAttribute("srcset"))));
    LAZY_SET.forEach(a=>{ const v=img.getAttribute(a); if(v) c=c.concat(parseSet(v)); });
    if (c.length) { const u=pick(c); if(u) return u; }
    for (const a of LAZY_URL){ const v=img.getAttribute(a); if(v) return v; }
    return img.currentSrc || img.src || null;
  }

  function* walk(root){
    const st=[root]; let n=0, MAX=5000;
    while(st.length){ const x=st.pop(); if(++n>MAX) break; yield x;
      if(x.shadowRoot) st.push(x.shadowRoot);
      if(x.childNodes) for(let i=x.childNodes.length-1;i>=0;i--){
        const c=x.childNodes[i]; if(c.nodeType===1) st.push(c);
      }
    }
  }

  const res=[], seen=new Set();
  for(const node of walk(document.documentElement)){
    if(!(node instanceof Element)) continue;
    if(node.tagName==="IMG"){
      const url=bestFromImg(node);
      if(!url || url.startsWith("blob:")) continue;
      const key="img|"+url;
      if(!seen.has(key)){ seen.add(key); res.push({url,thumb:node.currentSrc||node.src||url,type:"img",frame:location.href}); }
    }
  }

  // Inline previews (data/blob)
  for (const img of Array.from(document.images||[])){
    if (img.src && (img.src.startsWith("data:") || img.src.startsWith("blob:"))){
      const key="inline|"+img.src;
      if(!seen.has(key)){ seen.add(key); res.push({url:img.src,thumb:img.src,type:"inline",frame:location.href}); }
    }
  }
  return res;
}

function render(){
  listEl.innerHTML = "";
  state.items.forEach(item=>{
    const card=document.createElement("div"); card.className="card";

    const controls=document.createElement("div"); controls.className="controls";
    const host=document.createElement("span"); host.className="host";
    try{ host.textContent=new URL(item.frame).hostname; }catch{ host.textContent=""; }
    const badge=document.createElement("span"); badge.className="badge"; badge.textContent=item.type;
    controls.append(host, badge);

    const thumb=document.createElement("div"); thumb.className="thumb";
    const img=document.createElement("img"); img.src=item.thumb||item.url; img.alt="preview"; img.referrerPolicy="no-referrer";
    thumb.appendChild(img);

    const meta=document.createElement("div"); meta.className="meta";
    const code=document.createElement("code"); code.textContent=item.url; meta.appendChild(code);

    const row=document.createElement("div"); row.className="row";
    const openBtn=mkBtn("Open",()=>chrome.tabs.create({url:item.url}));
    const copyUrlBtn=mkBtn("Copy URL", async ()=>{
      try{ await navigator.clipboard.writeText(item.url); toast("Copied URL"); }catch{ toast("Copy failed"); }
    });
    const copyImgBtn=mkBtn("Copy Image", async ()=>{ await copyImageAsPngToClipboard(item.url, copyImgBtn); });
    const dlBtn=mkBtn("Download", ()=>{ try{ chrome.downloads.download({url:item.url}); toast("Downloading…"); }catch{ toast("Download failed"); } });

    // Paste to Canvas button removed per your request

    row.append(openBtn, copyUrlBtn, copyImgBtn, dlBtn);
    card.append(controls, thumb, meta, row);
    listEl.appendChild(card);
  });
}

function mkBtn(text, onClick){ const b=document.createElement("button"); b.textContent=text; b.addEventListener("click", onClick); return b; }

// Convert any image to PNG first, then write to clipboard (most reliable)
async function copyImageAsPngToClipboard(url, btn){
  btn.disabled=true; const t=btn.textContent; btn.textContent="Copying…";
  try{
    const pngBlob = await toPngBlob(url);
    const item = new ClipboardItem({ "image/png": pngBlob });
    await navigator.clipboard.write([item]);
    toast("Image copied");
  }catch{ toast("Could not copy image"); }
  finally{ btn.disabled=false; btn.textContent=t; }
}

async function toPngBlob(url){
  const res = await fetch(url); const blob = await res.blob();
  if ("OffscreenCanvas" in window && "createImageBitmap" in window){
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d"); ctx.drawImage(bmp, 0, 0);
    return await canvas.convertToBlob({ type:"image/png" });
  }
  const objUrl = URL.createObjectURL(blob);
  try{
    const img = await new Promise((resolve,reject)=>{ const i=new Image(); i.onload=()=>resolve(i); i.onerror=reject; i.src=objUrl; });
    const c = document.createElement("canvas"); c.width=img.naturalWidth||img.width; c.height=img.naturalHeight||img.height;
    c.getContext("2d").drawImage(img,0,0);
    return await new Promise(r=>c.toBlob(r,"image/png"));
  } finally { URL.revokeObjectURL(objUrl); }
}

async function collectAllFrames(){
  const tab = await ensureCanvaTab(); if(!tab) return;
  state.tabId = tab.id;
  let results = [];
  try{
    const exec = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: frameCollector
    });
    for (const r of exec) if (Array.isArray(r.result)) results = results.concat(r.result);
  }catch{}

  // Filter to media-public.canva.com only + de-dup
  const seen=new Set();
  state.items = results.filter(it=>{
    const url = it.url || "";
    if (!url.startsWith(ALLOW_PREFIX)) return false;
    const key = url + "|" + (it.type || "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  render();

  if (!state.items.length){
    listEl.innerHTML = "<div style='padding:10px;color:#b00;'>No media-public.canva.com images found. Scroll the Canva page, then click Refresh.</div>";
  }
}

btnRefresh.addEventListener("click", collectAllFrames);
btnDownloadAll.addEventListener("click", ()=>{
  const urls = state.items.map(i=>i.url).filter(Boolean);
  if(!urls.length) return;
  chrome.runtime.sendMessage({ type:"downloadAll", urls });
  toast(`Downloading ${urls.length} image(s)…`);
});

document.addEventListener("DOMContentLoaded", collectAllFrames);
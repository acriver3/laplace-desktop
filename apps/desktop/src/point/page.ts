import type { StoredCapture } from "./captures";

export function snipPage(item: StoredCapture) {
	// All interpolated fields originate in the validated capture record; no source-page content.
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Laplace Point snip ${item.id}</title><link rel="stylesheet" href="./style.css"></head><body>
<header><div><strong>Laplace Point</strong><span>Screenshot · ${item.width} × ${item.height}</span></div><button id="annotate" disabled>Annotate this snip</button></header>
<main oai-annotation-container><img id="snip" src="./image.png" alt="Laplace Point snip ${item.id}" oai-annotatable="Laplace Point screenshot" data-capture-id="${item.id}" data-captured-at="${item.createdAt}" data-width="${item.width}" data-height="${item.height}"></main>
<footer id="status" role="status">Loading screenshot…</footer><script src="./page.js"></script></body></html>`;
}
export const pageStyle = `:root{color-scheme:light dark;font:14px system-ui}*{box-sizing:border-box}body{margin:0;height:100vh;display:flex;flex-direction:column;background:#17191c;color:#f5f5f5}header{display:flex;justify-content:space-between;align-items:center;padding:14px 20px;gap:12px}strong{font-size:16px}header span{margin-left:16px;color:#a7adb7}button{border:1px solid #666;border-radius:8px;padding:9px 14px;background:#f5f5f5;color:#111;font:inherit;cursor:pointer}button:disabled{opacity:.5;cursor:default}main{flex:1;min-height:0;display:flex;justify-content:center;align-items:center;padding:12px 20px}img{display:block;max-width:100%;max-height:100%;object-fit:contain;width:auto;height:auto}footer{padding:10px 20px;color:#a7adb7;font-size:12px}`;
export const pageScript = `"use strict";
const image = document.getElementById("snip");
const button = document.getElementById("annotate");
const status = document.getElementById("status");
const report = (state) => fetch("./status", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({state}) }).catch(() => {});
const ready = () => {
 const api = document.oai?.annotation;
 const supported = typeof api?.request === "function";
 button.disabled = !supported;
 status.textContent = supported ? "A screenshot of another application, not this page’s DOM. Your comment stays in the chat draft until you send it." : "Native annotations are unavailable. Point will attach this screenshot to your draft.";
 report(supported ? "ready" : "unsupported");
};
image.addEventListener("load", ready, {once:true});
image.addEventListener("error", () => { status.textContent = "This snip is no longer available."; report("failed"); }, {once:true});
if (image.complete && image.naturalWidth) ready();
button.addEventListener("click", () => {
 const api = document.oai?.annotation;
 if (typeof api?.request !== "function") { report("unsupported"); return; }
 const result = api.request(image, { mode:"default", metadata:{source:"desktop-screenshot", captureId:image.dataset.captureId, capturedAt:image.dataset.capturedAt, width:Number(image.dataset.width), height:Number(image.dataset.height)} });
 status.textContent = result?.accepted ? "Type your comment in Codex’s popup. On Windows, Ctrl+Enter adds it to the draft. If prompted, allow this page to start annotation mode." : "Codex could not open the annotation. Point will keep your snip available.";
 report(result?.accepted ? "requested" : "declined");
});`;

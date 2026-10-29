// Display artwork library. Timing/capture/model modules never import this module.
import { readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createTemplate, listTemplates, addAsset, snapshot, restore, deleteTemplate } from '../scoreboard/templates.js';
import { libraryRoot, containedPath, validateName } from '../scoreboard/paths.js';
import { runScoreboardAgent, AGENT_PRESETS } from '../scoreboard/agent.js';
export { AGENT_PRESETS };
const active = new Set();
const wrapper = '<!doctype html><meta charset="utf-8"><title>OpenMeet billboard</title><style>html,body{margin:0;background:transparent}img{width:100%;height:100vh;object-fit:contain}</style><img src="assets/billboard.svg" alt="Billboard artwork"><script src="/scoreboard/runtime.js"></script>';
const starter = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="240" viewBox="0 0 1200 240"><rect width="1200" height="240" rx="20" fill="#102c48"/><text x="600" y="150" font-family="sans-serif" font-size="84" font-weight="bold" text-anchor="middle" fill="white">OpenMeet</text></svg>';
const MAX_BYTES = 8 * 1024 * 1024;

// SVG is decoded as an image, never inserted into the app DOM or run as HTML.
// This validation enforces self-contained artwork; it is not a general XML parser.
export function validateBillboardSvg(svg) {
  if (Buffer.byteLength(svg) > MAX_BYTES || !/^\s*(?:<\?xml[^>]*>\s*)?<svg\b[^>]*>[\s\S]*<\/svg>\s*$/i.test(svg)) throw Error('Expected a complete SVG billboard (up to 8 MiB)');
  if (/<!|<\s*(?:script|foreignObject|iframe|object|embed|audio|video)\b|\bon[a-z]+\s*=|@import|\\/i.test(svg)) throw Error('Billboard must be a self-contained SVG image');
  for (const match of svg.matchAll(/(?:[\w-]+:)?href\s*=\s*(["'])(.*?)\1/gi)) {
    if (!/^(?:#[a-z0-9_-]+|data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+)$/i.test(match[2])) throw Error('Embed local logos as raster data images; external SVG links are not supported');
  }
  for (const match of svg.matchAll(/url\s*\((.*?)\)/gi)) if (!/^\s*["']?#[a-z0-9_-]+["']?\s*$/i.test(match[1])) throw Error('External SVG resources are not supported');
  if (/https?:|file:|omfile:|&(?:#|[a-z])/i.test(svg.replace(/&(?:amp|lt|gt|quot|apos);/g,'').replace(/xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/g, ''))) throw Error('External URLs and XML entities are not supported');
  return svg;
}
async function directory(root, name) { return containedPath(await libraryRoot(root), validateName(name)); }
async function validate(root, name) {
  const dir = await directory(root, name);
  if (await readFile(await containedPath(dir, 'index.html'), 'utf8') !== wrapper) throw Error('Preserve the billboard index wrapper');
  return validateBillboardSvg(await readFile(await containedPath(dir, 'assets/billboard.svg'), 'utf8'));
}
function idle(root, name) { if (active.has(path.resolve(root, name))) throw Error('This billboard is being built'); }
export async function createBillboard(root, name, { from } = {}) {
  await createTemplate(root, name, { from: from || 'builtin:classic' });
  try {
    const dir = await directory(root, name);
    if (!from) {
      await writeFile(path.join(dir, 'index.html'), wrapper);
      await writeFile(path.join(dir, 'assets/billboard.svg'), starter);
      await writeFile(path.join(dir, 'template.json'), JSON.stringify({name, description:'Line-scan display artwork', size:{w:1200,h:240}}));
    }
    await validate(root, name);
    return (await listTemplates(root)).find(item => item.name === name);
  } catch (error) { await deleteTemplate(root, name); throw error; }
}
export const listBillboards = root => listTemplates(root);
export async function readBillboard(root, name, asset = 'assets/billboard.svg') {
  if (!/^assets\/[a-zA-Z0-9._-]+\.(svg|png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(asset)) throw Error('Invalid billboard image path');
  const dir = await directory(root, name), file = await containedPath(dir, asset);
  const bytes = await readFile(file);
  if (bytes.length > MAX_BYTES) throw Error('Billboard image exceeds 8 MiB');
  const ext = path.extname(asset).slice(1).toLowerCase();
  if (ext === 'svg') validateBillboardSvg(bytes.toString('utf8'));
  const mime = {svg:'svg+xml',jpg:'jpeg',ico:'x-icon'}[ext] || ext;
  return {name, asset, dataUrl:`data:image/${mime};base64,${bytes.toString('base64')}`};
}
export async function addBillboardAsset(root, name, source) { idle(root,name); return addAsset(root,name,source); }
export async function restoreBillboard(root, name, id) { idle(root,name); return restore(root,name,id); }
export async function deleteBillboard(root, name) { idle(root,name); return deleteTemplate(root,name); }
export async function importBillboardSvg(root, name, source) {
  idle(root,name);
  const st=await lstat(source);
  if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_BYTES||path.extname(source).toLowerCase()!=='.svg')throw Error('Choose a local SVG image up to 8 MiB');
  const svg=validateBillboardSvg(await readFile(source,'utf8')),dir=await directory(root,name),snapshotId=await snapshot(root,name);
  try {await writeFile(await containedPath(dir,'assets/billboard.svg'),svg);}
  catch(error){await restore(root,name,snapshotId);throw error;}
  return {name,snapshotId,restored:false};
}
export async function runBillboardAgent({root,name,request,agent,onOutput=()=>{},signal}) {
  validateName(name);
  if (typeof request !== 'string' || !request.trim()) throw Error('Describe the billboard to build');
  idle(root,name);
  const key=path.resolve(root,name); active.add(key);
  try {
    await validate(root,name);
    // Reuse the existing spawn/approval policy, line streaming, abort handling and
    // index-contract rollback. A second check recovers invalid billboard assets.
    const result=await runScoreboardAgent({root,name,agent,onOutput,signal,request:`This template is a STATIC LINE-SCAN BILLBOARD asset, not a live results board.
Operator design request: ${request}
Edit ONLY assets/billboard.svg. Preserve index.html exactly, including its runtime script.
Create one complete, self-contained SVG with xmlns and viewBox, width and height.
Use SVG shapes and text. Inline any local logos as base64 PNG/JPEG/GIF/WebP images.
No script, event handlers, foreignObject, external resources, XML entities or animation.
The console decodes assets/billboard.svg as an image and masks runners in front of it.
Design ONE repeat tile. It repeats horizontally through the entire line-scan like a virtual LED panel. Prefer a 1200 by 160 viewBox; keep lettering and logos readable in a shallow band.
No timing, capture, meet or model input files are available to edit here.`});
    if (!result.restored) {
      try { await validate(root,name); }
      catch (error) {
        await restore(root,name,result.snapshotId);
        result.restored=true;result.error=`Billboard validation failed; snapshot restored: ${error.message}`;
        try { onOutput({stream:'stderr',line:result.error}); } catch {}
      }
    }
    return result;
  } finally { active.delete(key); }
}

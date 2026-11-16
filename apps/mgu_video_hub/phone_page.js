'use strict';

module.exports = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MGU Video Hub</title><style>
*{box-sizing:border-box}body{margin:0;background:#08121e;color:#ecf4ff;font:16px -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
main{max-width:720px;margin:auto;padding:26px 18px 90px}header{display:flex;align-items:center;gap:14px;margin-bottom:22px}
.logo{display:grid;place-items:center;width:53px;height:53px;border-radius:16px;background:#183e55;color:#72d9ff;font-size:30px}
h1{font-size:26px;margin:0}small,.sub{color:#91a9be}h2{font-size:19px;margin:0 0 14px}.sub{line-height:1.5;margin:10px 0 0}
section{border:1px solid #243849;background:#132538;border-radius:19px;padding:22px;margin:16px 0}
input,button{font:inherit;border-radius:11px;padding:14px;width:100%}input{background:#081a2a;border:1px solid #38536a;color:white;min-width:0}
button{border:0;background:#56bfe8;color:#06131d;font-weight:750;margin-top:10px;cursor:pointer}
button:disabled{opacity:.6}.ghost{background:#213a50;color:#c9e1f4}
#toast{position:sticky;top:10px;z-index:2;border-radius:13px;padding:13px 16px;margin-bottom:6px;background:#17402f;color:#b7f1d7}
#toast.bad{background:#4a2428;color:#ffc4bc}#toast:empty{display:none}
progress{width:100%;height:10px;margin-top:12px;accent-color:#66d9ff}
ul{list-style:none;margin:0;padding:0}li{display:flex;align-items:center;gap:12px;padding:11px 0;border-top:1px solid #243849}
li:first-child{border-top:0}li div{flex:1;min-width:0}li b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
li button{width:auto;margin:0;padding:9px 14px;background:#3a2a31;color:#ffc4bc;font-weight:600}
.meter{height:8px;border-radius:4px;background:#081a2a;overflow:hidden;margin-top:14px}.meter i{display:block;height:100%;background:#56bfe8}
.empty{color:#91a9be;padding:4px 0}
</style></head><body><main>
<header><div class="logo">&#9654;</div><div><h1>MGU Video Hub</h1><small>Phone companion &middot; local network</small></div></header>
<div id="toast" role="status"></div>
<section><h2>Import a video</h2><input id="video" type="file" accept="video/mp4,video/x-m4v,video/quicktime,video/x-matroska,video/webm,video/x-msvideo,.mp4,.m4v,.mov,.mkv,.webm,.avi">
<button id="upload">Upload to car</button><progress id="progress" value="0" max="100" hidden></progress>
<p class="sub">Up to 256 MB per file. For long films use a USB drive: it is played directly.</p></section>
<section><h2>YouTube link</h2><input id="link" type="url" inputmode="url" placeholder="https://www.youtube.com/watch?v=..." autocomplete="off">
<button id="add">Send link to car</button><p class="sub">Playback needs the MGU Store Internet uplink plus ffmpeg and yt-dlp on the head unit. Nothing is downloaded to the car.</p></section>
<section><h2>On the car</h2><ul id="files"></ul><div class="meter"><i id="used" style="width:0"></i></div><p class="sub" id="quota"></p></section>
<section><h2>Saved YouTube links</h2><ul id="links"></ul></section>
<section><h2>Diagnostics</h2><p class="sub" style="margin:0 0 4px">The diagnostic JSON has timestamps, player errors, tool availability and uplink state. Pairing tokens and stream URLs are left out.</p>
<button id="download" class="ghost">Download diagnostic JSON</button></section>
<script>
const token=new URLSearchParams(location.search).get('t');
const el=id=>document.getElementById(id);
let toastTimer=0;
function say(text,bad){const t=el('toast');t.textContent=text;t.className=bad?'bad':'';clearTimeout(toastTimer);if(!bad)toastTimer=setTimeout(()=>{t.textContent=''},6000)}
function api(name){return name+'?t='+encodeURIComponent(token)}
function mb(n){return n>=1048576?(n/1048576).toFixed(n>=104857600?0:1)+' MB':Math.max(1,Math.round(n/1024))+' KB'}
function clock(s){s=Math.floor(s);const h=Math.floor(s/3600),m=Math.floor(s%3600/60),z=n=>String(n).padStart(2,'0');return(h?h+':'+z(m):m)+':'+z(s%60)}
async function call(path,body){const r=await fetch(api(path),body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
let j={};try{j=await r.json()}catch(_){}if(!r.ok)throw Error(j.error||('HTTP '+r.status));return j}
function row(list,title,detail,onDelete){const li=document.createElement('li'),d=document.createElement('div'),b=document.createElement('b'),s=document.createElement('small'),x=document.createElement('button');
b.textContent=title;s.textContent=detail;d.appendChild(b);d.appendChild(s);x.textContent='Delete';x.onclick=async()=>{if(!confirm('Delete "'+title+'" from the car?'))return;x.disabled=true;
try{await onDelete();say('Deleted: '+title);refresh()}catch(e){say(e.message,true);x.disabled=false}};li.appendChild(d);li.appendChild(x);list.appendChild(li)}
function empty(list,text){const li=document.createElement('li');li.className='empty';li.textContent=text;list.appendChild(li)}
async function refresh(){try{const j=await call('/library');const f=el('files'),l=el('links');f.textContent='';l.textContent='';
if(!j.files.length)empty(f,'No uploaded videos yet.');
j.files.forEach(v=>row(f,v.name,mb(v.size),()=>call('/delete',{kind:'file',name:v.name})));
if(!j.links.length)empty(l,'No links yet.');
j.links.forEach(v=>row(l,v.title||('Video '+v.id),(v.duration?clock(v.duration)+' \\u00b7 ':'')+'youtu.be/'+v.id,()=>call('/delete',{kind:'link',id:v.id})));
el('used').style.width=Math.min(100,100*j.usedBytes/j.quotaBytes)+'%';
el('quota').textContent=mb(j.usedBytes)+' of '+mb(j.quotaBytes)+' used by uploads. USB media is not listed here.'}
catch(e){say(e.message==='Failed to fetch'?'The car is not reachable. Stay on the car\\'s Wi-Fi and keep Video Hub open.':e.message,true)}}
async function sendLink(){const url=el('link').value.trim();if(!url)return say('Paste a YouTube link first',true);el('add').disabled=true;
try{await call('/youtube',{url});say('Link sent to the car');el('link').value='';refresh()}catch(e){say(e.message,true)}finally{el('add').disabled=false}}
function upload(){const file=el('video').files[0];if(!file)return say('Choose a video first',true);
if(file.size>256*1024*1024)return say('This file is larger than 256 MB. Use a USB drive instead.',true);
const p=el('progress'),x=new XMLHttpRequest(),done=()=>{el('upload').disabled=false;p.hidden=true};p.hidden=false;p.value=0;el('upload').disabled=true;
x.open('POST',api('/upload'));x.setRequestHeader('X-Filename',encodeURIComponent(file.name));
x.upload.onprogress=e=>{if(e.lengthComputable)p.value=Math.floor(100*e.loaded/e.total)};
x.onload=()=>{done();try{const j=JSON.parse(x.responseText);if(x.status!==201)throw Error(j.error);say('Imported: '+j.name);el('video').value='';refresh()}catch(e){say(e.message||'Upload failed',true)}};
x.onerror=()=>{done();say('Connection to the car was lost during the upload',true)};x.send(file)}
el('add').onclick=sendLink;el('upload').onclick=upload;
el('link').onkeydown=e=>{if(e.key==='Enter')sendLink()};
el('download').onclick=()=>{location.assign(api('/diagnostics.json'))};
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()});refresh();
</script></main></body></html>`;

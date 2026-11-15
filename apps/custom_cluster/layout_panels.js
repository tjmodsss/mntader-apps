'use strict';
/*
 * Bounded side-instrument artwork for stationary tests. These are original
 * recreations, not BMW resources or native KOMBI palette edits.
 * Each layout uses at most six layers, with at most two 256-square static
 * textures and two small changing numeric textures. The centre stays free.
 */
const SIZE=256, DRAW=320, READ_W=128, READ_H=56;
const SIDES=[{key:'speed',x:88,y:190,max:260,unit:'km/h'},
    {key:'rpm',x:1512,y:190,max:6000,unit:'x1000 rpm'}];
const NAMES={oem:'G21 RECREATION',g80:'G80 INSPIRED',sport:'M SPORT',classic:'CLASSIC',minimal:'MINIMAL'};
const DOT_FS=`#version 100
precision mediump float;
varying vec2 v_uv;
uniform vec4 u_color;
void main(){
  float a=1.0-smoothstep(0.36,0.48,length(v_uv-vec2(0.5)));
  gl_FragColor=vec4(u_color.rgb,a);
}`;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const valid=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const valueOf=(side,data)=>valid(data[side.key])?data[side.key]:null;
const radial=f=>{const a=(-145+290*f)*Math.PI/180;return [128+Math.sin(a)*98,128-Math.cos(a)*98];};
const PATHS={
 oem:[[182,220],[91,202],[42,161],[28,105],[67,55],[132,23],[225,13]],
 g80:[[182,218],[87,211],[37,149],[28,74],[84,29],[205,29]],
 sport:[[28,68],[228,68]]
};
function mirror(p,side){return side.key==='rpm'?[SIZE-p[0],p[1]]:p.slice();}
function point(layout,side,f) {
    f=clamp(f,0,1);
    if(layout==='classic') return radial(f);
    const ps=PATHS[layout];
    if(!ps)return null;
    const t=f*(ps.length-1),i=Math.min(ps.length-2,Math.floor(t)),a=ps[i],b=ps[i+1],k=t-i;
    return mirror([a[0]+(b[0]-a[0])*k,a[1]+(b[1]-a[1])*k],side);
}
function label(side,n){return side.key==='speed'?String(Math.round(n)):String(Math.round(n/1000));}
function ticks(layout,side){
    if(side.key==='rpm')return [0,1000,2000,3000,4000,5000,6000];
    if(layout==='oem')return [0,20,40,60,100,140,200,260];
    return [0,40,80,120,160,200,240,260];
}
// Approximate positions of the G21 labels as seen on the supplied photo.
// Piecewise interpolation keeps the marker consistent with our own labels.
function fraction(layout,side,v){
    if(layout!=='oem'||side.key!=='speed')return clamp(v/side.max,0,1);
    const a=ticks(layout,side);
    v=clamp(v,0,side.max);
    let i=0;while(i<a.length-2&&v>a[i+1])i++;
    return (i+(v-a[i])/(a[i+1]-a[i]))/(a.length-1);
}
function face(layout,side,accent,Canvas){
    if(!NAMES[layout])throw Error('Unsupported layout '+layout);
    const cv=new Canvas(SIZE,SIZE).clear([0,0,0,0]);
    const white='#e7edf5',dim='#8696a7',bg=layout==='classic'?'#141510':'#0a1018';
    // Bound artwork to side regions. These dark backgrounds deliberately
    // cover only our own panel rectangles; actual OEM composition is unknown.
    if(layout==='classic'){
        cv.circle(128,128,122,bg);
        cv.arc(128,128,117,121,-145,145,'#49505a');
        cv.arc(128,128,112,115,-145,145,accent);
        cv.arc(128,128,76,78,-145,145,'#343b42');
        for(let i=0;i<=26;i++){
            const a=(-145+290*i/26)*Math.PI/180;
            const major=i%Math.round(side.key==='speed'?4:26/6)===0||i===26;
            const x=Math.sin(a),y=-Math.cos(a);
            cv.line(128+x*(major?98:105),128+y*(major?98:105),128+x*110,128+y*110,major?2:1,major?accent:dim);
        }
        ticks(layout,side).forEach(v=>{
            const a=(-145+290*fraction(layout,side,v))*Math.PI/180;
            cv.text(label(side,v),128+Math.sin(a)*83,128-Math.cos(a)*83+4,14,white,{align:'center',literal:true});
        });
    }else if(layout==='oem'||layout==='g80'){
        cv.fillRect(6,6,244,236,bg);
        const ps=PATHS[layout].map(p=>mirror(p,side));
        for(let i=1;i<ps.length;i++){
            const a=ps[i-1],b=ps[i];
            cv.line(a[0],a[1],b[0],b[1],layout==='oem'?12:17,'#273340');
            cv.line(a[0],a[1],b[0],b[1],layout==='oem'?7:10,accent);
            cv.line(a[0],a[1]-5,b[0],b[1]-5,1.5,white);
        }
        // Approximate G21 angular shape; never claim an exact OEM geometry.
        ticks(layout,side).forEach(v=>{
            const p=point(layout,side,fraction(layout,side,v));
            const inward=side.key==='speed'?20:-20;
            cv.line(p[0],p[1],p[0]+inward*.45,p[1]+9,1.8,white);
            cv.text(label(side,v),clamp(p[0]+inward,16,240),clamp(p[1]+19,18,232),14,white,{align:'center',literal:true});
        });
    }else if(layout==='sport'){
        cv.fillRect(10,30,236,204,bg);
        for(let i=0;i<12;i++)cv.fillRect(28+i*17,61,13,16,i%3===0?accent:'#354251');
        cv.line(28,92,228,92,2,accent);
        cv.text(side.key==='rpm'?'RPM':'SPEED',128,124,22,white,{align:'center',literal:true});
    }else{
        cv.fillRect(15,100,226,121,bg);
        cv.line(28,108,228,108,3,accent);
        cv.text(side.key==='rpm'?'ENGINE':'SPEED',128,137,19,dim,{align:'center',literal:true});
    }
    cv.text(NAMES[layout]+' / TEST',128,251,11,'#e4bd7a',{align:'center',literal:true});
    return cv;
}
function readout(side,data,accent,Canvas){
    const cv=new Canvas(READ_W,READ_H).clear('#0a1018');
    const v=valueOf(side,data);
    const str=v===null?'--':side.key==='speed'?String(Math.round(v)):(v/1000).toFixed(1);
    cv.text(str,64,29,29,'#f1f5fa',{align:'center',font:'num',literal:true});
    cv.text(side.unit,64,46,12,'#aab7c5',{align:'center',literal:true});
    cv.fillRect(15,51,98,2,'#394651');
    if(v!==null)cv.fillRect(15,51,Math.round(98*clamp(v/side.max,0,1)),2,accent);
    return cv;
}
function valueKey(side,data){
    const v=valueOf(side,data);if(v===null)throw Error('Invalid live '+side.key);
    return [side.key==='speed'?Math.round(v):Math.round(v/100),Math.round(100*clamp(v/side.max,0,1))].join(':');
}
function markerRect(layout,side,v){
    const p=point(layout,side,fraction(layout,side,v));
    return p?{x:side.x+Math.round(p[0]*DRAW/SIZE)-6,
        y:side.y+Math.round(p[1]*DRAW/SIZE)-6,w:12,h:12}:null;
}
function buildLayout(cr,target,data,options,accent,accentHex,track,CanvasOverride){
    const Canvas=CanvasOverride||require('./kit/canvas').Canvas, layout=options.layout;
    if(!NAMES[layout])throw Error('Unsupported panel layout '+layout);
    const parts=[];
    SIDES.forEach((side,i)=>{
        const common={target,klass:'overlay',contend:false,guide_hold:false,visible:false};
        const img=face(layout,side,accentHex,Canvas);
        const ref=cr.image(Object.assign({},common,{x:side.x,y:side.y,w:DRAW,h:DRAW,z:i*3,iw:SIZE,ih:SIZE,sampling:'bilinear'}));
        if(!ref)throw Error(layout+' face refused');track(ref);
        if(!cr.pixels(ref,null,Buffer.from(img.d)))throw Error(layout+' face pixels refused');
        const read=cr.image(Object.assign({},common,{x:side.x+80,y:side.y+154,w:160,h:70,z:i*3+1,iw:READ_W,ih:READ_H,sampling:'bilinear'}));
        if(!read)throw Error(layout+' readout refused');track(read);
        if(!cr.pixels(read,null,Buffer.from(readout(side,data,accentHex,Canvas).d)))throw Error(layout+' readout pixels refused');
        const v=valueOf(side,data);if(v===null)throw Error('Invalid live '+side.key);
        let marker=0;
        const rect=markerRect(layout,side,v);
        if(rect){
            marker=cr.effect(Object.assign({},common,rect,{z:i*3+2,fs:DOT_FS}));
            if(!marker)throw Error(layout+' marker refused');
            track(marker);cr.uniform(marker,'u_color',accent);
        }
        parts.push({side,layout,read,marker,last:valueKey(side,data),lastValue:v,lastColor:accentHex,Canvas});
    });
    return parts;
}
function updateLayout(cr,parts,data,accent,accentHex){
    parts.forEach(p=>{
        const v=valueOf(p.side,data);if(v===null)throw Error('Invalid live '+p.side.key);
        const k=valueKey(p.side,data);
        if(k!==p.last||accentHex!==p.lastColor){
            if(!cr.pixels(p.read,null,Buffer.from(readout(p.side,data,accentHex,p.Canvas).d)))throw Error('readout update refused');
            p.last=k;
        }
        if(p.marker){
            if(v!==p.lastValue)cr.set(p.marker,markerRect(p.layout,p.side,v));
            if(accentHex!==p.lastColor)cr.uniform(p.marker,'u_color',accent);
        }
        p.lastValue=v;p.lastColor=accentHex;
    });
}
// Preview uses the same side artwork and readout, not an independent mockup.
let previewCache=null;
function drawLayoutPreview(cv,box,data,options,accentHex,CanvasOverride){
    const Canvas=CanvasOverride||require('./kit/canvas').Canvas;
    const size=Math.min(box.h-64,box.w*.28), cy=box.y+box.h*.53;
    cv.roundRect(box.x,box.y,box.w,box.h,16,'#0a1018');
    cv.text(NAMES[options.layout]+' / HMI PREVIEW',box.x+25,box.y+34,20,'#c0cbd6',{literal:true});
    const cacheKey=options.layout+'|'+accentHex;
    if(!previewCache||previewCache.key!==cacheKey||previewCache.Canvas!==Canvas)
        previewCache={key:cacheKey,Canvas,faces:SIDES.map(side=>face(options.layout,side,accentHex,Canvas))};
    SIDES.forEach((side,i)=>{
        const cx=box.x+box.w*(i===0?.20:.80),x=Math.round(cx-size/2),y=Math.round(cy-size/2);
        const f=previewCache.faces[i];
        cv.drawImage(f.d,SIZE,SIZE,x,y,size,size);
        const r=readout(side,data,accentHex,Canvas);
        cv.drawImage(r.d,READ_W,READ_H,x+size*.25,y+size*154/320,size*.5,size*70/320);
        const v=valueOf(side,data);
        if(v!==null){
            const p=point(options.layout,side,fraction(options.layout,side,v));
            if(p)cv.circle(x+size*p[0]/SIZE,y+size*p[1]/SIZE,4,accentHex);
        }
    });
    const mx=box.x+box.w/2, mw=box.w*.25;
    cv.roundRect(mx-mw/2,cy-size*.40,mw,size*.80,8,'#12263a');
    cv.text('BMW / WAZE',mx,cy,22,'#dce7f0',{align:'center',literal:true});
    cv.text('MAP WINDOW',mx,cy+27,16,'#8cabc5',{align:'center',literal:true});
}
module.exports={buildLayout,updateLayout,drawLayoutPreview,face,readout,point,markerRect,NAMES,SIDES,SIZE,DRAW,ticks,fraction};

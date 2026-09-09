const MODEL_URL='https://huggingface.co/peterhdd/pothole-detection-yolov8/resolve/main/best.onnx?download=true';
const ORT_WASM='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
const INPUT=640, CONF=.30, IOU=.45, DETECT_EVERY=500;
let session=null,running=false,stream=null,gpsWatch=null,timer=null,startedAt=null,finishedAt=null,lastInfer=0;
let tracks=[],nextId=1,events=[],route=[],lastGps=null,routeLine=null,startMarker=null,finishMarker=null;
const $=id=>document.getElementById(id);
const video=$('video'),overlay=$('overlay'),octx=overlay.getContext('2d');
function setStatus(t){$('aiStatus').textContent=t}
function fmtTime(d){return d?new Date(d).toLocaleString():'—'}
function fmtDur(ms){let s=Math.floor(ms/1000),m=Math.floor(s/60);s%=60;return String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')}
function initMap(){try{if(typeof L==='undefined')return;const map=L.map('map').setView([27.7172,85.324],13);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors'}).addTo(map);routeLine=L.polyline([],{weight:5}).addTo(map);window.roadMap=map}catch(e){console.warn('Map unavailable',e)}}
async function loadModel(){
  if(session)return true;
  try{
    if(typeof ort==='undefined')throw new Error('ONNX Runtime Web did not load from the CDN. Check your internet connection or browser extensions.');
    ort.env.wasm.wasmPaths=ORT_WASM;
    ort.env.wasm.numThreads=1;
    ort.env.wasm.proxy=false;
    ort.env.logLevel='warning';
    setStatus('Downloading AI model (45 MB)…');
    $('aiStatusDot').style.background='#ffc857';
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),90000);
    let response;
    try{response=await fetch(MODEL_URL,{mode:'cors',cache:'force-cache',signal:controller.signal});}
    finally{clearTimeout(timeout)}
    if(!response.ok)throw new Error(`Model download failed: HTTP ${response.status}`);
    const contentLength=Number(response.headers.get('content-length')||0);
    if(contentLength&&contentLength<1000000)throw new Error('Downloaded model is unexpectedly small; the model URL returned the wrong file.');
    const bytes=await response.arrayBuffer();
    if(bytes.byteLength<1000000)throw new Error(`Model download was only ${(bytes.byteLength/1024/1024).toFixed(1)} MB.`);
    setStatus('Starting AI engine…');
    session=await ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
    if(!session.inputNames?.length||!session.outputNames?.length)throw new Error('ONNX model loaded but has no input/output tensors.');
    console.log('RoadScan model loaded',session.inputNames,session.outputNames);
    setStatus('AI ready');$('aiStatusDot').style.background='var(--accent)';return true;
  }catch(e){
    session=null;console.error('RoadScan AI model load failed:',e);
    const msg=e?.name==='AbortError'?'Model download timed out after 90 seconds.':(e?.message||String(e));
    setStatus('AI model failed — camera still available');$('aiStatusDot').style.background='#ff6262';
    $('reportSummary').textContent='AI could not load. Camera/video is still available. Error: '+msg;
    return false;
  }
}
function letterbox(){const c=document.createElement('canvas');c.width=INPUT;c.height=INPUT;const x=c.getContext('2d'),scale=Math.min(INPUT/video.videoWidth,INPUT/video.videoHeight),w=Math.round(video.videoWidth*scale),h=Math.round(video.videoHeight*scale),dx=(INPUT-w)/2,dy=(INPUT-h)/2;x.fillStyle='#000';x.fillRect(0,0,INPUT,INPUT);x.drawImage(video,dx,dy,w,h);return{canvas:c,scale,dx,dy}}
function tensor(c){const d=c.getContext('2d').getImageData(0,0,INPUT,INPUT).data,a=new Float32Array(3*INPUT*INPUT),n=INPUT*INPUT;for(let i=0,p=0;i<d.length;i+=4,p++){a[p]=d[i]/255;a[n+p]=d[i+1]/255;a[2*n+p]=d[i+2]/255}return new ort.Tensor('float32',a,[1,3,INPUT,INPUT])}
function iou(a,b){const x=Math.max(a[0],b[0]),y=Math.max(a[1],b[1]),r=Math.min(a[2],b[2]),z=Math.min(a[3],b[3]),inter=Math.max(0,r-x)*Math.max(0,z-y),aa=(a[2]-a[0])*(a[3]-a[1]),ab=(b[2]-b[0])*(b[3]-b[1]);return inter/(aa+ab-inter+1e-9)}
function nms(ds){ds.sort((a,b)=>b.conf-a.conf);const out=[];while(ds.length){const x=ds.shift();out.push(x);for(let i=ds.length-1;i>=0;i--)if(iou(x.box,ds[i].box)>IOU)ds.splice(i,1)}return out}
function decode(out,lb,w,h){const d=out.data,di=out.dims,c=di[di.length-2],n=di[di.length-1],trans=c<n,attrs=trans?c:n,count=trans?n:c,get=(a,i)=>trans?d[a*count+i]:d[i*attrs+a],ds=[];for(let i=0;i<count;i++){const conf=get(4,i);if(conf<CONF)continue;const cx=get(0,i),cy=get(1,i),bw=get(2,i),bh=get(3,i);let x1=(cx-bw/2-lb.dx)/lb.scale,y1=(cy-bh/2-lb.dy)/lb.scale,x2=(cx+bw/2-lb.dx)/lb.scale,y2=(cy+bh/2-lb.dy)/lb.scale;x1=Math.max(0,Math.min(w,x1));y1=Math.max(0,Math.min(h,y1));x2=Math.max(0,Math.min(w,x2));y2=Math.max(0,Math.min(h,y2));if(x2>x1&&y2>y1)ds.push({box:[x1,y1,x2,y2],conf})}return nms(ds)}
function severity(b,w,h){const a=(b[2]-b[0])*(b[3]-b[1])/(w*h);return a>.065?'High':a>.025?'Medium':'Low'}
function evidence(b,w,h){const c=document.createElement('canvas'),pad=30,x=Math.max(0,b[0]-pad),y=Math.max(0,b[1]-pad),r=Math.min(w,b[2]+pad),z=Math.min(h,b[3]+pad);c.width=r-x;c.height=z-y;c.getContext('2d').drawImage(video,x,y,c.width,c.height,0,0,c.width,c.height);return c.toDataURL('image/jpeg',.82)}
function updateTracks(ds,w,h){const used=new Set(),next=[];for(const d of ds){let bi=-1,bs=.3;tracks.forEach((t,i)=>{if(!used.has(i)){const v=iou(t.box,d.box);if(v>bs){bs=v;bi=i}}});if(bi>=0){const t=tracks[bi];used.add(bi);t.box=d.box;t.conf=d.conf;t.missed=0;next.push(t)}else{const t={id:nextId++,box:d.box,conf:d.conf,missed:0};next.push(t);events.push({id:t.id,confidence:d.conf,severity:severity(d.box,w,h),time:new Date().toISOString(),gps:lastGps?{...lastGps}:null,image:evidence(d.box,w,h)})}}tracks.forEach((t,i)=>{if(!used.has(i)){t.missed++;if(t.missed<5)next.push(t)}});tracks=next;renderMetrics()}
function renderMetrics(){$('count').textContent=events.length;$('highCount').textContent=events.filter(e=>e.confidence>=.75).length;$('avgConfidence').textContent=events.length?Math.round(events.reduce((a,e)=>a+e.confidence,0)/events.length*100)+'%':'—'}
function draw(ds,w,h){const r=video.getBoundingClientRect(),sx=r.width/w,sy=r.height/h;overlay.width=Math.max(1,r.width*devicePixelRatio);overlay.height=Math.max(1,r.height*devicePixelRatio);octx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);octx.clearRect(0,0,r.width,r.height);ds.forEach(d=>{const s=severity(d.box,w,h),col=s==='High'?'#ff5c68':s==='Medium'?'#ffc857':'#39d98a';octx.strokeStyle=col;octx.lineWidth=3;octx.strokeRect(d.box[0]*sx,d.box[1]*sy,(d.box[2]-d.box[0])*sx,(d.box[3]-d.box[1])*sy);octx.fillStyle=col;octx.font='bold 13px system-ui';octx.fillText(`Pothole ${Math.round(d.conf*100)}% · ${s}`,d.box[0]*sx,Math.max(16,d.box[1]*sy-6))})}
async function loop(){if(!running)return;if(session&&video.readyState>=2&&performance.now()-lastInfer>=DETECT_EVERY){lastInfer=performance.now();try{const w=video.videoWidth,h=video.videoHeight,lb=letterbox(),out=await session.run({[session.inputNames[0]]:tensor(lb.canvas)}),ds=decode(out[session.outputNames[0]],lb,w,h);updateTracks(ds,w,h);draw(ds,w,h)}catch(e){console.error('Inference failed:',e);setStatus('AI inference error — check console')}}requestAnimationFrame(loop)}
function startGps(){if(!navigator.geolocation){$('gpsStatus').textContent='Not supported';return}$('gpsStatus').textContent='Requesting permission…';gpsWatch=navigator.geolocation.watchPosition(p=>{lastGps={lat:p.coords.latitude,lon:p.coords.longitude,accuracy:p.coords.accuracy};route.push([lastGps.lat,lastGps.lon]);$('gpsStatus').textContent='Live';$('lastLocation').textContent=`${lastGps.lat.toFixed(6)}, ${lastGps.lon.toFixed(6)}`;if(routeLine)routeLine.setLatLngs(route);if(route.length===1){if(window.roadMap)window.roadMap.setView(route[0],17);if(typeof L!=='undefined')startMarker=L.marker(route[0]).addTo(window.roadMap).bindPopup('Inspection start')}} ,e=>{$('gpsStatus').textContent=e.code===1?'Permission denied':'Location unavailable';console.warn('GPS',e)},{enableHighAccuracy:true,maximumAge:2000,timeout:10000})}
async function begin(mode){running=true;startedAt=new Date();finishedAt=null;events=[];tracks=[];nextId=1;route=[];lastGps=null;$('startTime').textContent=fmtTime(startedAt);$('finishTime').textContent='—';$('gpsStatus').textContent='Requesting permission…';$('lastLocation').textContent='—';$('modeBadge').textContent=mode==='camera'?'LIVE CAMERA':'VIDEO';$('stopBtn').disabled=false;$('cameraBtn').disabled=true;$('reportPanel').classList.add('hidden');$('videoPlaceholder').style.display='none';video.style.display='block';startGps();timer=setInterval(()=>$('elapsed').textContent=fmtDur(Date.now()-startedAt),500);requestAnimationFrame(loop);await loadModel()}
$('cameraBtn').onclick=async()=>{if(!navigator.mediaDevices?.getUserMedia){alert('Camera access is not supported in this browser. Use Chrome/Edge over HTTPS.');return}try{setStatus('Requesting camera permission…');stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});video.srcObject=stream;video.muted=true;video.playsInline=true;await video.play();await begin('camera')}catch(e){console.error(e);setStatus('Camera permission required');alert('Camera access was not granted. Please allow Camera for this site, then try again.')}};
$('videoInput').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;video.srcObject=null;video.src=URL.createObjectURL(f);video.onloadedmetadata=async()=>{try{await video.play();await begin('video')}catch(err){alert('Could not play this video: '+err.message)}}};
$('stopBtn').onclick=stopInspection;
function stopInspection(){if(!running)return;running=false;finishedAt=new Date();clearInterval(timer);if(gpsWatch!==null)navigator.geolocation.clearWatch(gpsWatch);if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}if(lastGps&&route.length&&typeof L!=='undefined'&&window.roadMap)finishMarker=L.marker(route[route.length-1]).addTo(window.roadMap).bindPopup('Inspection finish').openPopup();$('finishTime').textContent=fmtTime(finishedAt);$('stopBtn').disabled=true;$('cameraBtn').disabled=false;$('modeBadge').textContent='COMPLETE';$('reportPanel').classList.remove('hidden');$('reportSummary').textContent=`${events.length} unique pothole(s) detected. The report contains evidence images, severity, confidence, timestamps, GPS coordinates and route information.`;setStatus(session?'Inspection complete':'Inspection complete — AI was not loaded');video.pause()}
function makePdf(){if(!window.jspdf){alert('PDF library is still loading. Try again.');return}const {jsPDF}=window.jspdf,doc=new jsPDF({unit:'mm',format:'a4'});let y=18;doc.setFontSize(20);doc.text('RoadScan AI — Inspection Report',15,y);y+=8;doc.setFontSize(10);doc.text(`Started: ${fmtTime(startedAt)}`,15,y);y+=5;doc.text(`Finished: ${fmtTime(finishedAt)}`,15,y);y+=5;doc.text(`Duration: ${fmtDur(finishedAt-startedAt)} | Unique potholes: ${events.length}`,15,y);y+=10;events.forEach(e=>{if(y>245){doc.addPage();y=18}doc.setFontSize(12);doc.text(`#${e.id} — ${e.severity} severity`,15,y);y+=5;doc.setFontSize(9);doc.text(`AI confidence: ${Math.round(e.confidence*100)}%`,15,y);y+=5;doc.text(`Detected: ${new Date(e.time).toLocaleString()}`,15,y);y+=5;doc.text(e.gps?`Location: ${e.gps.lat.toFixed(6)}, ${e.gps.lon.toFixed(6)} (±${Math.round(e.gps.accuracy)} m)`:'Location: unavailable',15,y);y+=4;try{doc.addImage(e.image,'JPEG',15,y,75,50)}catch{}y+=58});if(y>255){doc.addPage();y=18}doc.setFontSize(13);doc.text('Route summary',15,y);y+=7;doc.setFontSize(9);doc.text(`Recorded GPS points: ${route.length}`,15,y);y+=5;if(route.length){doc.text(`Start: ${route[0][0].toFixed(6)}, ${route[0][1].toFixed(6)}`,15,y);y+=5;const end=route[route.length-1];doc.text(`Finish: ${end[0].toFixed(6)}, ${end[1].toFixed(6)}`,15,y);y+=7}doc.setFontSize(8);doc.text('Severity is a visual AI estimate based on apparent pothole size in the camera frame; it is not an engineering assessment.',15,y,{maxWidth:180});doc.save(`roadscan-inspection-${Date.now()}.pdf`)}
$('downloadReport').onclick=makePdf;window.addEventListener('beforeunload',()=>{if(stream)stream.getTracks().forEach(t=>t.stop())});initMap();
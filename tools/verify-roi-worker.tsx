import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Annotation, Series, Volume } from '../src/model';
import { roiStatistics, formatRoiStatistics } from '../src/imaging/annotations';
import { requestSourceRoi } from '../src/imaging/roiStatisticsService';
import { useAnnotationSummary } from '../src/imaging/useAnnotationSummary';
import { t } from '../src/i18n';

const side = 4096, pixels = new Int16Array(side * side);
for (let i = 0; i < pixels.length; i++) pixels[i] = i % 2048 - 1024;
const series: Series = { id:'roi-worker-proof',uid:'roi-worker-proof',studyUid:'test',patientId:'SYNTHETIC',patientName:'Mathematical field',studyDate:'',description:'ROI worker proof',modality:'CT',seriesNumber:1,
  dimensions:[side,side,1],spacing:[1,1,1],origin:[0,0,0],direction:[1,0,0,0,1,0,0,0,1],windowCenter:0,windowWidth:2048,valueUnit:'HU',suvFactor:null,canReconstruct:true,spacingKnown:true,
  warnings:[],photometricInterpretation:'MONOCHROME2',pixelType:'int16',components:1 };
const volume: Volume = { series, data: pixels };
const points: Annotation['points'] = [[-0.5,-0.5,0],[side-0.5,-0.5,0],[side-0.5,side-0.5,0],[-0.5,side-0.5,0]];
const annotations: Annotation[] = ['rectangle','ellipse'].map(type => ({id:`proof-${type}`,type:type as Annotation['type'],points,plane:'axial',slice:0,mode:'source',sourceFrame:0}));
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const hash = async () => [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels.buffer))].map(n => n.toString(16).padStart(2,'0')).join('');
let setShown: (annotation: Annotation | null) => void = () => {};
function Label({annotation,other=false}:{annotation:Annotation;other?:boolean}) {
  const summary=useAnnotationSummary(annotation,other?{...volume,series:{...series}}:volume);
  return <p data-summary>{summary}</p>;
}
function Labels(){const [annotation,setAnnotation]=useState<Annotation|null>(null);setShown=setAnnotation;return annotation?<><Label annotation={annotation}/><Label annotation={annotation} other/></>:null;}
createRoot(document.querySelector('#labels')!).render(<Labels/>);

async function measure<T>(fn:()=>T|Promise<T>) {
  const longTasks: {start:number;duration:number}[]=[], gaps:number[]=[];
  const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())longTasks.push({start:entry.startTime,duration:entry.duration});});
  observer.observe({type:'longtask',buffered:false});
  let previous=0, animation=0;
  const tick=(now:number)=>{if(previous)gaps.push(now-previous);previous=now;animation=requestAnimationFrame(tick);};
  animation=requestAnimationFrame(tick);await frame();await frame();
  const start=performance.now(), result=await fn(), calculationMs=performance.now()-start;
  await frame();await frame();await wait(20);cancelAnimationFrame(animation);observer.disconnect();
  return {result,calculationMs,maxLongTaskMs:Math.max(0,...longTasks.filter(task=>task.start+task.duration>=start).map(task=>task.duration)),longTaskCount:longTasks.filter(task=>task.start+task.duration>=start).length,maxRafGapMs:Math.max(0,...gaps)};
}

async function run(){
  const beforeHash=await hash();
  const originalSet=Uint8Array.prototype.set, originalSlice=Uint8Array.prototype.slice, originalPost=Worker.prototype.postMessage;
  const chunks:{bytes:number;milliseconds:number}[]=[], messages:string[]=[];
  let sourceTransferred=false;
  Uint8Array.prototype.set=function(source:ArrayLike<number>,offset?:number){
    const sourceView=source as Uint8Array;
    if(sourceView.buffer!==pixels.buffer)return originalSet.call(this,source,offset);
    const start=performance.now(),result=originalSet.call(this,source,offset);chunks.push({bytes:sourceView.byteLength,milliseconds:performance.now()-start});return result;
  };
  Uint8Array.prototype.slice=function(start?:number,end?:number){
    if(this.buffer!==pixels.buffer)return originalSlice.call(this,start,end);
    const began=performance.now(),result=originalSlice.call(this,start,end);chunks.push({bytes:result.byteLength,milliseconds:performance.now()-began});return result;
  };
  Worker.prototype.postMessage=function(message:unknown,options?:Transferable[]|StructuredSerializeOptions){
    const transfer=Array.isArray(options)?options:options?.transfer??[];
    sourceTransferred ||= transfer.includes(pixels.buffer);
    messages.push((message as {type?:string})?.type??'unknown');
    return originalPost.call(this,message,options as Transferable[]);
  };
  try{
    const profiles=[];
    let rectangleLabel='';
    for(const annotation of annotations){
      const before=await measure(()=>roiStatistics(annotation,volume));
      const startChunk=chunks.length;
      const after=await measure(()=>requestSourceRoi(annotation,volume).promise);
      if(!before.result||!after.result||JSON.stringify(before.result)!==JSON.stringify(after.result))throw new Error('Exact ROI result changed in the worker');
      if(annotation.type==='rectangle')rectangleLabel=formatRoiStatistics(before.result);
      profiles.push({type:annotation.type,sourceCount:after.result.count,resultIdentical:true,before:{...before,result:undefined},after:{...after,result:undefined},copies:chunks.slice(startChunk)});
    }
    const measuresBefore=messages.filter(type=>type==='measure').length;
    const shared={...annotations[0],id:'shared-overlay-and-list'};setShown(shared);await frame();await frame();
    const pending=[...document.querySelectorAll('[data-summary]')].every(element=>element.textContent===t('annotation.calculating'));
    const deadline=performance.now()+15000;
    while(performance.now()<deadline&&[...document.querySelectorAll('[data-summary]')].some(element=>element.textContent===t('annotation.calculating')))await wait(20);
    const labels=[...document.querySelectorAll('[data-summary]')].map(element=>element.textContent);
    const sharedCalculations=messages.filter(type=>type==='measure').length-measuresBefore;
    if(!pending||labels.length!==2||labels[0]!==rectangleLabel||labels[1]!==rectangleLabel||sharedCalculations!==1)throw new Error(`Shared summaries failed: ${JSON.stringify({pending,labels,sharedCalculations})}`);
    setShown(null);
    const afterHash=await hash();
    if(chunks.length!==8||chunks.reduce((sum,chunk)=>sum+chunk.bytes,0)!==pixels.byteLength)throw new Error('Source frame was not copied exactly once in8 bounded chunks');
    const report={passed:beforeHash===afterHash&&!sourceTransferred&&chunks.every(chunk=>chunk.bytes<=4*1024*1024),browser:navigator.userAgent,sourceBytes:pixels.byteLength,beforeHash,afterHash,sourceTransferred,
      maxCopyBlockMs:Math.max(0,...chunks.map(chunk=>chunk.milliseconds)),profiles,sharedSummaries:{pendingLabelVerified:pending,calculations:sharedCalculations,identicalLabels:labels[0]===labels[1]}};
    (window as unknown as {roiWorkerResult:unknown}).roiWorkerResult=report;
    document.querySelector('#result')!.textContent=JSON.stringify(report,null,2);return report;
  }finally{Uint8Array.prototype.set=originalSet;Uint8Array.prototype.slice=originalSlice;Worker.prototype.postMessage=originalPost;}
}
(window as unknown as {runRoiWorkerProof:typeof run}).runRoiWorkerProof=run;

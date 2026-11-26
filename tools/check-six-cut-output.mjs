import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const out='evidence/reports',mode=process.argv[2];await mkdir(out,{recursive:true});
const server=await createServer({server:{port:0,host:'127.0.0.1'}});await server.listen();
const browser=await chromium.launch({channel:'chrome'});
try{
  const page=await browser.newPage();
  await page.goto(new URL('tools/viewport-check.html',server.resolvedUrls.local[0]).href);
  const result=await page.evaluate(async()=>{
    const {drawReport}=await import('/src/ui/deformityReport.ts');
    const text=[],original=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText=function(label,x,y,...remaining){
      const at=new DOMPoint(x,y).matrixTransform(this.getTransform());text.push({label,x:at.x,y:at.y});
      return original.call(this,label,x,y,...remaining);
    };
    try{
      const rows=(n,key,caution)=>Array.from({length:n},(_,i)=>[key+' '+(i+1),'Synthetic value','',caution?'Confirm '+key+' '+(i+1):undefined]);
      const picture=document.createElement('canvas');picture.width=260;picture.height=700;
      const ctx=picture.getContext('2d');ctx.fillStyle='#333';ctx.fillRect(0,0,260,700);
      const content={title:'Synthetic report',lines:['Synthetic image','Two simulated views','1 mm per pixel'],pictures:[{caption:'Source fixture',canvas:picture},{caption:'Planning fixture',canvas:picture}],
        sections:[{title:'Measurements',rows:rows(13,'measurement',true)},{title:'Malalignment',rows:rows(5,'step',true)},{title:'CORA',rows:rows(2,'bone',true)},
          {title:'Osteotomy',rows:[...rows(12,'cut or wedge',false),['Length change','mm'],...rows(8,'comparison',true)]}],footer:['Simulation','Version']};
      const canvas=drawReport(content),last=text.find(x=>x.label==='Confirm comparison 8'),footer=text.find(x=>x.label==='Simulation');
      const cropTop=Math.floor(last.y-27),left=Math.floor(last.x);
      let ink=0;
      if(cropTop+28<=canvas.height){
        const {data}=canvas.getContext('2d').getImageData(left,cropTop,520,28);
        for(let i=0;i<data.length;i+=4)if(data[i]>data[i+1]+15&&data[i+1]>data[i+2]+10)ink++;
      }
      return {width:canvas.width,height:canvas.height,comparisonRows:text.filter(x=>x.label.startsWith('comparison ')).length,lastBaseline:last.y,firstFooterBaseline:footer.y,cautionInkPixels:ink,png:canvas.toDataURL('image/png').split(',')[1]};
    }finally{CanvasRenderingContext2D.prototype.fillText=original;}
  });
  const {png,...receipt}=result;await writeFile(out+'/'+mode+'.png',Buffer.from(png,'base64'));await writeFile(out+'/'+mode+'.json',JSON.stringify(receipt,null,2));console.log(receipt);
  assert.equal(receipt.width,2480);assert.equal(receipt.height,3508);assert.equal(receipt.comparisonRows,8);
  if(mode==='previous'){assert(receipt.lastBaseline>receipt.height);assert.equal(receipt.cautionInkPixels,0);}
  else{assert(receipt.firstFooterBaseline-receipt.lastBaseline>40);assert(receipt.cautionInkPixels>40);}
}finally{await browser.close();await server.close();}

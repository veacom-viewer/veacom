/** Record compact retaining paths for large buffers in a synthetic tab's V8 snapshot. */
export async function closedBufferPaths(cdp) {
  const chunks = [];
  const add = ({ chunk }) => chunks.push(chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', add);
  try { await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }); }
  finally { cdp.off('HeapProfiler.addHeapSnapshotChunk', add); }
  const { snapshot, nodes, edges, strings } = JSON.parse(chunks.join(''));
  chunks.length = 0;
  const m = snapshot.meta, nf = m.node_fields, ef = m.edge_fields, N = nf.length, E = ef.length;
  const nt=nf.indexOf('type'), nn=nf.indexOf('name'), ni=nf.indexOf('id'), ns=nf.indexOf('self_size'), nc=nf.indexOf('edge_count');
  const et=ef.indexOf('type'), en=ef.indexOf('name_or_index'), dest=ef.indexOf('to_node');
  const ntypes=m.node_types[nt], etypes=m.edge_types[et], weak=etypes.indexOf('weak');
  const total=nodes.length/N, counts=new Uint32Array(total), start=new Uint32Array(total+1);
  const strong = e => {
    if (edges[e+et] === weak) return false;
    return etypes[edges[e+et]] !== 'internal' || !strings[edges[e+en]]?.includes('part of key');
  };
  for(let e=0;e<edges.length;e+=E) if(strong(e)) counts[edges[e+dest]/N]++;
  for(let n=0;n<total;n++) start[n+1]=start[n]+counts[n];
  const cursor=start.slice(), referrers=new Uint32Array(start[total]), links=new Uint32Array(start[total]), large=[];
  for(let n=0,e=0;n<total;n++) {
    if(nodes[n*N+ns]===3276800) large.push(n);
    const end=e+nodes[n*N+nc]*E;
    for(;e<end;e+=E) {
      if(!strong(e))continue;
      const slot=cursor[edges[e+dest]/N]++;
      referrers[slot]=n; links[slot]=e;
    }
  }
  const label=n=>({id:nodes[n*N+ni],type:ntypes[nodes[n*N+nt]],name:strings[nodes[n*N+nn]].slice(0,180),bytes:nodes[n*N+ns]});
  const edgeName=e=>{
    const t=etypes[edges[e+et]],v=edges[e+en];
    return t+' '+(t==='element'||t==='hidden'?v:strings[v]?.slice(0,180));
  };
  function shortest(target) {
    const next=new Int32Array(total);next.fill(-1);next[target]=target;
    const via=new Uint32Array(total),queue=new Uint32Array(total);queue[0]=target;
    for(let read=0,write=1;read<write&&next[0]===-1;read++) {
      const point=queue[read];
      for(let j=start[point];j<start[point+1];j++) {
        const from=referrers[j];
        if(next[from]!==-1)continue;
        next[from]=point;via[from]=links[j];queue[write++]=from;
      }
    }
    if(next[0]===-1)return [];
    const path=[];
    for(let n=0;n!==target;n=next[n])path.push({...label(n),out:edgeName(via[n])});
    path.push(label(target));
    return path;
  }
  function objectOwners(target) {
    const queue=[[target,0]], seen=new Set([target]), found=[];
    for(let at=0;at<queue.length&&found.length<24;at++) {
      const [child,depth]=queue[at];
      if(depth>=7)continue;
      for(let j=start[child];j<start[child+1];j++) {
        const from=referrers[j];if(seen.has(from))continue;seen.add(from);
        queue.push([from,depth+1]);const item=label(from);
        if(item.name==='Map'||(item.type==='object'&&item.name.startsWith('system / Context'))) {
          const path=shortest(from);if(path.length)found.push({owner:item,path});
        }
      }
    }
    return found;
  }
  function nearby(target) {
    const queue=[[target,0]],seen=new Set([target]),rows=[];
    for(let at=0;at<queue.length&&rows.length<160;at++) {
      const [child,depth]=queue[at];if(depth>=10)continue;
      const parents=[];
      for(let j=start[child];j<start[child+1]&&parents.length<10;j++){
        const from=referrers[j];
        parents.push({...label(from),out:edgeName(links[j])});
        if(!seen.has(from)){seen.add(from);queue.push([from,depth+1]);}
      }
      rows.push({child:label(child),parents});
    }
    return rows;
  }
  return {totalNodes:total,strongEdges:start[total],buffers:large.sort((a,b)=>nodes[b*N+ns]-nodes[a*N+ns]).slice(0,8)
    .map(n=>({node:label(n),path:shortest(n),nearby:nearby(n),owners:objectOwners(n)}))};
}

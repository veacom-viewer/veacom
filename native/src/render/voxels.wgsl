const tileEdge: u32 = 16u;
struct Layer {
    top:vec4<f32>, dx:vec4<f32>, dy:vec4<f32>, dims:vec4<f32>, first:vec4<f32>, size:vec4<f32>,
}
@group(0) @binding(6) var voxels:texture_3d<u32>;
@group(0) @binding(7) var<storage, read> paddingRanges:array<vec2<f32>>;
@group(0) @binding(1) var<storage, read> tiles:array<u32>;
@group(0) @binding(2) var<storage, read> pages:array<u32>;
@vertex fn vertex(@builtin(vertex_index) i:u32) -> @builtin(position) vec4<f32> {
    let pos=array<vec2<f32>,3>(vec2(-1,-1),vec2(3,-1),vec2(-1,3));
    return vec4(pos[i],0,1);
}
fn missing()->f32 {return bitcast<f32>(0x7fc00000u);}
fn finite(v:f32)->bool {return (bitcast<u32>(v)&0x7f800000u)!=0x7f800000u;}
fn outside(p:vec3<f32>,dims:vec3<f32>)->bool {return any(p<vec3(-0.5)) || any(p>dims-vec3(0.5));}
fn raw(layer:Layer,index:vec3<i32>)->u32 {
    let p=vec3<u32>(clamp(index,vec3(0),vec3<i32>(layer.dims.xyz)-vec3(1)));
    if layer.first.w > 0. {
        let word=textureLoad(voxels,vec3<i32>(p),0).r;
        if layer.first.w == 3. {return word;}
        var value=f32(word);
        if layer.first.w == 2. {value=f32(bitcast<i32>(word<<16u)>>16u);}
        let pad=paddingRanges[p.z];
        return select(bitcast<u32>(value),0x7fc00000u,value>=pad.x && value<=pad.y);
    }
    let key=vec3<i32>(vec3<u32>(p.x/tileEdge,p.y/tileEdge,p.z))-vec3<i32>(layer.first.xyz);
    let size=vec3<i32>(layer.size.xyz);
    if any(key<vec3(0)) || any(key>=size) {return 0x7fc00000u;}
    let id=pages[u32(layer.top.w)+u32((key.z*size.y+key.y)*size.x+key.x)];
    if id==0u {return 0x7fc00000u;}
    return tiles[(id-1u)*(tileEdge * tileEdge)+(p.y%tileEdge)*tileEdge+p.x%tileEdge];
}
fn linear(layer:Layer,p:vec3<f32>)->f32 {
    let nearest=bitcast<f32>(raw(layer,vec3<i32>(floor(p+0.5))));
    if !finite(nearest) {return nearest;}
    let base=vec3<i32>(floor(p)); let f=fract(p); var sum=0.; var weights=0.;
    for(var z=0;z<2;z++) {for(var y=0;y<2;y++){for(var x=0;x<2;x++){
        let d=vec3(x,y,z); let w=select(vec3(1.)-f,f,d==vec3(1));
        let weight=w.x*w.y*w.z; if weight<=0. {continue;}
        let v=bitcast<f32>(raw(layer,base+d)); if finite(v) {sum+=weight*v;weights+=weight;}
    }}}
    return select(nearest,sum/max(weights,1e-30),weights>0.);
}

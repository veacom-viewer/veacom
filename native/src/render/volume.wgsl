struct Scene {
    layer:Layer,
    inverseVP:mat4x4<f32>, toIndex:mat4x4<f32>, eye:vec4<f32>,
    cropMin:vec4<f32>, cropMax:vec4<f32>, leafMin:vec4<f32>, leafMax:vec4<f32>,
    display:vec4<f32>, step:vec4<f32>, rect:vec4<u32>,
}
@group(0) @binding(0) var<uniform> scene:Scene;
@group(0) @binding(8) var denseMask:texture_3d<u32>;
@group(0) @binding(3) var<storage,read> masks:array<u32>;
@group(0) @binding(4) var<storage,read> colors:array<u32>;
@group(0) @binding(5) var<storage,read_write> accum:array<vec4<f32>>;

fn regionAt(q:vec3<i32>)->u32 {
    if scene.step.w==0. || any(q<vec3(0)) || any(q>=vec3<i32>(scene.layer.dims.xyz)) {return 0u;}
    if scene.step.w==2. {return textureLoad(denseMask,q,0).r;}
    let p=vec3<u32>(q);
    let k=vec3<i32>(vec3<u32>(p.x/tileEdge,p.y/tileEdge,p.z))-vec3<i32>(scene.layer.first.xyz);
    let size=vec3<i32>(scene.layer.size.xyz);
    if any(k<vec3(0)) || any(k>=size) {return 0u;}
    let slot=pages[u32((k.z*size.y+k.y)*size.x+k.x)];
    if slot==0u {return 0u;}
    let n=(slot-1u)*(tileEdge * tileEdge)+(p.y%tileEdge)*tileEdge+p.x%tileEdge;
    return (masks[n/2u]>>((n%2u)*16u))&65535u;
}
fn sample3(p:vec3<f32>)->f32 {
    if regionAt(vec3<i32>(floor(p+0.5)))>>8u!=0u {return missing();}
    return linear(scene.layer,p);
}
fn box(origin:vec3<f32>,dir:vec3<f32>,lo:vec3<f32>,hi:vec3<f32>)->vec2<f32> {
    var entry=0.;var exit=1.e20;
    for(var a=0;a<3;a++){
        if abs(dir[a])<1.e-10 {
            if origin[a]<lo[a] || origin[a]>hi[a] {return vec2(1.,0.);}
        }else {
            let x=(lo[a]-origin[a])/dir[a]; let y=(hi[a]-origin[a])/dir[a];
            entry=max(entry,min(x,y)); exit=min(exit,max(x,y));
        }
    }
    return vec2(entry,exit);
}
fn shade(normal:vec3<f32>, direction:vec3<f32>,minLight:f32)->f32 {
    let g=transpose(mat3x3<f32>(scene.toIndex[0].xyz,scene.toIndex[1].xyz,scene.toIndex[2].xyz))*normal;
    if !finite(g.x) || !finite(g.y) || !finite(g.z) || length(g)<=0.0001 {return 1.;}
    return minLight+(1.-minLight)*abs(dot(normalize(g),direction));
}
fn occupied(q:vec3<i32>)->f32 {return select(0.,1.,(regionAt(q)&255u)>0u);}
@compute @workgroup_size(8,8) fn march(@builtin(global_invocation_id) id:vec3<u32>) {
    if id.x>=scene.rect.z || id.y>=scene.rect.w{return;}
    let n=id.y*scene.rect.z+id.x;
    var color=accum[n]; if color.a>0.985{return;}
    let screen=(vec2<f32>(id.xy+scene.rect.xy)+0.5)/scene.display.xy;
    let far=scene.inverseVP*vec4(screen.x*2.-1.,1.-screen.y*2.,1.,1.);
    let direction=normalize(far.xyz/far.w-scene.eye.xyz);
    let origin=(scene.toIndex*vec4(scene.eye.xyz,1.)).xyz;
    let dir=(scene.toIndex*vec4(direction,0.)).xyz;
    let full=box(origin,dir,scene.cropMin.xyz,scene.cropMax.xyz);
    let leaf=box(origin,dir,scene.leafMin.xyz,scene.leafMax.xyz);
    let entry=max(full.x,leaf.x);let exit=min(full.y,leaf.y);if entry>exit{return;}
    let inc=max(min(scene.step.x,scene.step.y/max(max(abs(dir.x),abs(dir.y)),abs(dir.z))),(full.y-full.x)/2047.);
    let first=max(0,i32(floor((entry-full.x)/inc-0.5)));
    for(var i=first;i<2048;i++) {
        let at=full.x+(f32(i)+0.5)*inc;
        if at>exit || color.a>0.985 {break;}
        if at<entry {continue;}
        let p=origin+dir*at;
        // The nearest voxel selects exactly one half-open leaf, including samples on split planes.
        let q=vec3<i32>(floor(p+0.5));
        if any(q<vec3<i32>(floor(scene.leafMin.xyz+0.5))) || any(q>vec3<i32>(floor(scene.leafMax.xyz))) {continue;}
        let label=regionAt(q)&255u;
        if label!=0u {
            let c=colors[label];let rgb=vec3<f32>(vec3((c>>16u)&255u,(c>>8u)&255u,c&255u))/255.;
            let g=vec3(occupied(q-vec3(1,0,0))-occupied(q+vec3(1,0,0)),occupied(q-vec3(0,1,0))-occupied(q+vec3(0,1,0)),occupied(q-vec3(0,0,1))-occupied(q+vec3(0,0,1)));
            color=vec4(color.rgb+(1.-color.a)*rgb*shade(g,direction,0.35),1.);break;
        }
        let value=sample3(p);if !finite(value){continue;}
        let density=smoothstep(scene.display.z-10.,scene.display.z+scene.display.w,value);
        if density<=0.001 {continue;}
        let alpha=1.-exp(-density*inc*0.8);
        let g=vec3(sample3(p+vec3(1.,0.,0.))-sample3(p-vec3(1.,0.,0.)),sample3(p+vec3(0.,1.,0.))-sample3(p-vec3(0.,1.,0.)),sample3(p+vec3(0.,0.,1.))-sample3(p-vec3(0.,0.,1.)));
        let level=clamp((value-scene.display.z)/max(3.*scene.display.w,1.),0.,1.);
        let rgb=mix(vec3(0.66,0.50,0.35),vec3(0.98,0.95,0.85),level)*shade(g,direction,0.23);
        color+=vec4(rgb*alpha,alpha)*(1.-color.a);
    }
    accum[n]=color;
}

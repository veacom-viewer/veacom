struct View {
    base:Layer, overlay:Layer, window:vec4<f32>, slab:vec4<f32>, sampling:vec4<f32>, fusion:vec4<f32>, color:vec4<f32>,
}
@group(0) @binding(0) var<uniform> view:View;
@group(0) @binding(3) var<storage, read> lut:array<u32>;
fn palette(t:f32,kind:i32)->vec3<f32> {
    if kind<0 {return vec3(t);}
    if kind==3 {return clamp(vec3(2.*t,(t-0.25)*4./3.,(t-0.75)*4.),vec3(0.),vec3(1.));}
    if kind==4 {
        if t<0.3 {return mix(vec3(0.5,0.,0.),vec3(0.95,0.05,0.),t/0.3);}
        if t<0.65 {return mix(vec3(0.95,0.05,0.),vec3(1.,0.55,0.),(t-0.3)/0.35);}
        return mix(vec3(1.,0.55,0.),vec3(1.,0.92,0.1),(t-0.65)/0.35);
    }
    if kind==2 {return clamp(vec3(1.5)-abs(4.*t-vec3(3.,2.,1.)),vec3(0.),vec3(1.));}
    if kind==1 {return clamp(vec3(t*3.,t*3.-1.,t*3.-2.),vec3(0.),vec3(1.));}
    return clamp(vec3(t*3.,t*2.8-0.8,t*3.2-2.2),vec3(0.),vec3(1.));
}
fn sampled(p:vec3<f32>)->f32 {
    if view.base.dims.w>0. {return bitcast<f32>(raw(view.base,vec3<i32>(floor(p+0.5))));}
    let center=linear(view.base,p);
    if view.slab.w==0. {return center;}
    var found=finite(center);var best=center;var sum=select(0.,center,found);var count=select(0.,1.,found);
    for(var k=1;k<=i32(view.sampling.x);k++) {for(var sign=-1;sign<=1;sign+=2) {
        let q=p+view.slab.xyz*f32(k*sign);
        if outside(q,view.base.dims.xyz){continue;}
        let v=linear(view.base,q); if !finite(v) {continue;}
        if !found {best=v;found=true;} else if view.slab.w==1. {best=max(best,v);} else if view.slab.w==2. {best=min(best,v);}
        sum+=v;count+=1.;
    }}
    return select(best,select(center,sum/max(count,1.),count>0.),view.slab.w==3.);
}
@fragment fn fragment(@builtin(position) pixel:vec4<f32>) -> @location(0) vec4<f32> {
    let p=view.base.top.xyz+view.base.dx.xyz*pixel.x+view.base.dy.xyz*pixel.y;
    if outside(p,view.base.dims.xyz) {return vec4(0.,0.,0.,1.);}
    if view.base.dims.w==2. {
        let code=raw(view.base,vec3<i32>(floor(p+0.5)));
        return vec4(vec3<f32>(vec3((code>>16u)&255u,(code>>8u)&255u,code&255u))/255.,1.);
    }
    let value=sampled(p); if !finite(value) {return vec4(0.,0.,0.,1.);}
    let c=view.window.x;let w=max(1.,view.window.y);
    var grey:f32;
    if view.fusion.x>0. {let i=u32(clamp(floor(value+0.5)-view.sampling.z,0.,view.fusion.x-1.));grey=f32(lut[i])/view.sampling.w;}
    else if view.sampling.y==2. {grey=1./(1.+exp(-4.*(value-c)/w));}
    else if view.sampling.y==1. {grey=clamp((value-c)/w+0.5,0.,1.);}
    else if w<=1. {grey=step(c-0.5,value);}
    else {grey=clamp((value-(c-0.5))/(w-1.)+0.5,0.,1.);}
    if view.color.z==1. {grey=sqrt(grey);}
    else if view.color.z==2. {grey=log(1.+view.color.w*grey)/log(1.+view.color.w);}
    if view.window.z!=0. {grey=1.-grey;}
    var rgb=palette(grey,i32(view.window.w));
    if view.overlay.dims.x>0. {
        let q=view.overlay.top.xyz+pixel.x*view.overlay.dx.xyz+pixel.y*view.overlay.dy.xyz;
        if !outside(q,view.overlay.dims.xyz) {
            let s=linear(view.overlay,q);
            if finite(s) {
                let t=clamp(max(0.,s*view.fusion.y)/max(0.001,view.fusion.w),0.,1.);
                rgb=mix(rgb,palette(t,i32(view.color.x)),view.fusion.z*select(smoothstep(0.,0.08,t),1.,view.color.y!=0.));
            }
        }
    }
    return vec4(rgb,1.);
}

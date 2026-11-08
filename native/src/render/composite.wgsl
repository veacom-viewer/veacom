@group(0) @binding(0) var<uniform> rect:vec4<u32>;
@group(0) @binding(1) var<storage,read> accum:array<vec4<f32>>;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{
    let p=array<vec2<f32>,3>(vec2(-1,-1),vec2(3,-1),vec2(-1,3));
    return vec4(p[i],0,1);
}
@fragment fn fragment(@builtin(position) p:vec4<f32>)->@location(0) vec4<f32>{
    let pos=vec2<u32>(p.xy)-rect.xy; let c=accum[pos.y*rect.z+pos.x];
    return vec4(c.rgb+(1.-c.a)*vec3(0.025,0.035,0.045),1.);
}

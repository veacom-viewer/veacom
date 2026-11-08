@group(0) @binding(0) var<uniform> frame: vec4<u32>;
@vertex fn vertex(@builtin(vertex_index) i:u32) -> @builtin(position) vec4<f32> {
    let p=array<vec2<f32>,3>(vec2(-1,-1),vec2(3,-1),vec2(-1,3));
    return vec4(p[i],0,1);
}
@fragment fn fragment(@builtin(position) pixel:vec4<f32>) -> @location(0) vec4<f32> {
    let x=u32(pixel.x); let y=u32(pixel.y);
    if y < 16u && x < 256u {
        let bit=(frame.x >> (x/16u)) & 1u;
        return vec4<f32>(vec3<f32>(f32(bit)),1.);
    }
    if ((x/16u+y/16u)&1u)==0u { return vec4<f32>(1,0,0,1); }
    return vec4<f32>(0,1,0,1);
}

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <IOSurface/IOSurface.h>
#include <mach/mach.h>
#include <servers/bootstrap.h>

typedef struct {
    mach_msg_header_t header;
    mach_msg_body_t body;
    mach_msg_port_descriptor_t surface;
    uint32_t lease;
} SurfaceMessage;

void *create_target(void *rawDevice, uint32_t width, uint32_t height, IOSurfaceRef *surface) {
    @autoreleasepool {
        *surface = IOSurfaceCreate((__bridge CFDictionaryRef)@{
            (id)kIOSurfaceWidth:@(width), (id)kIOSurfaceHeight:@(height),
            (id)kIOSurfaceBytesPerElement:@4, (id)kIOSurfacePixelFormat:@(0x42475241)
        });
        if (!*surface) return NULL;
        MTLTextureDescriptor *desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:width height:height mipmapped:NO];
        desc.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
        desc.storageMode = MTLStorageModeShared;
        id<MTLTexture> texture = [(__bridge id<MTLDevice>)rawDevice newTextureWithDescriptor:desc iosurface:*surface plane:0];
        if (!texture) { CFRelease(*surface); *surface = NULL; }
        return (__bridge_retained void *)texture;
    }
}
void release_target(IOSurfaceRef surface) { CFRelease(surface); }
int send_target(IOSurfaceRef surface, const char *name, uint32_t lease) {
    mach_port_t task=mach_task_self(), bootstrap, receiver;
    if (task_get_bootstrap_port(task,&bootstrap)!=KERN_SUCCESS || bootstrap_look_up(bootstrap,(char *)name,&receiver)!=KERN_SUCCESS) return -1;
    mach_port_t right=IOSurfaceCreateMachPort(surface);
    if (!MACH_PORT_VALID(right)) { mach_port_deallocate(task,receiver); return -1; }
    SurfaceMessage m={0};
    m.header.msgh_bits=MACH_MSGH_BITS_COMPLEX | MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND,0);
    m.header.msgh_size=sizeof(m); m.header.msgh_remote_port=receiver;
    m.body.msgh_descriptor_count=1; m.surface.name=right; m.surface.disposition=MACH_MSG_TYPE_COPY_SEND;
    m.surface.type=MACH_MSG_PORT_DESCRIPTOR; m.lease=lease;
    int status=mach_msg(&m.header,MACH_SEND_MSG | MACH_SEND_TIMEOUT,sizeof(m),0,MACH_PORT_NULL,100,MACH_PORT_NULL);
    mach_port_deallocate(task,right); mach_port_deallocate(task,receiver); return status;
}

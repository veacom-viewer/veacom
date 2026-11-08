#include <mach/mach.h>
#include <mach/message.h>
#include <servers/bootstrap.h>
#include <IOSurface/IOSurface.h>
#include <stdint.h>
#include <string.h>

typedef struct {
    mach_msg_header_t header;
    mach_msg_body_t body;
    mach_msg_port_descriptor_t surface;
    uint32_t lease;
} SurfaceMessage;

mach_port_t start_receiver(const char *name) {
    mach_port_t task = mach_task_self(), port = MACH_PORT_NULL, bootstrap = MACH_PORT_NULL;
    if (task_get_bootstrap_port(task, &bootstrap) != KERN_SUCCESS ||
        mach_port_allocate(task, MACH_PORT_RIGHT_RECEIVE, &port) != KERN_SUCCESS) return MACH_PORT_NULL;
    if (mach_port_insert_right(task, port, port, MACH_MSG_TYPE_MAKE_SEND) != KERN_SUCCESS ||
        bootstrap_register(bootstrap, (char *)name, port) != KERN_SUCCESS) {
        mach_port_destroy(task, port); return MACH_PORT_NULL;
    }
    return port;
}
void stop_receiver(mach_port_t port) { mach_port_destroy(mach_task_self(), port); }

IOSurfaceRef receive_surface(mach_port_t port, uint32_t pid, uint32_t lease) {
    struct { SurfaceMessage msg; mach_msg_audit_trailer_t trailer; } data;
    for (;;) {
        memset(&data, 0, sizeof(data));
        kern_return_t kr = mach_msg(&data.msg.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT |
            MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) | MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
            0, sizeof(data), port, 0, MACH_PORT_NULL);
        if (kr != KERN_SUCCESS) return NULL;
        if (!(data.msg.header.msgh_bits & MACH_MSGH_BITS_COMPLEX) || data.msg.header.msgh_size != sizeof(SurfaceMessage) ||
            data.msg.body.msgh_descriptor_count != 1 || data.msg.surface.type != MACH_MSG_PORT_DESCRIPTOR ||
            data.trailer.msgh_trailer_size < sizeof(mach_msg_audit_trailer_t) ||
            data.trailer.msgh_audit.val[5] != pid || data.msg.lease != lease) {
            mach_msg_destroy(&data.msg.header); continue;
        }
        IOSurfaceRef surface = IOSurfaceLookupFromMachPort(data.msg.surface.name);
        mach_msg_destroy(&data.msg.header);
        return surface;
    }
}
void release_surface(IOSurfaceRef surface) { CFRelease(surface); }

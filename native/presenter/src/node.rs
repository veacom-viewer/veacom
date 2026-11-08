//! The only interface to Electron main is open(name), receive(receiver, pid, lease, hex), and release(surface).
use super::{Receiver, Result, Surface};
use napi_sys as js;
use std::{
    ffi::{CString, c_void},
    ptr::{self, null_mut},
    sync::Once,
};

type Value = js::napi_value;
type Env = js::napi_env;
type Info = js::napi_callback_info;
enum Owner {
    Receiver(Receiver),
    Surface(Surface),
}
// Only objects wrapped by this addon may be cast back to Owner.
const TAG: js::napi_type_tag = js::napi_type_tag {
    lower: 0xe530ea3c067b4c92,
    upper: 0xa45a2ea40ced68e4,
};

fn status(code: js::napi_status) -> Result<()> {
    if code == js::Status::napi_ok {
        Ok(())
    } else {
        Err(c"Invalid texture bridge call")
    }
}

unsafe extern "C" fn finalize(_: Env, data: *mut c_void, _: *mut c_void) {
    // napi_wrap transfers one Box to this finalizer.
    unsafe {
        drop(Box::from_raw(data.cast::<Owner>()));
    }
}

fn wrap(env: Env, object: Value, owner: Owner) -> Result<Value> {
    unsafe {
        status(js::napi_type_tag_object(env, object, &TAG))?;
        let raw = Box::into_raw(Box::new(owner)).cast();
        if let Err(error) = status(js::napi_wrap(
            env,
            object,
            raw,
            Some(finalize),
            null_mut(),
            null_mut(),
        )) {
            finalize(env, raw, null_mut());
            return Err(error);
        }
    }
    Ok(object)
}

fn with_owner<T>(env: Env, object: Value, work: impl FnOnce(&Owner) -> Result<T>) -> Result<T> {
    let mut matches = false;
    let mut raw = null_mut();
    unsafe {
        status(js::napi_check_object_type_tag(
            env,
            object,
            &TAG,
            &mut matches,
        ))?;
        if !matches {
            return Err(c"Unknown texture object");
        }
        status(js::napi_unwrap(env, object, &mut raw))?;
        let owner = raw
            .cast::<Owner>()
            .as_ref()
            .ok_or(c"Texture object was released")?;
        // The JS argument holds the wrapper alive for the duration of this callback.
        work(owner)
    }
}

fn args<const N: usize>(env: Env, info: Info) -> Result<[Value; N]> {
    let mut count = N;
    let mut values = [null_mut(); N];
    unsafe {
        status(js::napi_get_cb_info(
            env,
            info,
            &mut count,
            values.as_mut_ptr(),
            null_mut(),
            null_mut(),
        ))?;
    }
    if count != N {
        return Err(c"Missing texture bridge argument");
    }
    Ok(values)
}

fn string(env: Env, value: Value) -> Result<CString> {
    let mut len = 0;
    let mut bytes = [0u8; 256];
    unsafe {
        status(js::napi_get_value_string_utf8(
            env,
            value,
            null_mut(),
            0,
            &mut len,
        ))?;
        if len >= bytes.len() {
            return Err(c"Texture name is too long");
        }
        status(js::napi_get_value_string_utf8(
            env,
            value,
            bytes.as_mut_ptr().cast(),
            bytes.len(),
            &mut len,
        ))?;
    }
    CString::new(&bytes[..len]).map_err(|_| c"Invalid texture name")
}

fn uint(env: Env, value: Value) -> Result<u32> {
    let mut number = 0;
    unsafe {
        status(js::napi_get_value_uint32(env, value, &mut number))?;
    }
    Ok(number)
}

fn reply(env: Env, result: Result<Value>) -> Value {
    result.unwrap_or_else(|message| {
        unsafe {
            js::napi_throw_error(env, ptr::null(), message.as_ptr());
        }
        null_mut()
    })
}

unsafe extern "C" fn open(env: Env, info: Info) -> Value {
    reply(
        env,
        (|| {
            let [name] = args(env, info)?;
            let receiver = Receiver::new(&string(env, name)?)?;
            let mut object = null_mut();
            unsafe {
                status(js::napi_create_object(env, &mut object))?;
            }
            wrap(env, object, Owner::Receiver(receiver))
        })(),
    )
}

unsafe extern "C" fn receive(env: Env, info: Info) -> Value {
    reply(
        env,
        (|| {
            let [object, pid, lease, handle] = args(env, info)?;
            let (pid, lease, handle) = (uint(env, pid)?, uint(env, lease)?, string(env, handle)?);
            let surface = with_owner(env, object, |owner| match owner {
                Owner::Receiver(r) => r.receive(pid, lease, &handle),
                _ => Err(c"Expected a texture receiver"),
            })?;
            let bytes = surface.bytes();
            let mut buffer = null_mut();
            unsafe {
                status(js::napi_create_buffer_copy(
                    env,
                    bytes.len(),
                    bytes.as_ptr().cast(),
                    null_mut(),
                    &mut buffer,
                ))?;
            }
            wrap(env, buffer, Owner::Surface(surface))
        })(),
    )
}

unsafe extern "C" fn release(env: Env, info: Info) -> Value {
    reply(
        env,
        (|| {
            let [object] = args(env, info)?;
            with_owner(env, object, |owner| match owner {
                Owner::Surface(surface) => {
                    surface.release();
                    Ok(())
                }
                _ => Err(c"Expected a texture surface"),
            })?;
            let mut undefined = null_mut();
            unsafe {
                status(js::napi_get_undefined(env, &mut undefined))?;
            }
            Ok(undefined)
        })(),
    )
}

static LOAD: Once = Once::new();

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_register_module_v1(env: Env, exports: Value) -> Value {
    // Keep dynamically loaded Node symbols valid for the lifetime of every Electron environment.
    if std::panic::catch_unwind(|| LOAD.call_once(|| std::mem::forget(unsafe { js::setup() })))
        .is_err()
    {
        return null_mut();
    }
    reply(
        env,
        (|| {
            for (name, method) in [
                (c"open", open as unsafe extern "C" fn(Env, Info) -> Value),
                (c"receive", receive),
                (c"release", release),
            ] {
                let mut function = null_mut();
                unsafe {
                    status(js::napi_create_function(
                        env,
                        name.as_ptr(),
                        name.to_bytes().len() as isize,
                        Some(method),
                        null_mut(),
                        &mut function,
                    ))?;
                    status(js::napi_set_named_property(
                        env,
                        exports,
                        name.as_ptr(),
                        function,
                    ))?;
                }
            }
            Ok(exports)
        })(),
    )
}

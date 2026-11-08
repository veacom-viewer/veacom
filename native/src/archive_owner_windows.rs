use std::{fs::File, io, mem::size_of, os::windows::io::AsRawHandle, ptr::null_mut};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, GetLastError, HANDLE, LocalFree,
    },
    Security::{
        Authorization::{GetSecurityInfo, SE_FILE_OBJECT, SetSecurityInfo},
        EqualSid, GetLengthSid, GetTokenInformation, IsValidSid, OWNER_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, PSID, TOKEN_QUERY, TOKEN_USER, TokenUser,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

const MAX_TOKEN_BYTES: usize = 64 * 1024;

struct Token(HANDLE);
impl Drop for Token {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

struct SecurityDescriptor(PSECURITY_DESCRIPTOR);
impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

struct UserSid {
    storage: Vec<usize>,
    offset: usize,
}
impl UserSid {
    fn as_ptr(&self) -> PSID {
        unsafe {
            self.storage
                .as_ptr()
                .cast::<u8>()
                .add(self.offset)
                .cast_mut()
                .cast()
        }
    }
}

fn current_user_sid() -> io::Result<UserSid> {
    let mut handle = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut handle) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = Token(handle);
    if token.0.is_null() {
        return Err(io::Error::other("Windows returned an empty process token"));
    }

    let mut required = 0u32;
    if unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut required) } != 0 {
        return Err(io::Error::other(
            "Windows returned an invalid token size response",
        ));
    }
    let error = unsafe { GetLastError() };
    if error != ERROR_INSUFFICIENT_BUFFER {
        return Err(io::Error::from_raw_os_error(error as i32));
    }
    if (required as usize) < size_of::<TOKEN_USER>() || required as usize > MAX_TOKEN_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Process token exceeds the bounded buffer",
        ));
    }
    // usize storage keeps TOKEN_USER pointer fields correctly aligned on both Windows architectures.
    let words = (required as usize).div_ceil(size_of::<usize>());
    let mut storage = Vec::<usize>::new();
    storage
        .try_reserve_exact(words)
        .map_err(|error| io::Error::other(error.to_string()))?;
    storage.resize(words, 0);
    let capacity = storage.len() * size_of::<usize>();
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            storage.as_mut_ptr().cast(),
            capacity as u32,
            &mut required,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if (required as usize) < size_of::<TOKEN_USER>() || required as usize > capacity {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows returned an invalid token length",
        ));
    }

    let user = unsafe { &*storage.as_ptr().cast::<TOKEN_USER>() };
    let sid = user.User.Sid;
    let begin = storage.as_ptr() as usize;
    let end = begin + required as usize;
    let address = sid as usize;
    // The returned SID must remain within the token buffer while it is compared.
    if address < begin || address.checked_add(8).is_none_or(|n| n > end) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "User SID is outside its token buffer",
        ));
    }
    let sid_bytes = 8 + 4 * usize::from(unsafe { sid.cast::<u8>().add(1).read() });
    if address.checked_add(sid_bytes).is_none_or(|n| n > end) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "User SID exceeds its token buffer",
        ));
    }
    if unsafe { IsValidSid(sid) } == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows returned an invalid user SID",
        ));
    }
    let length = unsafe { GetLengthSid(sid) } as usize;
    if length < 8 || address.checked_add(length).is_none_or(|n| n > end) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "User SID length exceeds its token buffer",
        ));
    }
    Ok(UserSid {
        storage,
        offset: address - begin,
    })
}

pub fn is_current_user(file: &File) -> bool {
    let mut descriptor = SecurityDescriptor(null_mut());
    let mut owner = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor.0,
        )
    };
    if status != ERROR_SUCCESS
        || descriptor.0.is_null()
        || owner.is_null()
        || unsafe { IsValidSid(owner) } == 0
    {
        return false;
    }
    let Ok(user) = current_user_sid() else {
        return false;
    };
    unsafe { EqualSid(owner, user.as_ptr()) != 0 }
}

pub fn assign_current_user(file: &File) -> io::Result<()> {
    let user = current_user_sid()?;
    let status = unsafe {
        SetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            user.as_ptr(),
            null_mut(),
            null_mut(),
            null_mut(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    if !is_current_user(file) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Archive owner verification failed",
        ));
    }
    Ok(())
}
